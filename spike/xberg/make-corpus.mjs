// Build a test corpus of academic-layout PDFs with KNOWN ground truth.
//
// arXiv/PMC are blocked from this environment, so instead of guessing whether an
// extraction is right we synthesise the hard cases and keep the source text:
//   - two-column body (the classic reading-order failure)
//   - a running header + page-number footer on every page (chrome noise)
//   - words deliberately split across line ends with hyphens (de-hyphenation)
//   - superscript footnote markers
// Ground truth is written alongside each PDF as .truth.json.

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = path.join(process.cwd(), 'corpus');
fs.mkdirSync(OUT, { recursive: true });

const PARAGRAPHS = [
  'The question of how scholarly infrastructures shape the circulation of evidence has occupied historians of science for several decades, yet the mechanisms by which citation practices consolidate disciplinary boundaries remain contested.',
  'We argue that bibliographic databases function less as neutral mirrors of a literature than as active participants in its constitution, selecting which venues become visible and which remain peripheral to the working researcher.',
  'Our analysis proceeds in three movements. First we reconstruct the institutional history of indexing services. Second we examine how coverage decisions propagate into quantitative assessment. Third we consider the consequences for interdisciplinary fields.',
  'Methodologically we combine archival research on editorial correspondence with a quantitative reconstruction of coverage expansion across four decades, treating the two evidentiary registers as mutually corrective rather than merely complementary.',
  'The archival record demonstrates that coverage decisions were frequently improvised, responding to commercial pressure and the availability of willing editorial labour rather than to any articulated principle of scientific significance.',
  'This improvisation has durable consequences. Once a venue enters an index it accumulates measurable citations, which in turn justify its continued inclusion, while excluded venues remain invisible to precisely the metrics that would warrant their addition.',
  'We describe this dynamic as infrastructural sedimentation, borrowing the term from studies of standardisation, and we suggest it explains the striking stability of disciplinary hierarchies despite considerable turnover in research content.',
  'The implications extend beyond bibliometrics. If evaluation regimes inherit the contingencies of mid-century commercial decisions, then reforms addressed only to the calculation of indicators leave the underlying selection mechanism untouched.',
];

// Repeat the section so the documents run to several pages: running-header
// detection needs at least three pages before it will strip anything.
const SECTIONS = 16;
const BODY = Array.from({ length: SECTIONS }, () => PARAGRAPHS).flat();
const GROUND_TRUTH = BODY.join('\n\n');

// Words we will deliberately hyphenate across a line break, to test repair.
const HYPHENATE = new Set(['infrastructures', 'bibliographic', 'interdisciplinary', 'methodologically', 'sedimentation', 'standardisation', 'considerable', 'contingencies']);

function layoutColumn(words, font, size, width) {
  const lines = [];
  let line = [];
  const widthOf = (text) => font.widthOfTextAtSize(text, size);
  for (const word of words) {
    const candidate = [...line, word].join(' ');
    if (widthOf(candidate) <= width || line.length === 0) {
      line.push(word);
      continue;
    }
    // Split a long word across the break with a hyphen where we chose to.
    if (HYPHENATE.has(word.replace(/[^a-z]/gi, '').toLowerCase()) && word.length > 8) {
      const room = width - widthOf(line.join(' ') + ' ');
      let cut = 0;
      for (let i = 3; i < word.length - 3; i++) {
        if (widthOf(word.slice(0, i) + '-') <= room) cut = i; else break;
      }
      if (cut >= 3) {
        lines.push([...line, word.slice(0, cut) + '-'].join(' '));
        line = [word.slice(cut)];
        continue;
      }
    }
    lines.push(line.join(' '));
    line = [word];
  }
  if (line.length) lines.push(line.join(' '));
  return lines;
}

async function buildTwoColumn({ file, title, columns = 2, chrome = true, scramble = false }) {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

  const W = 595, H = 842, margin = 54, gutter = 30;
  const colWidth = (W - margin * 2 - gutter * (columns - 1)) / columns;
  const size = 9.5, leading = 12.5;

  // Flow every paragraph into a single stream of lines, marking paragraph starts.
  const stream = [];
  for (const para of BODY) {
    const lines = layoutColumn(para.split(/\s+/), body, size, colWidth);
    lines.forEach((text, i) => stream.push({ text, first: i === 0 }));
    stream.push({ text: '', first: false, blank: true });
  }

  const pending = [];
  let page = doc.addPage([W, H]);
  let pageNo = 1;
  let col = 0;
  let y = H - margin - 40;
  const bottom = margin + 24;

  const drawChrome = () => {
    if (!chrome) return;
    page.drawText('JOURNAL OF SYNTHETIC STUDIES  ·  VOL. 12  ·  2026', {
      x: margin, y: H - 34, size: 7.5, font: body, color: rgb(0.35, 0.35, 0.35),
    });
    page.drawText(String(pageNo), { x: W / 2, y: 26, size: 8, font: body, color: rgb(0.35, 0.35, 0.35) });
  };

  page.drawText(title, { x: margin, y: H - margin - 12, size: 15, font: bold });
  drawChrome();

  for (const line of stream) {
    if (line.blank) { y -= leading * 0.5; continue; }
    if (y < bottom) {
      col += 1;
      if (col >= columns) {
        page = doc.addPage([W, H]);
        pageNo += 1;
        col = 0;
        drawChrome();
        y = H - margin - 10;
      } else {
        y = H - margin - 10;
      }
    }
    const draw = { page, text: line.text, x: margin + col * (colWidth + gutter), y };
    if (scramble) pending.push(draw);
    else page.drawText(draw.text, { x: draw.x, y: draw.y, size, font: body });
    y -= leading;
  }

  // Emit the identical visual layout, but in row-major content-stream order —
  // every line of the page top-to-bottom, crossing both columns. Many real
  // generators do exactly this, and it is what defeats naive concatenation.
  if (scramble) {
    const byPage = new Map();
    for (const d of pending) {
      if (!byPage.has(d.page)) byPage.set(d.page, []);
      byPage.get(d.page).push(d);
    }
    for (const [target, draws] of byPage) {
      draws.sort((a, b) => b.y - a.y || a.x - b.x);
      for (const d of draws) target.drawText(d.text, { x: d.x, y: d.y, size, font: body });
    }
  }

  const bytes = await doc.save();
  fs.writeFileSync(path.join(OUT, file), bytes);
  fs.writeFileSync(
    path.join(OUT, file.replace(/\.pdf$/, '.truth.json')),
    JSON.stringify({ file, columns, chrome, groundTruth: GROUND_TRUTH, paragraphs: BODY }, null, 2),
  );
  console.log(`wrote ${file} (${columns} col, chrome=${chrome}, ${pageNo} pages)`);
}

// The hard case, the same content single-column as a control, and a
// two-column variant with no running chrome to isolate that variable.
await buildTwoColumn({ file: 'two-column-paper.pdf', title: 'Infrastructural Sedimentation in Scholarly Indexing', columns: 2, chrome: true });
await buildTwoColumn({ file: 'single-column-paper.pdf', title: 'Infrastructural Sedimentation in Scholarly Indexing', columns: 1, chrome: true });
await buildTwoColumn({ file: 'two-column-no-chrome.pdf', title: 'Infrastructural Sedimentation in Scholarly Indexing', columns: 2, chrome: false });
await buildTwoColumn({ file: 'two-column-interleaved.pdf', title: 'Infrastructural Sedimentation in Scholarly Indexing', columns: 2, chrome: true, scramble: true });
