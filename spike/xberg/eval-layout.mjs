// Measure the pageText fix against known ground truth.
//
// Runs both extractors over the same PDFs:
//   OLD — items.map(str).join(' ')            (what pageText used to do)
//   NEW — pdfLayout: lines + reading order + de-hyphenation + chrome removal
//
// The corpus PDFs ship a .truth.json with the exact prose that was typeset, so
// "did it work" is a measurement rather than an impression. The headline metric
// is paragraph recovery: a source paragraph counts as recovered only if it
// reappears intact, which fails if columns interleave, if a line break is lost,
// or if a hyphenated word is not rejoined.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

if (!process.argv.includes('--electron-eval')) {
  const { execFileSync } = require('node:child_process');
  execFileSync(
    path.join(repoRoot, 'node_modules/.bin/electron'),
    [fileURLToPath(import.meta.url), '--electron-eval', ...process.argv.slice(2)],
    { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' },
  );
  process.exit(0);
}

const { installRuntimeHooks } = await import(path.join(repoRoot, 'scripts/lib/tsRuntimeHooks.mjs'));
installRuntimeHooks(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nodus-eval-')));

const { openPdf } = require(path.join(repoRoot, 'electron/extraction/pdfjsLoader.ts'));
const { pageLayout, repeatedChrome, layoutPageText, withoutItems } =
  require(path.join(repoRoot, 'shared/pdfLayout.ts'));

// ── the two extractors ───────────────────────────────────────────────────────

async function extractOld(file) {
  const pdf = await openPdf(file);
  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const txt = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .filter(Boolean).join(' ').trim();
    page.cleanup?.();
    if (txt.length >= 50) parts.push(`[[p. ${p}]]\n${txt}`);
  }
  await pdf.destroy?.();
  return parts.join('\n\n');
}

async function extractNew(file) {
  const pdf = await openPdf(file);
  const layouts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    layouts.push(withoutItems(await pageLayout(page, p)));
    page.cleanup?.();
  }
  await pdf.destroy?.();
  const chrome = repeatedChrome(layouts);
  const parts = [];
  for (const layout of layouts) {
    const txt = layoutPageText(layout, chrome);
    if (txt.length >= 50) parts.push(`[[p. ${layout.page}]]\n${txt}`);
  }
  return parts.join('\n\n');
}

// ── metrics ──────────────────────────────────────────────────────────────────

// Whitespace-insensitive so line-break decisions don't count as errors, but
// hyphens survive — an unrepaired "infrastruc-tures" still fails to match.
const squash = (s) => s.toLowerCase().replace(/\s+/g, '');

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

function paragraphRecovery(extracted, paragraphs) {
  const hay = squash(extracted);
  const unique = new Map();
  for (const p of paragraphs) unique.set(p, (unique.get(p) ?? 0) + 1);
  let expected = 0, found = 0;
  for (const [para, times] of unique) {
    expected += times;
    found += Math.min(times, countOccurrences(hay, squash(para)));
  }
  return { expected, found, rate: expected ? found / expected : 0 };
}

// A hyphen followed by a lowercase letter with no space: a line-break hyphen
// that was joined but never repaired, or left dangling before whitespace.
function hyphenArtifacts(text) {
  return (text.match(/\p{Ll}-\s+\p{Ll}/gu) ?? []).length;
}

const CHROME = 'JOURNAL OF SYNTHETIC STUDIES';

function report(label, text, truth) {
  const rec = paragraphRecovery(text, truth.paragraphs);
  return {
    extractor: label,
    'paragraphs ✓': `${rec.found}/${rec.expected}`,
    recovery: `${(rec.rate * 100).toFixed(1)}%`,
    chromeLeaks: countOccurrences(text.toLowerCase(), CHROME.toLowerCase()),
    hyphenBreaks: hyphenArtifacts(text),
    chars: text.length,
    lines: text.split('\n').filter((l) => l.trim()).length,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────

const dir = path.join(here, 'corpus');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

for (const file of files) {
  const full = path.join(dir, file);
  const truth = JSON.parse(fs.readFileSync(full.replace(/\.pdf$/, '.truth.json'), 'utf8'));
  const oldText = await extractOld(full);
  const newText = await extractNew(full);

  console.log(`\n### ${file}  (${truth.columns} column, chrome=${truth.chrome})`);
  console.table([report('OLD (naive join)', oldText, truth), report('NEW (layout engine)', newText, truth)]);

  fs.writeFileSync(path.join(dir, `${file}.old.txt`), oldText);
  fs.writeFileSync(path.join(dir, `${file}.new.txt`), newText);
}

console.log('\nPer-file outputs written next to the corpus PDFs (.old.txt / .new.txt).');
