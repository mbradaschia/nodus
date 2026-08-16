import assert from 'node:assert/strict';
import test from 'node:test';
import { readSource } from './ipc-channel-census.mjs';

test('Estado de la cuestión is a Library-style workspace with three ordered tabs', async () => {
  const workspace = await readSource('src/views/CoverageWorkspace.tsx');
  assert.match(workspace, /data-testid="coverage-workspace"/);
  assert.match(workspace, /data-testid="coverage-tabs"/);
  assert.match(workspace, /<Icon name="compass"/);
  assert.match(workspace, /bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100/);
  assert.match(workspace, /border-neutral-300 bg-white text-neutral-900[^\n]*dark:border-neutral-700 dark:bg-neutral-900/);
  assert.match(
    workspace,
    /\['map', 'Cobertura', '[a-z]+'\],\s*\['debate', 'Debates', '[a-z]+'\],\s*\['gaps', 'Huecos', '[a-z]+'\]/,
    'tab order stays Cobertura → Debates → Huecos',
  );
});

test('Debates remains routable but internal links switch the workspace tab', async () => {
  const [workspace, corpus, navigation] = await Promise.all([
    readSource('src/views/CoverageWorkspace.tsx'),
    readSource('src/app/views/corpus.tsx'),
    readSource('src/navigation.ts'),
  ]);
  assert.match(workspace, /const openDebates = \(\) => setTab\('debate'\)/);
  assert.match(workspace, /<ResearchMapView[\s\S]*onOpenDebates=\{openDebates\}/);
  assert.match(workspace, /<GapsView[\s\S]*onOpenDebates=\{openDebates\}/);
  assert.match(corpus, /debate:[\s\S]*<CoverageWorkspace[\s\S]*initialTab="debate"/);
  assert.doesNotMatch(navigation, /\{ id: 'debate',/);
});

test('Coverage reloads with the active vault and confirms destructive deletion', async () => {
  const [workspace, map] = await Promise.all([
    readSource('src/views/CoverageWorkspace.tsx'),
    readSource('src/views/ResearchMapView.tsx'),
  ]);
  assert.match(workspace, /<ResearchMapView[\s\S]*vaultId=\{vaultId\}/);
  assert.match(map, /const reloadList = useCallback\([\s\S]*\}, \[vaultId\]\)/);
  assert.match(map, /const approved = await confirm\(/);
  assert.match(map, /Se eliminará «\{title\}». Esta acción no se puede deshacer\./);
  assert.match(map, /if \(!approved\) return/);
});

test('Coverage accepts several questions into a serial queue and reveals ready results', async () => {
  const map = await readSource('src/views/ResearchMapView.tsx');
  assert.match(map, /coverageQuestionQueue\.enqueue/);
  assert.match(map, /data-testid="coverage-question-queue"/);
  assert.match(map, /event\.type === 'ready'[\s\S]*reloadList\(\)/);
  assert.match(map, /visibleQuestions = questions\.filter/);
});

test('every mapped sub-question offers the Assistant, with an opener chosen by its coverage', async () => {
  const map = await readSource('src/views/ResearchMapView.tsx');
  assert.match(map, /data-testid="subquestion-assistant"/);
  assert.match(
    map,
    /\{mapped\?\.coverageStatus && \(\s*<button\s*data-testid="subquestion-assistant"/,
    'the Assistant is gated on being mapped at all, not on any single coverage status',
  );
  assert.match(map, /onOpenAssistant\(assistantTarget\(mapped\.coverageStatus!, sub\.text, mapped\.links\)\)/);
  const openers = map.match(/const ASSISTANT_OPENERS[\s\S]*?\n\};/);
  assert.ok(openers, 'the openers live in one table');
  for (const status of ['uncovered', 'covered', 'partial', 'disputed']) {
    assert.match(openers[0], new RegExp(`\\b${status}: \\{`), `${status} has its own opener`);
  }
  assert.match(openers[0], /selection: ASSISTANT_CONTEXTS\.gap/);
  assert.match(openers[0], /selection: ASSISTANT_CONTEXTS\.contradiction/);
  assert.match(
    map,
    /'Esta sub-pregunta no está cubierta por mi biblioteca\. Sugiere cómo abordarla y qué tipo de fuentes buscar\.'/,
    'the uncovered opener keeps its original wording',
  );
  assert.match(map, /t\('Lo que mi biblioteca enlaza aquí:'\)/, 'the linked evidence travels with the prompt');
});

test('the sub-question graph opens scoped to its linked ideas, and only when there are any', async () => {
  const [map, navigation, graph] = await Promise.all([
    readSource('src/views/ResearchMapView.tsx'),
    readSource('src/navigation.ts'),
    readSource('src/views/GraphView.tsx'),
  ]);
  assert.match(
    map,
    /\{ideas\.length > 0 && \(\s*<button\s*data-testid="subquestion-graph"/,
    'no Graph button without ideas to scope to',
  );
  assert.match(map, /onOpenGraph\(\{ preset: 'overview', scopeNodeIds: ideas\.map\(\(l\) => l\.refId\), label: sub\.text \}\)/);
  assert.match(navigation, /scopeNodeIds\?: string\[\];/);
  assert.match(graph, /scopeNodeIds: target\?\.scopeNodeIds \? \[\.\.\.target\.scopeNodeIds\] : \[\]/);
});

test('a scoped graph survives neither the semantic zoom, the preset atlas, nor a reload', async () => {
  const graph = await readSource('src/views/GraphView.tsx');
  assert.match(
    graph,
    /const progressiveOverview =[\s\S]*?filters\.scopeNodeIds\.length === 0;/,
    'the semantic zoom stands down so the scoped scene loads whole',
  );
  assert.match(
    graph,
    /presetAtlasModel = useMemo\([\s\S]*?filters\.scopeNodeIds\.length === 0/,
    'the sampled atlas stands down so the scoped nodes are not thinned away',
  );
  assert.match(
    graph,
    /const \{ scopeNodeIds: _scope, \.\.\.persisted \} = filters;\s*localStorage\.setItem\(filterStorageKey, JSON\.stringify\(persisted\)\)/,
    'the scope is stripped before the filters are persisted',
  );
  assert.match(graph, /merged\.scopeNodeIds = \[\];/, 'and ignored if an older build ever wrote it');
  assert.match(
    graph,
    /if \(target\.nodeId \|\| target\.edgeId \|\| target\.workId \|\| target\.scopeNodeIds\?\.length\) setGraphLevel\(\{ level: 'full' \}\)/,
    'a scoped deep-link asks for the full scene, like the other node-level ones',
  );
});

test('the academic section name uses the native term in every supported language', async () => {
  const expected = [
    ['src/i18n.en.ts', 'State of the art'],
    ['src/i18n.fr.ts', 'État de la question'],
    ['src/i18n.de.ts', 'Forschungsstand'],
    ['src/i18n.pt.ts', 'Estado da arte'],
    ['src/i18n.pt-BR.ts', 'Estado da arte'],
    ['src/i18n.it.ts', 'Stato dell’arte'],
    ['src/i18n.tr.ts', 'Alanyazın'],
  ];
  for (const [file, term] of expected) {
    assert.match(await readSource(file), new RegExp(`Estado de la cuestión['"]: ['"]${term}`), `${file} uses ${term}`);
  }
});
