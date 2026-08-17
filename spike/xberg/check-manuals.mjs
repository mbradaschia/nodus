// Regression check on the repo's real PDFs (single-column, no ground truth):
// the fix must not degrade documents that the old path already handled.
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
installRuntimeHooks(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nodus-man-')));
const { openPdf } = require(path.join(repoRoot, 'electron/extraction/pdfjsLoader.ts'));
const { pageLayout, repeatedChrome, layoutPageText, withoutItems } =
  require(path.join(repoRoot, 'shared/pdfLayout.ts'));

const dir = path.join(repoRoot, 'site/manuals');
const rows = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
  const full = path.join(dir, file);
  const pdf = await openPdf(full);

  const oldParts = [], layouts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const raw = content.items.map((i) => (typeof i.str === 'string' ? i.str : '')).filter(Boolean).join(' ').trim();
    if (raw.length >= 50) oldParts.push(`[[p. ${p}]]\n${raw}`);
    layouts.push(withoutItems(await pageLayout(page, p)));
    page.cleanup?.();
  }
  await pdf.destroy?.();

  const chrome = repeatedChrome(layouts);
  const newParts = [];
  for (const l of layouts) {
    const t = layoutPageText(l, chrome);
    if (t.length >= 50) newParts.push(`[[p. ${l.page}]]\n${t}`);
  }
  const oldText = oldParts.join('\n\n'), newText = newParts.join('\n\n');
  // Count only tokens containing a letter: the manuals' tables of contents are
  // full of dot leaders, which the old joiner split into hundreds of '.' tokens.
  const words = (s) => s.split(/\s+/).filter((t) => /\p{L}/u.test(t)).length;
  const paras = (s) => s.split(/\n\s*\n/).filter((x) => x.trim()).length;

  fs.writeFileSync(path.join(here, `man-${file}.new.txt`), newText);
  rows.push({
    file: file.replace('nodus-', '').replace('-manual.pdf', ''),
    pages: layouts.length,
    'chars old': oldText.length,
    'chars new': newText.length,
    'words old': words(oldText),
    'words new': words(newText),
    'word Δ': `${(((words(newText) - words(oldText)) / words(oldText)) * 100).toFixed(1)}%`,
    'paras old': paras(oldText),
    'paras new': paras(newText),
    'chrome stripped': chrome.size,
  });
}
console.table(rows);
