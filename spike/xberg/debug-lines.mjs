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
installRuntimeHooks(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nodus-dbg-')));

const { openPdf } = require(path.join(repoRoot, 'electron/extraction/pdfjsLoader.ts'));
const { pageLayout, readingOrder } = require(path.join(repoRoot, 'electron/extraction/pdfLayout.ts'));

const file = process.argv[process.argv.indexOf('--electron-eval') + 1];
const pdf = await openPdf(file);
const page = await pdf.getPage(1);
const layout = await pageLayout(page, 1);

console.log(`page width=${layout.width.toFixed(0)} height=${layout.height.toFixed(0)} lines=${layout.lines.length}\n`);
console.log('RAW LINES (grouping output):');
for (const l of layout.lines.slice(0, 14)) {
  console.log(`  x0=${l.x0.toFixed(0).padStart(4)} x1=${l.x1.toFixed(0).padStart(4)} w=${(l.x1-l.x0).toFixed(0).padStart(4)} top=${l.top.toFixed(0).padStart(4)} sz=${l.size.toFixed(1)}  ${JSON.stringify(l.text.slice(0, 90))}`);
}
const ordered = readingOrder(layout);
console.log('\nREADING ORDER (first 8):');
for (const l of ordered.slice(0, 8)) console.log(`  x0=${l.x0.toFixed(0).padStart(4)} top=${l.top.toFixed(0).padStart(4)}  ${JSON.stringify(l.text.slice(0, 80))}`);
await pdf.destroy?.();
