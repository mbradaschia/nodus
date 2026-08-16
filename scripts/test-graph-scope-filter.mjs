// El grafo acotado a una sub-pregunta. Cobertura entrega las ideas que el mapeo
// enlazó a una sub-pregunta y el grafo debe abrirse en ese trozo, no en la red
// entera: las semillas más su primer salto, que es lo que hace que un puñado de
// ideas se lea como un grupo y no como puntos sueltos.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(path.join(os.tmpdir(), 'nodus-graph-scope-filter-'));
const bundle = path.join(output, 'model.mjs');
await build({
  entryPoints: [path.join(repoRoot, 'src/views/graph/model.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
});
const { buildGraphModel } = await import(pathToFileURL(bundle).href);
test.after(() => rm(output, { recursive: true, force: true }));

const defaultFilters = {
  search: '',
  nodeTypes: ['theme', 'claim', 'finding', 'construct', 'method', 'framework'],
  edgeTypes: ['contains', 'supports', 'extends', 'contradicts'],
  theme: '',
  workIds: [],
  authors: [],
  yearMin: null,
  yearMax: null,
  readState: 'all',
  minConfidence: 0,
  basis: 'all',
  scopeNodeIds: [],
};

function idea(id, theme, extra = {}) {
  return {
    id,
    label: id,
    type: 'claim',
    workCount: 1,
    workIds: [`work:${id}`],
    read: true,
    themes: [theme],
    years: [2020],
    authors: ['Autora'],
    maxConfidence: 0.9,
    ...extra,
  };
}

function themeNode(id, label) {
  return {
    id,
    label,
    type: 'theme',
    workCount: 4,
    workIds: [],
    read: true,
    themes: [label],
    years: [2020],
    authors: [],
    maxConfidence: 1,
  };
}

// Dos temas. En «Motivación», la semilla toca a vecina por una arista semántica
// y al tema por pertenencia; lejana queda a dos saltos. «Aparte» no se toca.
function fixture() {
  return {
    nodes: [
      themeNode('theme:motivacion', 'Motivación'),
      themeNode('theme:aparte', 'Aparte'),
      idea('semilla', 'Motivación'),
      idea('vecina', 'Motivación'),
      idea('lejana', 'Motivación'),
      idea('ajena', 'Aparte'),
    ],
    edges: [
      { id: 'c1', source: 'theme:motivacion', target: 'semilla', type: 'contains', basis: 'explicit', confidence: 1 },
      { id: 'c2', source: 'theme:motivacion', target: 'vecina', type: 'contains', basis: 'explicit', confidence: 1 },
      { id: 'c3', source: 'theme:motivacion', target: 'lejana', type: 'contains', basis: 'explicit', confidence: 1 },
      { id: 'c4', source: 'theme:aparte', target: 'ajena', type: 'contains', basis: 'explicit', confidence: 1 },
      { id: 's1', source: 'semilla', target: 'vecina', type: 'supports', basis: 'inferred', confidence: 0.8 },
      { id: 's2', source: 'vecina', target: 'lejana', type: 'supports', basis: 'inferred', confidence: 0.8 },
    ],
  };
}

function idsOf(model) {
  return new Set(model.nodes.map((node) => node.id));
}

test('an empty scope leaves the graph exactly as it was', () => {
  const data = fixture();
  const scoped = buildGraphModel(data, { ...defaultFilters, scopeNodeIds: [] }, 'ideas', 'overview');
  const plain = buildGraphModel(data, defaultFilters, 'ideas', 'overview');
  assert.deepEqual(scoped, plain);
  assert.deepEqual(idsOf(plain), new Set(['theme:motivacion', 'theme:aparte', 'semilla', 'vecina', 'lejana', 'ajena']));
});

test('a scope keeps its seeds and their first hop, and nothing further out', () => {
  const model = buildGraphModel(fixture(), { ...defaultFilters, scopeNodeIds: ['semilla'] }, 'ideas', 'overview');
  assert.deepEqual(
    idsOf(model),
    new Set(['semilla', 'vecina', 'theme:motivacion']),
    'seed, its semantic neighbour and its containing theme survive; two hops out does not',
  );
});

test('several seeds scope to the union of their neighbourhoods', () => {
  const model = buildGraphModel(fixture(), { ...defaultFilters, scopeNodeIds: ['semilla', 'ajena'] }, 'ideas', 'overview');
  assert.deepEqual(idsOf(model), new Set(['semilla', 'vecina', 'theme:motivacion', 'ajena', 'theme:aparte']));
});

test('the hop reaches across every edge, not only the ones the filters keep', () => {
  // 'supports' is filtered out, so the edge cannot be drawn — but the neighbour it
  // reaches is still part of this sub-question's neighbourhood, and dropping it
  // would leave the scope emptier than the card promised.
  const model = buildGraphModel(
    fixture(),
    { ...defaultFilters, edgeTypes: ['contains'], scopeNodeIds: ['semilla'] },
    'ideas',
    'overview',
  );
  assert.ok(idsOf(model).has('vecina'), 'the neighbour stays visible even when its edge type is hidden');
  assert.ok(!model.edges.some((edge) => edge.type === 'supports'), 'the hidden edge type is still not drawn');
});

test('a scope narrows the graph without overriding the other filters', () => {
  const data = fixture();
  data.nodes = data.nodes.map((node) => (node.id === 'vecina' ? { ...node, read: false } : node));
  const model = buildGraphModel(
    data,
    { ...defaultFilters, readState: 'read', scopeNodeIds: ['semilla'] },
    'ideas',
    'overview',
  );
  assert.ok(!idsOf(model).has('vecina'), 'an unread neighbour is still hidden by the reading filter');
  assert.ok(idsOf(model).has('semilla'));
});

test('seeds missing from the loaded graph do not widen the scope', () => {
  const model = buildGraphModel(
    fixture(),
    { ...defaultFilters, scopeNodeIds: ['semilla', 'idea-que-ya-no-existe'] },
    'ideas',
    'overview',
  );
  assert.deepEqual(idsOf(model), new Set(['semilla', 'vecina', 'theme:motivacion']));
});

test('every surviving edge still joins two visible nodes', () => {
  const model = buildGraphModel(fixture(), { ...defaultFilters, scopeNodeIds: ['semilla'] }, 'ideas', 'overview');
  const ids = idsOf(model);
  for (const edge of model.edges) {
    assert.ok(ids.has(edge.source), `edge source ${edge.source} is visible`);
    assert.ok(ids.has(edge.target), `edge target ${edge.target} is visible`);
  }
});
