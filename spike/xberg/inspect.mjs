// What does xberg actually populate for a PDF? Nodus needs page numbers for
// its [[p. N]] citation markers and bboxes for annotation re-anchoring.
import { extract } from '@xberg-io/xberg';

const target = process.argv[2];
const out = await extract({ kind: 'uri', uri: target }, { useCache: false });
const r = out.results[0];

console.log('top-level result keys:', Object.keys(r).join(', '));
console.log('\nmimeType:', r.mimeType);
console.log('content length:', r.content?.length);

for (const key of ['pages', 'tables', 'images', 'chunks', 'entities', 'layout', 'structure']) {
  const v = r[key];
  if (v == null) { console.log(`${key}: (absent)`); continue; }
  console.log(`${key}: ${Array.isArray(v) ? `array(${v.length})` : typeof v}`);
  if (Array.isArray(v) && v.length) console.log(`   first item keys: ${Object.keys(v[0]).join(', ')}`);
}

if (r.metadata) {
  console.log('\nmetadata keys:', Object.keys(r.metadata).join(', '));
  console.log('metadata.pages:', JSON.stringify(r.metadata.pages)?.slice(0, 200));
}

// Does anything carry a page number we could map content back to?
const probe = JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 60)}…` : v));
for (const field of ['pageNumber', 'bbox', 'boundingBox']) {
  const n = (probe.match(new RegExp(`"${field}"`, 'g')) ?? []).length;
  console.log(`occurrences of "${field}" in result JSON: ${n}`);
}
