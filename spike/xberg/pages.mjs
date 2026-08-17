// Can xberg reproduce Nodus' [[p. N]] page markers and per-page content?
import { extract } from '@xberg-io/xberg';

const target = process.argv[2];

const out = await extract(
  { kind: 'uri', uri: target },
  {
    useCache: false,
    pages: {
      extractPages: true,
      insertPageMarkers: true,
      markerFormat: '\n\n[[p. {page_num}]]\n\n',
    },
  },
);

const r = out.results[0];
console.log('pages array:', Array.isArray(r.pages) ? `array(${r.pages.length})` : '(absent)');
if (Array.isArray(r.pages) && r.pages.length) {
  console.log('page item keys:', Object.keys(r.pages[0]).join(', '));
  console.log('\npage 1 content (first 300 chars):');
  console.log(String(r.pages[0].content ?? '').slice(0, 300));
}

const markers = (r.content?.match(/\[\[p\. \d+\]\]/g) ?? []);
console.log(`\npage markers inserted into content: ${markers.length}`);
console.log('first few:', markers.slice(0, 6).join(' '));

// Does per-page content carry geometry for annotation anchoring?
const probe = JSON.stringify(r.pages ?? []);
for (const f of ['bbox', 'boundingBox', 'pageNumber']) {
  console.log(`"${f}" in pages JSON: ${(probe.match(new RegExp(`"${f}"`, 'g')) ?? []).length}`);
}
