// Shared PDF text-layout reconstruction.
//
// pdfjs' getTextContent() returns positioned glyph runs, not readable text: a
// run is emitted at every kerning adjustment and font switch, and the items
// arrive in content-stream order rather than reading order. Concatenating them
// naively loses every line break, splits words at kerning boundaries, repeats
// the running header on every page, and interleaves columns.
//
// This module rebuilds actual lines from item geometry, orders them for reading,
// and identifies repeated page chrome. It was factored out of the Library
// extraction engine so the analysis pipeline (textExtractor), the Toolkit
// converters and the renderer's PDF search share one implementation instead of
// each hand-rolling their own.
//
// It lives in shared/ and has no imports on purpose: `pageLayout` only needs a
// pdfjs page object, which exists identically in the main process and in the
// renderer, so both sides read a PDF the same way.

export interface PositionedItem {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
  baseline: number;
}

export interface LayoutLine {
  text: string;
  page: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
  items: PositionedItem[];
  paragraphBreakBefore?: boolean;
}

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  lines: LayoutLine[];
  ocr?: boolean;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function cleanInlineText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\u00ad/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/[-‐‑‒–—]{2,}/g, '-')
    .replace(/\b(fi|fl)\s+(?=\p{Ll}{2,})/gu, '$1')
    .replace(/(\p{L}+)\s+([áéíóúü])\s+(\p{L}+)/giu, (_whole, left: string, vowel: string, right: string) => `${left}${vowel}${right.length > 1 ? right : ` ${right}`}`)
    .replace(/(\p{L}{2,}[áéíóúü])\s+([bcdfghjklmnñpqrstvwxyz])(?=\s|[,.;:!?)]|$)/giu, '$1$2')
    .replace(/\s+([,.;:!?%)\]}»”])/g, '$1')
    .replace(/([¿¡([{«“])\s+/g, '$1')
    .trim();
}

/** Join two lines of the same paragraph, repairing a word split by a line-break hyphen. */
export function dehyphenatingJoin(left: string, right: string): string {
  const first = left.trimEnd();
  const second = right.trimStart();
  if (!first) return second;
  if (!second) return first;
  if (/\d-$/u.test(first) && /^\d/u.test(second)) return cleanInlineText(`${first}${second}`);
  if (/\p{L}{2,}-$/u.test(first) && /^\p{Ll}/u.test(second)) return cleanInlineText(`${first.slice(0, -1)}${second}`);
  return cleanInlineText(`${first} ${second}`);
}

/**
 * Concatenate the items of one line. A space is inserted only where the
 * horizontal gap justifies it, so a word broken into several runs by kerning
 * ("T" + "he" + "ory") is rejoined rather than spaced apart. Superscript
 * numerals become footnote references.
 */
export function joinLineItems(items: PositionedItem[]): string {
  const ordered = [...items].sort((a, b) => a.x0 - b.x0);
  const bodySize = median(ordered.map((item) => item.size));
  const bodyBaseline = median(ordered.filter((item) => item.size >= bodySize * 0.85).map((item) => item.baseline));
  let text = '';
  let previous: PositionedItem | null = null;
  for (const item of ordered) {
    if (!item.text.trim()) continue;
    const gap = previous ? item.x0 - previous.x1 : 0;
    const average = previous ? Math.max(2, (previous.x1 - previous.x0) / Math.max(1, previous.text.length)) : 4;
    const superscriptReference = /^\d{1,3}$/.test(item.text.trim())
      && ordered.length > 1
      && item.size <= bodySize * 0.72
      && item.baseline <= bodyBaseline - bodySize * 0.12;
    const normalizedItem = item.text.normalize('NFC');
    const isolatedGlyph = [...normalizedItem.trim()].length === 1 && /\p{L}/u.test(normalizedItem.trim());
    const explicitWhitespace = !!previous && (/\s$/.test(previous.text) || /^\s/.test(item.text));
    const token = superscriptReference ? `[^${item.text.trim()}]` : normalizedItem;
    const separator = previous && !superscriptReference && (explicitWhitespace || (gap > average * 0.35 && !isolatedGlyph)) ? ' ' : '';
    text += `${separator}${token}`;
    previous = item;
  }
  return cleanInlineText(text);
}

/**
 * Find the vertical whitespace gutters of a multi-column page.
 *
 * Items are grouped into lines by vertical position, which on a two-column page
 * welds a left-column line to the right-column line beside it. Splitting at the
 * gutter keeps them apart so reading order can follow the columns.
 *
 * A band only counts as a gutter when no item crosses it *and* most body lines
 * have content on both sides — a table sitting inside otherwise full-width prose
 * fails the second test, so its rows stay whole for table detection.
 */
function detectGutters(groups: PositionedItem[][], pageWidth: number, pageHeight: number): Array<{ x0: number; x1: number }> {
  const sizes = groups.map((items) => median(items.map((item) => item.size)));
  const bodySize = median(sizes) || 10;
  const bodyGroups = groups.filter((items) => {
    const size = median(items.map((item) => item.size));
    if (size < bodySize * 0.75 || size > bodySize * 1.35) return false;
    // Running chrome sits in the top/bottom bands and says nothing about the
    // column grid — a centred page number would otherwise sit in the gutter.
    const top = Math.min(...items.map((item) => item.top));
    const bottom = Math.max(...items.map((item) => item.bottom));
    return !isEdgeLine({ top, bottom }, pageHeight);
  });
  if (bodyGroups.length < 6) return [];

  // 1pt occupancy scan across the middle of the page, where gutters live.
  // A single item wider than half the page is a spanning heading, not column
  // body text; letting it paint the map would hide every gutter beneath it.
  const maxColumnItemWidth = pageWidth * 0.55;
  const from = Math.floor(pageWidth * 0.2);
  const to = Math.ceil(pageWidth * 0.8);
  const covered = new Uint8Array(Math.max(0, to - from) + 1);
  for (const items of bodyGroups) {
    for (const item of items) {
      if (item.x1 - item.x0 > maxColumnItemWidth) continue;
      const start = Math.max(from, Math.floor(item.x0));
      const end = Math.min(to, Math.ceil(item.x1));
      for (let x = start; x <= end; x += 1) covered[x - from] = 1;
    }
  }

  const minWidth = Math.max(8, bodySize * 0.8);
  const extents = bodyGroups.map((items) => ({
    x0: Math.min(...items.map((item) => item.x0)),
    x1: Math.max(...items.map((item) => item.x1)),
  }));

  const gutters: Array<{ x0: number; x1: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= covered.length; i += 1) {
    const free = i < covered.length && covered[i] === 0;
    if (free && runStart < 0) runStart = i;
    if (!free && runStart >= 0) {
      const x0 = runStart + from;
      const x1 = i - 1 + from;
      if (x1 - x0 >= minWidth) {
        // A real column gutter has substantial text wholly on each side of it.
        // Lines that cross the band (a full-width heading, a table row) belong
        // to neither side, so a lone table cannot fake a column grid.
        const leftOnly = extents.filter((e) => e.x1 <= x0).length;
        const rightOnly = extents.filter((e) => e.x0 >= x1).length;
        const floor = bodyGroups.length * 0.2;
        if (leftOnly >= floor && rightOnly >= floor) gutters.push({ x0, x1 });
      }
      runStart = -1;
    }
  }
  return gutters;
}

/** Split groups that straddle a gutter into one group per column. */
function splitAtGutters(groups: PositionedItem[][], gutters: Array<{ x0: number; x1: number }>): PositionedItem[][] {
  if (!gutters.length) return groups;
  const bounds = [-Infinity, ...gutters.map((g) => (g.x0 + g.x1) / 2), Infinity];
  const output: PositionedItem[][] = [];
  for (const items of groups) {
    const buckets: PositionedItem[][] = bounds.slice(1).map(() => []);
    for (const item of items) {
      const centre = (item.x0 + item.x1) / 2;
      let column = 0;
      while (column < bounds.length - 2 && centre >= bounds[column + 1]) column += 1;
      buckets[column].push(item);
    }
    for (const bucket of buckets) if (bucket.length) output.push(bucket);
  }
  return output;
}

/** Build the positioned-line layout of a single pdfjs page. */
export async function pageLayout(page: any, number: number): Promise<PageLayout> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: true });
  const positioned: PositionedItem[] = [];
  for (const raw of content.items ?? []) {
    if (typeof raw?.str !== 'string' || !raw.str.trim() || !Array.isArray(raw.transform)) continue;
    const x0 = Number(raw.transform[4]) || 0;
    const baseline = Number(raw.transform[5]) || 0;
    const size = Math.max(1, Math.abs(Number(raw.transform[3]) || Number(raw.height) || 10));
    const normalizedLength = Math.max(1, [...raw.str.normalize('NFC')].length);
    const width = Math.max(0, Number(raw.width) || normalizedLength * size * 0.45);
    positioned.push({
      text: raw.str, x0, x1: x0 + width,
      top: viewport.height - baseline - size,
      bottom: viewport.height - baseline + size * 0.25,
      size, baseline: viewport.height - baseline,
    });
  }
  positioned.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const groups: PositionedItem[][] = [];
  for (const item of positioned) {
    let group: PositionedItem[] | undefined;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const candidate = groups[index];
      const sameTop = Math.abs(median(candidate.map((entry) => entry.top)) - item.top) <= Math.max(2.5, item.size * 0.28);
      const sameBaseline = Math.abs(median(candidate.map((entry) => entry.baseline)) - item.baseline) <= Math.max(2, item.size * 0.22);
      if (sameTop || sameBaseline) { group = candidate; break; }
    }
    if (group) group.push(item); else groups.push([item]);
  }
  const columned = splitAtGutters(groups, detectGutters(groups, viewport.width, viewport.height));
  const lines = columned.map((items) => ({
    text: joinLineItems(items), page: number,
    x0: Math.min(...items.map((entry) => entry.x0)), x1: Math.max(...items.map((entry) => entry.x1)),
    top: Math.min(...items.map((entry) => entry.top)), bottom: Math.max(...items.map((entry) => entry.bottom)),
    size: median(items.map((entry) => entry.size)), items: [...items].sort((a, b) => a.x0 - b.x0),
  })).filter((line) => line.text);
  return { page: number, width: viewport.width, height: viewport.height, lines };
}

/** Normalized identity of a line for repeated-chrome comparison (page numbers masked). */
export function chromeKey(text: string): string {
  return cleanInlineText(text).toLocaleLowerCase().replace(/\d+/g, '#');
}

/** True when the line sits in the top or bottom band where running chrome lives. */
export function isEdgeLine(line: { top: number; bottom: number }, pageHeight: number): boolean {
  return line.top < pageHeight * 0.13 || line.bottom > pageHeight * 0.88;
}

/** Lines eligible to be running chrome: those in the top/bottom margin bands. */
export function chromeCandidates(layout: PageLayout): LayoutLine[] {
  return layout.lines.filter((line) => isEdgeLine(line, layout.height));
}

/**
 * Identify running headers/footers: margin-band lines whose text (with digits
 * masked, so "page 7" and "page 8" collapse) recurs across a third of the pages
 * *at the same height on each of them*.
 *
 * Recurrence alone is not enough. On a densely set page the first line of body
 * text also falls inside the top band, so a sentence or heading that happens to
 * repeat would be mistaken for a header and silently deleted from the prose.
 * Real chrome is pinned to its margin and lands at the same y on every page;
 * repeated body text drifts with the surrounding copy.
 */
export function repeatedChrome(pages: PageLayout[]): Set<string> {
  const seen = new Map<string, { pages: Set<number>; tops: number[] }>();
  for (const page of pages) {
    for (const line of chromeCandidates(page)) {
      const key = chromeKey(line.text);
      if (key.length < 3 || key.length > 180) continue;
      const entry = seen.get(key) ?? { pages: new Set<number>(), tops: [] };
      entry.pages.add(page.page);
      entry.tops.push(line.top);
      seen.set(key, entry);
    }
  }

  const bodySize = median(pages.flatMap((page) => page.lines.map((line) => line.size))) || 10;
  const tolerance = Math.max(4, bodySize * 1.5);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.32));
  const chrome = new Set<string>();
  for (const [key, entry] of seen) {
    if (entry.pages.size < threshold) continue;
    const spread = Math.max(...entry.tops) - Math.min(...entry.tops);
    if (spread <= tolerance) chrome.add(key);
  }
  return chrome;
}

/**
 * Order a page's lines for reading. Two-column pages are read down the left
 * column then the right, with spanning lines kept as header/footer around them;
 * anything else falls back to top-to-bottom.
 */
export function readingOrder(page: PageLayout): LayoutLine[] {
  const lines = [...page.lines];
  if (page.ocr) return lines;
  const middle = page.width / 2;
  const left = lines.filter((line) => line.x0 < middle - 15 && line.x1 <= middle + 30 && line.x1 - line.x0 < page.width * 0.7);
  const right = lines.filter((line) => line.x0 >= middle - 30 && line.x1 - line.x0 < page.width * 0.7);
  if (left.length < 4 || right.length < 4) return lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const spanning = lines.filter((line) => !left.includes(line) && !right.includes(line)).sort((a, b) => a.top - b.top);
  const firstColumnTop = Math.min(...left.map((line) => line.top), ...right.map((line) => line.top));
  const header = spanning.filter((line) => line.bottom <= firstColumnTop + 5);
  const footer = spanning.filter((line) => !header.includes(line));
  return [
    ...header,
    ...left.sort((a, b) => a.top - b.top || a.x0 - b.x0),
    ...right.sort((a, b) => a.top - b.top || a.x0 - b.x0),
    ...footer,
  ];
}

const LIST_START_RE = /^\s*(?:[-*+•·–—]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i;

/**
 * Split ordered lines into paragraphs. A new paragraph starts on a large
 * vertical gap, a list marker, or a column jump that follows a finished
 * sentence. Returns the lines of each paragraph so callers that need more than
 * prose — a Markdown converter classifying headings, say — keep the geometry.
 */
export function groupParagraphs(lines: LayoutLine[]): LayoutLine[][] {
  if (!lines.length) return [];
  const bodySize = median(lines.map((line) => line.size)) || 10;
  const paragraphs: LayoutLine[][] = [];
  let current: LayoutLine[] = [];
  let text = '';
  let previous: LayoutLine | null = null;

  for (const line of lines) {
    const gap = previous ? line.top - previous.bottom : 0;
    const columnJump = previous ? line.x0 > previous.x1 + 30 || previous.x0 > line.x1 + 30 : false;
    const startsList = LIST_START_RE.test(line.text);
    // A paragraph routinely runs off the foot of one column and continues at the
    // head of the next. Treat the jump as a paragraph end only when the previous
    // line actually finished a sentence, otherwise the prose is torn mid-word.
    const jumpEndsParagraph = columnJump && /[.!?:;][)"'”’\]]?$/.test(text.trimEnd());
    const breakHere = previous != null
      && (gap > bodySize * 1.15 || jumpEndsParagraph || startsList || line.paragraphBreakBefore === true);

    if (breakHere) {
      if (current.length) paragraphs.push(current);
      current = [line];
      text = line.text;
    } else {
      current.push(line);
      text = text ? dehyphenatingJoin(text, line.text) : line.text;
    }
    previous = line;
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

/** Join the lines of one paragraph into a single string, repairing hyphens. */
export function paragraphText(lines: LayoutLine[]): string {
  return lines.reduce((acc, line) => (acc ? dehyphenatingJoin(acc, line.text) : line.text), '');
}

/**
 * Assemble ordered lines into paragraph text. Lines of the same paragraph are
 * joined with hyphen repair; paragraphs are separated by a blank line.
 */
export function linesToText(lines: LayoutLine[]): string {
  return groupParagraphs(lines).map(paragraphText).filter(Boolean).join('\n\n');
}

/**
 * Full text of one page: ordered for reading, stripped of repeated chrome, and
 * assembled into paragraphs. Pass the document-wide `chrome` set from
 * repeatedChrome() to remove running headers/footers; omit it for a single page.
 */
export function layoutPageText(layout: PageLayout, chrome?: Set<string>): string {
  let lines = readingOrder(layout);
  if (chrome?.size) {
    const candidates = new Set(chromeCandidates(layout));
    lines = lines.filter((line) => !(candidates.has(line) && chrome.has(chromeKey(line.text))));
  }
  return linesToText(lines);
}

/** Drop per-item geometry once line text exists, to bound memory on long documents. */
export function withoutItems(layout: PageLayout): PageLayout {
  return { ...layout, lines: layout.lines.map((line) => ({ ...line, items: [] })) };
}
