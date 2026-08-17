// Nodus Toolkit — document conversions (category A, except A5 which needs a
// BrowserWindow and lives in renderPdf.ts). Electron-free: pdfjs for reading PDFs,
// mammoth + turndown for DOCX, adm-zip for EPUB, the `docx` lib for writing DOCX,
// and the shared markdownToHtml for Markdown → EPUB. Heavy deps load lazily.
import fs from 'node:fs';
import path from 'node:path';
import { markdownToHtml, escapeHtml } from '@shared/toolkitMarkdown';
import type { ToolkitOpRegistry, ToolkitRunContext } from '../toolkitJobs';
import type { ToolkitProduced } from '@shared/toolkitTypes';
import { buildZip, crc32, type ZipEntry } from '../zip';
import { openPdf } from '../../extraction/pdfjsLoader';
import {
  chromeCandidates,
  chromeKey,
  cleanInlineText,
  groupParagraphs,
  layoutPageText,
  pageLayout,
  paragraphText,
  readingOrder,
  type LayoutLine,
  repeatedChrome,
  withoutItems,
  type PageLayout,
} from '@shared/pdfLayout';

const enc = new TextEncoder();
const readText = (filePath: string): string => fs.readFileSync(filePath, 'utf8');

// ── A1 / A2 — PDF → text / Markdown ─────────────────────────────────────────

async function pdfToText(input: string, ctx: ToolkitRunContext): Promise<ToolkitProduced[]> {
  const pdf = await openPdf(input);
  const layouts: PageLayout[] = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      if (ctx.signal.cancelled) break;
      const page = await pdf.getPage(p);
      layouts.push(withoutItems(await pageLayout(page, p)));
      page.cleanup?.();
      ctx.onPageProgress(p / pdf.numPages);
    }
  } finally {
    await pdf.destroy?.();
  }
  // Collected across the document first: a running header can only be told from
  // body text by the fact that it recurs, so a page at a time cannot drop it.
  const chrome = repeatedChrome(layouts);
  const parts = layouts.map((layout) => layoutPageText(layout, chrome));
  return [{ data: enc.encode(parts.join('\n\n').trim() + '\n'), ext: 'txt' }];
}

async function pdfToMarkdown(input: string, ctx: ToolkitRunContext): Promise<ToolkitProduced[]> {
  const pdf = await openPdf(input);
  const layouts: PageLayout[] = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      if (ctx.signal.cancelled) break;
      const page = await pdf.getPage(p);
      layouts.push(await pageLayout(page, p));
      page.cleanup?.();
      ctx.onPageProgress(p / pdf.numPages);
    }
  } finally {
    await pdf.destroy?.();
  }

  // Body font size = the most common line size; larger blocks become headings.
  const freq = new Map<number, number>();
  for (const layout of layouts) {
    for (const line of layout.lines) freq.set(Math.round(line.size), (freq.get(Math.round(line.size)) ?? 0) + 1);
  }
  let bodySize = 12;
  let best = -1;
  for (const [size, n] of freq) if (n > best) { best = n; bodySize = size; }

  const chrome = repeatedChrome(layouts);
  const candidates = new Map(layouts.map((layout) => [layout, new Set(chromeCandidates(layout))]));
  const md: string[] = [];
  const sizeRatio = (line: LayoutLine): number => (bodySize > 0 ? line.size / bodySize : 1);

  for (const layout of layouts) {
    const marginLines = candidates.get(layout)!;
    const lines = readingOrder(layout)
      .filter((line) => !(marginLines.has(line) && chrome.has(chromeKey(line.text))));

    // Headings are classified per line by font size, as before. Only the body
    // runs between them are grouped into paragraphs, so a heading set close
    // above its first paragraph still comes out as a heading.
    let body: LayoutLine[] = [];
    const flushBody = (): void => {
      for (const group of groupParagraphs(body)) {
        const text = paragraphText(group);
        if (text) md.push(text);
      }
      body = [];
    };
    for (const line of lines) {
      const ratio = sizeRatio(line);
      if (ratio >= 1.3) {
        flushBody();
        const text = cleanInlineText(line.text);
        if (text) md.push(ratio >= 1.8 ? `# ${text}` : `## ${text}`);
      } else {
        body.push(line);
      }
    }
    flushBody();
  }
  return [{ data: enc.encode(md.join('\n\n').trim() + '\n'), ext: 'md' }];
}

// ── A3 — DOCX → Markdown / HTML / text ──────────────────────────────────────

async function docxConvert(input: string, ctx: ToolkitRunContext): Promise<ToolkitProduced[]> {
  const mammoth: any = await import('mammoth');
  const format = ctx.outputFormat ?? 'md';
  if (format === 'txt') {
    const { value } = await mammoth.extractRawText({ path: input });
    return [{ data: enc.encode(String(value ?? '')), ext: 'txt' }];
  }
  const { value: html } = await mammoth.convertToHtml({ path: input });
  if (format === 'html') {
    return [{ data: enc.encode(wrapHtml(String(html ?? ''))), ext: 'html' }];
  }
  const TurndownService = (await import('turndown')).default as any;
  const md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(String(html ?? ''));
  return [{ data: enc.encode(md + '\n'), ext: 'md' }];
}

function wrapHtml(bodyHtml: string, title = 'Documento'): string {
  return `<!doctype html>\n<html lang="es">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${bodyHtml}\n</body>\n</html>\n`;
}

// ── A4 — Markdown / HTML → DOCX ─────────────────────────────────────────────

const HEADING_LEVELS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];

/** Inline **bold** parsing into an array of docx TextRuns. */
function inlineRuns(TextRun: any, text: string): any[] {
  const runs: any[] = [];
  for (const chunk of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!chunk) continue;
    if (chunk.startsWith('**') && chunk.endsWith('**')) runs.push(new TextRun({ text: chunk.slice(2, -2), bold: true }));
    else runs.push(new TextRun(chunk));
  }
  return runs.length ? runs : [new TextRun(text)];
}

async function markdownToDocxBytes(md: string): Promise<Uint8Array> {
  const docx: any = await import('docx');
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } = docx;
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const children: any[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l);
  const splitRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      children.push(new Paragraph({ text: heading[2].trim(), heading: HeadingLevel[HEADING_LEVELS[heading[1].length - 1]] }));
      i++;
      continue;
    }
    if (/^\s*\|.*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) bodyRows.push(splitRow(lines[i++]));
      const makeRow = (cells: string[], bold: boolean) =>
        new TableRow({
          children: cells.map(
            (c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold })] })] }),
          ),
        });
      children.push(
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [makeRow(header, true), ...bodyRows.map((r) => makeRow(r, false))] }),
      );
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      children.push(new Paragraph({ children: inlineRuns(TextRun, line.replace(/^\s*[-*+]\s+/, '')), bullet: { level: 0 } }));
      i++;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      children.push(new Paragraph({ children: inlineRuns(TextRun, line.replace(/^\s*\d+\.\s+/, '')), numbering: { reference: 'nodus-ol', level: 0 } }));
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\|.*\|/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    children.push(new Paragraph({ children: inlineRuns(TextRun, buf.join(' ')) }));
  }
  const doc = new Document({
    numbering: { config: [{ reference: 'nodus-ol', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }] },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** Strip HTML to a rough Markdown via turndown, so HTML inputs reuse the MD path. */
async function htmlToMarkdown(html: string): Promise<string> {
  const TurndownService = (await import('turndown')).default as any;
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html);
}

async function textToDocx(input: string, _ctx: ToolkitRunContext): Promise<ToolkitProduced[]> {
  const ext = path.extname(input).toLowerCase();
  const raw = readText(input);
  const md = ext === '.html' || ext === '.htm' ? await htmlToMarkdown(raw) : raw;
  return [{ data: await markdownToDocxBytes(md), ext: 'docx' }];
}

// ── A6 — EPUB → Markdown / text ─────────────────────────────────────────────

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    const l = body.toLowerCase();
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16));
    if (l.startsWith('#')) return String.fromCodePoint(parseInt(l.slice(1), 10));
    return named[l] ?? m;
  });
}

function htmlBodyToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>(?=)/gi, '\n')
      .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n'),
  ).trim();
}

async function epubChapters(input: string): Promise<string[]> {
  const AdmZip = (await import('adm-zip')).default as any;
  const zip = new AdmZip(input);
  const readEntry = (name: string): string | null => {
    const e = zip.getEntry(name.replace(/^\/+/, ''));
    return e && !e.isDirectory ? e.getData().toString('utf8') : null;
  };
  const container = readEntry('META-INF/container.xml');
  const rootPath = container?.match(/full-path="([^"]+)"/i)?.[1];
  const opf = rootPath ? readEntry(rootPath) : null;
  if (!opf || !rootPath) return [];
  const base = path.posix.dirname(rootPath.replace(/^\/+/, ''));
  const manifest = new Map<string, string>();
  for (const m of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = m.match(/\bid="([^"]+)"/i)?.[1];
    const href = m.match(/\bhref="([^"]+)"/i)?.[1];
    if (id && href) manifest.set(id, path.posix.normalize(path.posix.join(base === '.' ? '' : base, href)));
  }
  const chapters: string[] = [];
  for (const ref of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = ref.match(/\bidref="([^"]+)"/i)?.[1];
    const href = idref ? manifest.get(idref) : null;
    if (href && /\.(xhtml|html?|xml)$/i.test(href)) {
      const html = readEntry(href);
      if (html) chapters.push(html);
    }
  }
  return chapters;
}

async function epubConvert(input: string, ctx: ToolkitRunContext): Promise<ToolkitProduced[]> {
  const chapters = await epubChapters(input);
  if (ctx.outputFormat === 'md') {
    const parts: string[] = [];
    for (const html of chapters) parts.push((await htmlToMarkdown(html)).trim());
    return [{ data: enc.encode(parts.join('\n\n').trim() + '\n'), ext: 'md' }];
  }
  const text = chapters.map((html) => htmlBodyToText(html)).filter(Boolean).join('\n\n');
  return [{ data: enc.encode(text.trim() + '\n'), ext: 'txt' }];
}

// ── A7 — Markdown → EPUB ────────────────────────────────────────────────────

function xhtmlChapter(title: string, bodyHtml: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>' +
    `<title>${escapeHtml(title)}</title></head><body>\n${bodyHtml}\n</body></html>`
  );
}

async function markdownToEpub(input: string): Promise<ToolkitProduced[]> {
  const md = readText(input);
  const title = md.match(/^#\s+(.*)$/m)?.[1]?.trim() || path.basename(input, path.extname(input));

  // Split into chapters at top-level (#) headings; keep everything if none.
  const sections: Array<{ title: string; body: string }> = [];
  const lines = md.split('\n');
  let currentTitle = title;
  let buf: string[] = [];
  const push = () => {
    if (buf.join('').trim()) sections.push({ title: currentTitle, body: markdownToHtml(buf.join('\n')) });
    buf = [];
  };
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      push();
      currentTitle = h1[1].trim();
    }
    buf.push(line);
  }
  push();
  if (sections.length === 0) sections.push({ title, body: markdownToHtml(md) });

  const manifestItems = sections
    .map((_, idx) => `<item id="c${idx + 1}" href="chap${idx + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const spineItems = sections.map((_, idx) => `<itemref idref="c${idx + 1}"/>`).join('');
  const uid = crc32(Buffer.from(md)).toString(16);
  const entries: ZipEntry[] = [
    // mimetype MUST be first and STORED (uncompressed) per the EPUB OCF spec.
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      store: false,
    },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">' +
          `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:nodus-${uid}</dc:identifier>` +
          `<dc:title>${escapeHtml(title)}</dc:title><dc:language>es</dc:language></metadata>` +
          `<manifest>${manifestItems}</manifest><spine>${spineItems}</spine></package>`,
      ),
      store: false,
    },
    ...sections.map((s, idx) => ({
      name: `OEBPS/chap${idx + 1}.xhtml`,
      data: Buffer.from(xhtmlChapter(s.title, s.body)),
      store: false,
    })),
  ];
  return [{ data: new Uint8Array(buildZip(entries)), ext: 'epub' }];
}

export const docOps: ToolkitOpRegistry = {
  'pdf-to-txt': { arity: 'each', run: ([input], ctx) => pdfToText(input, ctx) },
  'pdf-to-md': { arity: 'each', run: ([input], ctx) => pdfToMarkdown(input, ctx) },
  'docx-to-text': { arity: 'each', run: ([input], ctx) => docxConvert(input, ctx) },
  'text-to-docx': { arity: 'each', run: ([input], ctx) => textToDocx(input, ctx) },
  'epub-to-text': { arity: 'each', run: ([input], ctx) => epubConvert(input, ctx) },
  'md-to-epub': { arity: 'each', run: ([input]) => markdownToEpub(input) },
};
