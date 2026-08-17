// Spike: compare Nodus' current PDF text extraction against xberg.
//
// Baseline replicates electron/extraction/pdfjsLoader.ts:pageText() exactly —
// the naive `items.map(str).join(' ')` that feeds the whole analysis pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// ── baseline: current Nodus implementation ───────────────────────────────────

async function loadPdfjs() {
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  return import(pathToFileURL(entry).href);
}

async function baselineExtract(filePath) {
  const pdfjs = await loadPdfjs();
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const data = new Uint8Array(fs.readFileSync(filePath));
  const standardFontDataUrl = pathToFileURL(path.join(pdfjsRoot, 'standard_fonts') + path.sep).href;
  const pdf = await pdfjs.getDocument({
    data, useSystemFonts: true, standardFontDataUrl,
    isEvalSupported: false, disableFontFace: true,
  }).promise;

  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const txt = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    page.cleanup?.();
    if (txt.length >= 50) parts.push(`[[p. ${p}]]\n${txt}`);
  }
  await pdf.destroy?.();
  return { text: parts.join('\n\n'), pages: pdf.numPages };
}

// ── xberg ────────────────────────────────────────────────────────────────────

async function xbergExtract(filePath) {
  const { extract } = await import('@xberg-io/xberg');
  const output = await extract({ kind: 'uri', uri: filePath }, { useCache: false });
  const result = output.results[0];
  return { text: result.content ?? '', tables: result.tables?.length ?? 0, mime: result.mimeType };
}

// ── quality heuristics ───────────────────────────────────────────────────────

// Real 1-2 letter words, which must NOT be counted as fragments. Without this
// the metric just measures how much ordinary English a document contains.
const SHORT_WORDS = new Set([
  // English
  'a', 'i', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'id', 'if',
  'in', 'is', 'it', 'me', 'my', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  // Spanish (Nodus ships Spanish-language docs too)
  'e', 'o', 'u', 'y', 'de', 'el', 'en', 'es', 'la', 'lo', 'le', 'mi', 'ni', 'os',
  'se', 'si', 'su', 'te', 'tu', 'un', 'va', 've', 'al', 'da', 'ha', 'ya',
]);

// pdfjs emits a separate text item at every kerning/font switch. Joining them
// all with ' ' splits words: "T he ory". Count 1-2 char alphabetic fragments
// wedged between two alphabetic tokens that are NOT real short words.
function fragmentedWordRate(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  let frags = 0, alpha = 0;
  const examples = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^\p{L}+$/u.test(t)) continue;
    alpha++;
    if (t.length <= 2 && i > 0 && i < tokens.length - 1) {
      const prev = tokens[i - 1], next = tokens[i + 1];
      if (SHORT_WORDS.has(t.toLowerCase())) continue;
      if (/^\p{Ll}{1,2}$/u.test(t) && /\p{L}$/u.test(prev) && /^\p{L}/u.test(next)) {
        frags++;
        if (examples.length < 12) examples.push(`${prev} [${t}] ${next}`);
      }
    }
  }
  return { frags, alpha, rate: alpha ? frags / alpha : 0, examples };
}

// Words broken across a line by a hyphen that were never rejoined.
function danglingHyphens(text) {
  return (text.match(/\p{Ll}-\s+\p{Ll}/gu) ?? []).length;
}

function structure(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  return { lines: lines.length, paragraphs: paras.length };
}

function report(label, text, extra = {}) {
  const frag = fragmentedWordRate(text);
  const st = structure(text);
  return {
    label,
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    lines: st.lines,
    paragraphs: st.paragraphs,
    fragmentedWords: frag.frags,
    fragmentRate: `${(frag.rate * 100).toFixed(2)}%`,
    danglingHyphens: danglingHyphens(text),
    ...extra,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────

const target = process.argv[2];
if (!target) {
  console.error('usage: node compare.mjs <file.pdf>');
  process.exit(1);
}

console.log(`\n=== ${path.basename(target)} ===\n`);

const t0 = Date.now();
const base = await baselineExtract(target);
const baseMs = Date.now() - t0;

const t1 = Date.now();
let xb, xbMs, xbErr = null;
try {
  xb = await xbergExtract(target);
  xbMs = Date.now() - t1;
} catch (e) {
  xbErr = e;
  xbMs = Date.now() - t1;
}

const rows = [report('baseline (current pageText)', base.text, { ms: baseMs, pages: base.pages })];
if (xb) rows.push(report('xberg', xb.text, { ms: xbMs, tables: xb.tables }));

console.table(rows);

if (xbErr) {
  console.error('xberg FAILED:', xbErr.message);
  process.exit(2);
}

// Sample output so the difference is visible, not just numeric.
const sample = (text, n = 700) => text.replace(/^\[\[p\. \d+\]\]\n/, '').slice(0, n);
for (const [label, text] of [['BASELINE', base.text], ['XBERG', xb.text]]) {
  const ex = fragmentedWordRate(text).examples;
  console.log(`\n${label} fragmentation examples: ${ex.length ? ex.join(' | ') : '(none)'}`);
}

console.log('\n--- BASELINE sample ---\n');
console.log(sample(base.text));
console.log('\n--- XBERG sample ---\n');
console.log(sample(xb.text));

fs.writeFileSync(path.join(process.cwd(), 'out-baseline.txt'), base.text);
fs.writeFileSync(path.join(process.cwd(), 'out-xberg.txt'), xb.text);
console.log('\nFull outputs written to out-baseline.txt / out-xberg.txt');
