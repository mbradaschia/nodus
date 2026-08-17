import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const truth = JSON.parse(fs.readFileSync(file.replace(/\.pdf.*$/, '.pdf').replace(/\.pdf$/, '.truth.json'), 'utf8'));
const text = fs.readFileSync(file, 'utf8');
const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
const hay = squash(text);

const unique = new Map();
for (const p of truth.paragraphs) unique.set(p, (unique.get(p) ?? 0) + 1);

const count = (n) => { let c = 0, i = 0; for (;;) { const at = hay.indexOf(n, i); if (at < 0) return c; c++; i = at + n.length; } };

for (const [para, times] of unique) {
  const found = count(squash(para));
  const flag = found >= times ? 'ok  ' : 'MISS';
  console.log(`${flag} ${found}/${times}  ${para.slice(0, 62)}…`);
  if (found < times) {
    // Show how far the longest prefix survives, to locate the break point.
    const s = squash(para);
    let lo = 20, hi = s.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (hay.includes(s.slice(0, mid))) lo = mid; else hi = mid - 1; }
    console.log(`       longest surviving prefix: ${lo}/${s.length} chars → …${para.slice(Math.max(0, Math.round(lo * para.length / s.length) - 45), Math.round(lo * para.length / s.length) + 15)}`);
  }
}
