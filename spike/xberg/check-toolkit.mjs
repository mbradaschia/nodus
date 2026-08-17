// Exercise the real Toolkit PDF converters (pdf-to-txt / pdf-to-md) end to end,
// so the rebuilt pdfToMarkdown is checked by its output and not just by tsc.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

if (!process.argv.includes('--electron-eval')) {
  const { execFileSync } = require('node:child_process');
  execFileSync(path.join(repoRoot, 'node_modules/.bin/electron'),
    [fileURLToPath(import.meta.url), '--electron-eval', ...process.argv.slice(2)],
    { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  process.exit(0);
}

const { installRuntimeHooks } = await import(path.join(repoRoot, 'scripts/lib/tsRuntimeHooks.mjs'));
installRuntimeHooks(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nodus-tk-')));
const { docOps } = require(path.join(repoRoot, 'electron/toolkit/convert/docs.ts'));

const ctx = { signal: { cancelled: false }, onPageProgress: () => {}, outputFormat: undefined };
const dec = new TextDecoder();

const targets = [
  path.join(here, 'corpus/two-column-interleaved.pdf'),
  path.join(repoRoot, 'site/manuals/nodus-academic-manual.pdf'),
];

for (const file of targets) {
  console.log(`\n=== ${path.basename(file)} ===`);
  for (const op of ['pdf-to-txt', 'pdf-to-md']) {
    const [produced] = await docOps[op].run([file], ctx);
    const text = dec.decode(produced.data);
    const headings = (text.match(/^#{1,2} .+$/gm) ?? []).length;
    const chrome = (text.match(/JOURNAL OF SYNTHETIC STUDIES|ACADEMIC RESEARCH VAULT MANUAL/gi) ?? []).length;
    console.log(`  ${op}: ${text.length} chars, ${text.split(/\n\s*\n/).filter((b) => b.trim()).length} blocks, ${headings} headings, chrome leaks: ${chrome}`);
    fs.writeFileSync(path.join(here, `tk-${path.basename(file)}.${produced.ext}`), text);
  }
}

// ── the previous pdfToMarkdown, reconstructed, for a heading-count comparison ──
const { openPdf } = require(path.join(repoRoot, 'electron/extraction/pdfjsLoader.ts'));

async function oldPdfLines(page) {
  const content = await page.getTextContent();
  const lines = []; let currentY = null; let buf = []; let size = 0;
  const flush = () => { const t = buf.join('').replace(/\s+/g, ' ').trim(); if (t) lines.push({ text: t, size }); buf = []; size = 0; };
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const tr = item.transform ?? [1, 0, 0, 1, 0, 0];
    const itemSize = Math.hypot(tr[2], tr[3]) || item.height || 0;
    if (currentY === null || Math.abs(tr[5] - currentY) > 2) { flush(); currentY = tr[5]; }
    buf.push(item.str); size = Math.max(size, itemSize);
    if (item.hasEOL) { flush(); currentY = null; }
  }
  flush();
  return lines;
}

console.log('\n--- heading counts: previous algorithm vs new ---');
for (const file of targets) {
  const pdf = await openPdf(file);
  const all = [];
  for (let p = 1; p <= pdf.numPages; p++) { const pg = await pdf.getPage(p); all.push(...await oldPdfLines(pg)); pg.cleanup?.(); }
  await pdf.destroy?.();
  const freq = new Map();
  for (const l of all) freq.set(Math.round(l.size), (freq.get(Math.round(l.size)) ?? 0) + 1);
  let bodySize = 12, best = -1;
  for (const [k, n] of freq) if (n > best) { best = n; bodySize = k; }
  let h = 0;
  for (const l of all) { const r = bodySize > 0 ? l.size / bodySize : 1; if (r >= 1.3) h++; }
  console.log(`  ${path.basename(file)}: previous=${h} headings (bodySize=${bodySize}, ${all.length} lines)`);
}
