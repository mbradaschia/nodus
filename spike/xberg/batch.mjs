// Batch comparison across every PDF in the repo, so the numbers aren't a
// single-document fluke.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

for (const f of files) {
  const full = path.join(dir, f);
  try {
    const out = execFileSync('node', ['compare.mjs', full], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    const lines = out.split('\n').filter((l) => l.includes('baseline') || l.includes("'xberg'"));
    console.log(`\n### ${f}`);
    for (const l of lines) console.log(l);
  } catch (e) {
    console.log(`\n### ${f}\n  FAILED: ${e.message.split('\n')[0]}`);
  }
}
