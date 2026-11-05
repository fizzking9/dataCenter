import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  command,
  createUser,
  createWorkspace,
  jsonFile,
  sessionFor,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const SCHEMA = [
  { name: 'doc_id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'text', type: 'string' },
  { name: 'city', type: 'string' },
];

/** Documents arrive as one declared-text bundle: a format, then flat documents. */
function bundle(documents: Array<Record<string, unknown>>, format = 'text'): string {
  return JSON.stringify({ format, documents });
}

const CORPUS = bundle([
  { doc_id: 'doc-001', title: '压缩机维修', text: '冷库压缩机 维修 步骤', city: '杭州' },
  { doc_id: 'doc-002', title: '冷链巡检', text: '巡检记录 维修 建议', city: '上海' },
  { doc_id: 'doc-003', title: '冷库巡检', text: '巡检记录 温度 曲线', city: '杭州' },
  { doc_id: 'doc-004', title: '冷链巡检', text: '维修 记录 归档', city: '上海' },
  { doc_id: 'doc-005', title: '杭州冷链档案', text: '档案 编号 说明', city: '杭州' },
  { doc_id: 'doc-006', title: '专用备件', text: '无关内容', city: '上海' },
]);

/** A later snapshot in which a different document ranks first. */
const CORPUS_NEXT = bundle([
  { doc_id: 'doc-001', title: '压缩机保养', text: '冷库压缩机 保养 步骤', city: '杭州' },
  { doc_id: 'doc-002', title: '冷链巡检', text: '巡检记录 维修 建议', city: '上海' },
  { doc_id: 'doc-003', title: '冷库巡检', text: '巡检记录 温度 曲线', city: '杭州' },
  { doc_id: 'doc-004', title: '冷链巡检', text: '维修 维修 维修 维修 维修 记录 归档', city: '上海' },
  { doc_id: 'doc-005', title: '杭州冷链档案', text: '档案 编号 说明', city: '杭州' },
  { doc_id: 'doc-006', title: '专用备件', text: '无关内容', city: '上海' },
]);

const CONTRACT = {
  title: '设备文档库',
  fields: [{ name: 'doc_id' }, { name: 'title' }, { name: 'text' }, { name: 'city' }],
  grain: ['doc_id'],
  filters: ['city'],
  limit: { default: 10, max: 100 },
  search: {
    text_field: 'text',
    title_field: 'title',
    suggest_fields: ['title', 'city'],
    ranking: { kind: 'weighted_term_frequency', title_weight: 3, text_weight: 1 },
    max_terms: 8,
    min_term_length: 1,
  },
};

const DEFAULT_LIMITS = {
  max_bytes: 8388608,
  max_documents: 5000,
  max_text_chars: 200000,
  max_metadata_fields: 64,
  max_worker_ms: 5000,
  max_heap_mb: 128,
};

const TIGHT_LIMITS = {
  max_bytes: 2048,
  max_documents: 2,
  max_text_chars: 64,
  max_metadata_fields: 8,
  max_worker_ms: 5000,
  max_heap_mb: 64,
};

interface DocumentSource {
  fixture: PlatformFixture;
  workspaceId: string;
  sourceId: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
}

/** One document Source inside an existing Workspace. */
function documentSourceOn(
  context: WorkspaceFixture,
  name: string,
  limits: Record<string, unknown> = {},
): DocumentSource {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = context;
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', name, '--type', 'document'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const configuration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `document-integration-${name}`, {
      identity: ['doc_id'],
      schema: SCHEMA,
      cleaning: [{ rule: 'trim', field: 'doc_id' }],
      mapping: { doc_id: 'doc_id', title: 'title', text: 'text', city: 'city' },
      ...(Object.keys(limits).length === 0 ? {} : { document_limits: limits }),
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(configuration.status, 0, configuration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(configuration.output.integration_configuration_version)],
    { token: workspaceAdministratorToken },
  );
  return { fixture, workspaceId, sourceId, workspaceAdministratorToken, consumerToken };
}

function documentSource(limits: Record<string, unknown> = {}): DocumentSource {
  return documentSourceOn(workspaceFixture(), '设备文档库', limits);
}

function upload(fixture: PlatformFixture, token: string, sourceId: string, content: string): Record<string, unknown> {
  const result = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, `bundle-${Date.now()}-${Math.random()}.json`, content)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function release(fixture: PlatformFixture, token: string, sourceId: string): void {
  const result = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
}

function releaseFailure(fixture: PlatformFixture, token: string, sourceId: string): string {
  const result = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(result.status, 2, `expected a structured refusal, got ${result.stdout}`);
  return String(result.error.code);
}

/** Publishes one more Integration Configuration Version, quarantining earlier Batches. */
function republishIntegration(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  versionName: string,
): void {
  const configuration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `document-integration-${versionName}`, {
      identity: ['doc_id'],
      schema: SCHEMA,
      cleaning: [{ rule: 'trim', field: 'doc_id' }],
      mapping: { doc_id: 'doc_id', title: 'title', text: 'text', city: 'city' },
    })],
    { token },
  );
  assert.equal(configuration.status, 0, configuration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(configuration.output.integration_configuration_version)],
    { token },
  );
}

function publishProduct(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  contract: unknown = CONTRACT,
  name = '设备文档库',
): Record<string, unknown> {
  const result = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', name, '--contract', jsonFile(fixture, 'document-contract', contract)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

interface SearchResponse {
  kind: string;
  data_product_release: number;
  columns: string[];
  records: Array<Record<string, unknown>>;
  matched_count: number;
  returned: number;
  truncated: boolean;
  next_cursor: string | null;
  query: { terms: string[]; text_field: string };
  ranking: { kind: string; title_weight: number; text_weight: number };
  provenance: { dataset_release: number; integration_configuration_version: number };
}

interface SuggestResponse {
  kind: string;
  suggestions: Array<{ value: string; count: number }>;
  returned: number;
}

function search(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): SearchResponse {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'document-search', { include_totals: true, ...request })],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as SearchResponse;
}

function suggest(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): SuggestResponse {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'document-suggest', request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as SuggestResponse;
}

function queryFailure(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): string {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'document-refusal', request)],
    { token },
  );
  assert.equal(result.status, 2, `expected a structured refusal, got ${result.stdout}`);
  return String(result.error.code);
}

function readyProduct(): DocumentSource & { productId: string } {
  const ready = documentSource();
  upload(ready.fixture, ready.workspaceAdministratorToken, ready.sourceId, CORPUS);
  release(ready.fixture, ready.workspaceAdministratorToken, ready.sourceId);
  const product = publishProduct(ready.fixture, ready.workspaceAdministratorToken, ready.sourceId);
  return { ...ready, productId: String(product.data_product_id) };
}

test('documents are parsed in isolated resource-limited workers and never executed as active content', () => {
  const context = workspaceFixture();
  const tight = TIGHT_LIMITS;

  // Active content is refused before anything is interpreted: a document is
  // never rendered, so an HTML payload has no governed meaning here.
  const active = documentSourceOn(context, '网页抓取', tight);
  upload(active.fixture, active.workspaceAdministratorToken, active.sourceId, '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
  assert.equal(releaseFailure(active.fixture, active.workspaceAdministratorToken, active.sourceId), 'DOCUMENT_CONTENT_REFUSED');

  // A bundle that declares a rendering format is refused rather than rendered.
  const rendered = documentSourceOn(context, '渲染格式', tight);
  upload(rendered.fixture, rendered.workspaceAdministratorToken, rendered.sourceId, bundle([{ doc_id: 'd1', title: '标题', text: '正文' }], 'html'));
  assert.equal(releaseFailure(rendered.fixture, rendered.workspaceAdministratorToken, rendered.sourceId), 'DOCUMENT_FORMAT_REFUSED');

  // Nothing is evaluated: a formula is a refused key, not an expression.
  const formula = documentSourceOn(context, '公式文档', tight);
  upload(formula.fixture, formula.workspaceAdministratorToken, formula.sourceId, bundle([{ doc_id: 'd1', text: '正文', formula: 'SUM(A1:A9)' }]));
  assert.equal(releaseFailure(formula.fixture, formula.workspaceAdministratorToken, formula.sourceId), 'DOCUMENT_CONTENT_REFUSED');

  // Every declared limit fails closed with its own structured error.
  const oversized = documentSourceOn(context, '超长文档', tight);
  upload(oversized.fixture, oversized.workspaceAdministratorToken, oversized.sourceId, bundle([
    { doc_id: 'd1', title: '标题', text: 'x'.repeat(3000), city: '杭州' },
  ]));
  assert.equal(releaseFailure(oversized.fixture, oversized.workspaceAdministratorToken, oversized.sourceId), 'DOCUMENT_CONTENT_TOO_LARGE');

  const many = documentSourceOn(context, '批量文档', tight);
  upload(many.fixture, many.workspaceAdministratorToken, many.sourceId, bundle([
    { doc_id: 'd1', title: '标题', text: '正文' },
    { doc_id: 'd2', title: '标题', text: '正文' },
    { doc_id: 'd3', title: '标题', text: '正文' },
  ]));
  assert.equal(releaseFailure(many.fixture, many.workspaceAdministratorToken, many.sourceId), 'DOCUMENT_BUNDLE_TOO_LARGE');

  const longText = documentSourceOn(context, '长正文', tight);
  upload(longText.fixture, longText.workspaceAdministratorToken, longText.sourceId, bundle([
    { doc_id: 'd1', title: '标题', text: '正文'.repeat(40) },
  ]));
  assert.equal(releaseFailure(longText.fixture, longText.workspaceAdministratorToken, longText.sourceId), 'DOCUMENT_TEXT_TOO_LARGE');

  // A well-formed bundle under the same limits still publishes, and the Release
  // records the parser and the exact resource envelope it ran under.
  const accepted = documentSourceOn(context, '合规文档', tight);
  upload(accepted.fixture, accepted.workspaceAdministratorToken, accepted.sourceId, bundle([
    { doc_id: 'd1', title: '标题', text: '正文' },
  ]));
  release(accepted.fixture, accepted.workspaceAdministratorToken, accepted.sourceId);
  const shown = command(accepted.fixture, ['dataset', 'show', '--source', accepted.sourceId], { token: accepted.workspaceAdministratorToken });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.output['document_processing'], {
    parser: { name: 'document-bundle', version: 1 },
    limits: tight,
  });

  // The worker is time-boxed: a parse that overruns its declared budget fails
  // closed instead of holding the request open.
  const timed = documentSourceOn(context, '超时文档', { ...tight, max_worker_ms: 1 });
  upload(timed.fixture, timed.workspaceAdministratorToken, timed.sourceId, bundle([
    { doc_id: 'd1', title: '标题', text: '正文' },
  ]));
  assert.equal(releaseFailure(timed.fixture, timed.workspaceAdministratorToken, timed.sourceId), 'DOCUMENT_PARSE_TIMEOUT');
});

test('a curated document keeps its extracted text, metadata, Raw Acquisition reference, and exact processing Provenance', () => {
  const { fixture, sourceId, workspaceAdministratorToken, consumerToken } = documentSource();
  const uploaded = upload(fixture, workspaceAdministratorToken, sourceId, CORPUS);
  release(fixture, workspaceAdministratorToken, sourceId);

  const rawId = String((uploaded['raw_acquisition'] as Record<string, unknown>)['raw_id']);
  const batchId = String((uploaded['integration_batch'] as Record<string, unknown>)['batch_id']);
  const runId = String(uploaded['acquisition_run_id']);

  const shown = command(fixture, ['dataset', 'show', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(shown.status, 0, shown.stderr);
  const records = shown.output['records'] as Array<Record<string, unknown>>;
  assert.equal(records.length, 6);
  const first = records.find((record) => (record['values'] as Record<string, unknown>)['doc_id'] === 'doc-001');
  assert.ok(first, 'the curated document is stored under its stable identity');
  assert.equal((first!['values'] as Record<string, unknown>)['text'], '冷库压缩机 维修 步骤');
  assert.equal((first!['values'] as Record<string, unknown>)['title'], '压缩机维修');
  assert.equal((first!['values'] as Record<string, unknown>)['city'], '杭州');
  assert.deepEqual(first!['raw'], { raw_id: rawId, locator: 'document[1]' });

  const provenance = shown.output['provenance'] as Record<string, unknown>;
  assert.deepEqual(provenance['batch_ids'], [batchId]);
  assert.deepEqual(provenance['acquisition_run_ids'], [runId]);
  assert.deepEqual(provenance['raw_acquisition_ids'], [rawId]);
  assert.equal(typeof provenance['acquired_at'], 'string');
  assert.equal(typeof provenance['integrated_at'], 'string');
  assert.equal(typeof provenance['released_at'], 'string');
  assert.equal(shown.output['integration_configuration_version'], 1);
  assert.equal(typeof shown.output['schema_hash'], 'string');
  assert.deepEqual(shown.output['document_processing'], {
    parser: { name: 'document-bundle', version: 1 },
    limits: DEFAULT_LIMITS,
  });

  // A Consumer retrieves the curated text and metadata, never the Raw
  // Acquisition or the processing internals behind them.
  const product = publishProduct(fixture, workspaceAdministratorToken, sourceId);
  const retrieved = command(
    fixture,
    ['product', 'query', '--product', String(product['data_product_id']), '--request', jsonFile(fixture, 'document-records', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(retrieved.status, 0, retrieved.stderr);
  const exposed = retrieved.output['records'] as Array<Record<string, unknown>>;
  assert.deepEqual(exposed[0], { doc_id: 'doc-001', title: '压缩机维修', text: '冷库压缩机 维修 步骤', city: '杭州' });
  const serialized = JSON.stringify(retrieved.output);
  assert.equal(serialized.includes(rawId), false, 'a Consumer never sees a Raw Acquisition');
  assert.equal(serialized.includes('raw-acquisitions'), false, 'a Consumer never sees a raw object locator');
});

test('a Document Contract declares search and returns deterministic ranking with release-pinned pagination', () => {
  const { fixture, sourceId, workspaceAdministratorToken, consumerToken, productId } = readyProduct();

  const first = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 2 });
  assert.equal(first.kind, 'search');
  assert.equal(first.data_product_release, 1);
  assert.deepEqual(first.query.terms, ['维修']);
  assert.equal(first.query.text_field, 'text');
  assert.deepEqual(first.ranking, { kind: 'weighted_term_frequency', title_weight: 3, text_weight: 1 });
  assert.deepEqual(first.records.map((record) => record['doc_id']), ['doc-001', 'doc-002']);
  assert.equal(first.matched_count, 3);
  assert.equal(first.returned, 2);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.next_cursor, 'string');

  // The ranking is a total order: score first, then the Contract's grain.
  const whole = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 100 });
  assert.deepEqual(whole.records.map((record) => record['doc_id']), ['doc-001', 'doc-002', 'doc-004']);
  assert.ok(Number(whole.records[0]!['score']) > Number(whole.records[1]!['score']));
  assert.equal(whole.records[1]!['score'], whole.records[2]!['score'], 'equal scores are ordered by the grain');
  assert.deepEqual(whole.records[0]!['matched_terms'], ['维修']);

  const again = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 100 });
  assert.deepEqual(again.records, whole.records, 'the same query over the same Release never reorders');

  const second = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 1, cursor: first.next_cursor });
  assert.deepEqual(second.records.map((record) => record['doc_id']), ['doc-004']);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, null);

  // Suggestions are the same governed search, offered as a prefix.
  const suggestions = suggest(fixture, consumerToken, productId, { kind: 'suggest', q: '巡', limit: 5 });
  assert.deepEqual(suggestions.suggestions.map((entry) => entry.value), ['巡检']);
  assert.equal(suggestions.returned, 1);

  // A later Release may not shift a page that a cursor already opened: the
  // cursor names the Data Product Release it walks.
  upload(fixture, workspaceAdministratorToken, sourceId, CORPUS_NEXT);
  release(fixture, workspaceAdministratorToken, sourceId);
  const republished = publishProduct(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(republished['data_product_release'], 2);

  const stillFirstRelease = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 2, cursor: first.next_cursor });
  assert.equal(stillFirstRelease.data_product_release, 1);
  assert.deepEqual(stillFirstRelease.records.map((record) => record['doc_id']), ['doc-004']);

  const current = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 100 });
  assert.equal(current.data_product_release, 2);
  assert.deepEqual(current.records.map((record) => record['doc_id']), ['doc-004', 'doc-002']);

  // Naming another Release than the cursor's is still a refusal, never a jump.
  assert.equal(
    queryFailure(fixture, consumerToken, productId, { kind: 'search', q: '维修', release: 2, cursor: first.next_cursor }),
    'DATA_PRODUCT_QUERY_CURSOR_INVALID',
  );

  // A Contract that publishes no search cannot answer one.
  const plain = publishProduct(fixture, workspaceAdministratorToken, sourceId, { ...CONTRACT, search: undefined }, '设备台账查询');
  assert.equal(
    queryFailure(fixture, consumerToken, String(plain['data_product_id']), { kind: 'search', q: '维修' }),
    'DATA_PRODUCT_QUERY_REFUSED',
  );
});

test('Grants narrow document content and search suggestions exactly as they narrow records', () => {
  const { fixture, sourceId, workspaceAdministratorToken, consumerToken, productId } = readyProduct();

  // The Workspace baseline sees every document the Release holds.
  assert.equal(search(fixture, consumerToken, productId, { kind: 'search', q: '维修' }).matched_count, 3);

  const rowGrant = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(fixture, 'grant-rows', {
      row_filters: [{ field: 'city', op: 'equals', value: '上海' }],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(rowGrant.status, 0, rowGrant.stderr);

  const narrowed = search(fixture, consumerToken, productId, { kind: 'search', q: '维修' });
  assert.deepEqual(narrowed.records.map((record) => record['doc_id']), ['doc-002', 'doc-004']);
  assert.equal(narrowed.matched_count, 2);

  // A suggestion drawn only from the rows a Grant hides is never offered.
  assert.deepEqual(suggest(fixture, consumerToken, productId, { kind: 'suggest', q: '杭' }).suggestions, []);
  assert.deepEqual(
    suggest(fixture, consumerToken, productId, { kind: 'suggest', q: '巡' }).suggestions.map((entry) => entry.value),
    ['巡检'],
  );

  const columnGrant = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(fixture, 'grant-columns', {
      columns: ['doc_id', 'text'],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(columnGrant.status, 0, columnGrant.stderr);

  // A hidden column neither appears in a result nor influences its ranking.
  const hidden = search(fixture, consumerToken, productId, { kind: 'search', q: '维修' });
  assert.deepEqual(hidden.columns, ['doc_id', 'text']);
  assert.deepEqual(Object.keys(hidden.records[0]!).sort(), ['doc_id', 'matched_terms', 'score', 'text']);
  assert.equal(search(fixture, consumerToken, productId, { kind: 'search', q: '备件' }).matched_count, 0);
  assert.deepEqual(suggest(fixture, consumerToken, productId, { kind: 'suggest', q: '备' }).suggestions, []);

  // Revoking the column Grant restores the columns, and only the columns.
  const revokedColumns = command(
    fixture,
    ['grant', 'revoke', '--grant', String(columnGrant.output['grant_id'])],
    { token: workspaceAdministratorToken },
  );
  assert.equal(revokedColumns.status, 0, revokedColumns.stderr);
  assert.equal(search(fixture, consumerToken, productId, { kind: 'search', q: '备件' }).matched_count, 1);

  // Revoking the row Grant widens the rows again, and only the rows.
  const revoked = command(fixture, ['grant', 'revoke', '--grant', String(rowGrant.output['grant_id'])], { token: workspaceAdministratorToken });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(search(fixture, consumerToken, productId, { kind: 'search', q: '维修' }).matched_count, 3);
  assert.deepEqual(
    suggest(fixture, consumerToken, productId, { kind: 'suggest', q: '杭' }).suggestions.map((entry) => entry.value),
    ['杭州', '杭州冷链档案'],
  );
  assert.deepEqual(
    Object.keys(search(fixture, consumerToken, productId, { kind: 'search', q: '维修' }).records[0]!).sort(),
    ['city', 'doc_id', 'matched_terms', 'score', 'text', 'title'],
  );

  // Searching a column a Grant withholds is refused, never silently widened.
  const textGrant = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(fixture, 'grant-text', {
      columns: ['doc_id'],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(textGrant.status, 0, textGrant.stderr);
  assert.equal(
    queryFailure(fixture, consumerToken, productId, { kind: 'search', q: '维修' }),
    'DATA_PRODUCT_QUERY_REFUSED',
  );

  // Another Workspace reads the same refusal an absent Data Product answers with.
  const deploymentAdministratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, deploymentAdministratorToken, 'outsider@example.invalid', 'outsider-administrator');
  createWorkspace(fixture, deploymentAdministratorToken, '隔离区', 'outsider@example.invalid');
  const outsiderToken = sessionFor(fixture, 'outsider@example.invalid', 'outsider-administrator');
  assert.equal(
    queryFailure(fixture, outsiderToken, productId, { kind: 'search', q: '维修' }),
    'DATA_PRODUCT_NOT_AVAILABLE',
  );
});

test('a parser failure never publishes curated documents or replaces the last valid Release', () => {
  const { fixture, sourceId, workspaceAdministratorToken, consumerToken, productId } = readyProduct();

  const before = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 100 });
  assert.deepEqual(before.records.map((record) => record['doc_id']), ['doc-001', 'doc-002', 'doc-004']);

  // A malformed bundle is stored as opaque bytes and fails at integration.
  upload(fixture, workspaceAdministratorToken, sourceId, '{"format":"text","documents":[{"doc_id":"doc-009",');
  assert.equal(releaseFailure(fixture, workspaceAdministratorToken, sourceId), 'DOCUMENT_SHAPE_INVALID');

  const unchanged = command(fixture, ['dataset', 'show', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.output['dataset_release'], 1, 'a failed parse never appends a Release');
  assert.equal((unchanged.output['records'] as unknown[]).length, 6);

  // The last valid Release stays queryable, unchanged.
  assert.deepEqual(search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 100 }).records, before.records);
  const stillListed = command(fixture, ['product', 'releases', '--product', productId], { token: consumerToken });
  assert.equal(stillListed.status, 0, stillListed.stderr);
  assert.deepEqual((stillListed.output['releases'] as Array<Record<string, unknown>>).map((entry) => entry['release']), [1]);

  // Publishing a corrected Integration Configuration Version quits the failed
  // Batch, so the next good acquisition releases exactly the next snapshot.
  republishIntegration(fixture, workspaceAdministratorToken, sourceId, 'corrected');
  upload(fixture, workspaceAdministratorToken, sourceId, CORPUS_NEXT);
  release(fixture, workspaceAdministratorToken, sourceId);
  const recovered = command(fixture, ['dataset', 'show', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.output['dataset_release'], 2);
});

test('the document surface adds no browser copy and keeps its API contracts and governed values ASCII', () => {
  const { fixture, consumerToken, productId } = readyProduct();

  const answered = search(fixture, consumerToken, productId, { kind: 'search', q: '维修' });
  const governed = JSON.stringify(answered);
  for (const value of ['doc-001', 'doc-002', 'doc-004']) {
    assert.equal(governed.includes(value), true, `${value} is a governed value, never translated`);
  }
  assert.match(answered.ranking.kind, /^[a-z][a-z0-9_]*$/);
  assert.deepEqual(answered.columns, ['doc_id', 'title', 'text', 'city']);

  // Every refusal this ticket adds is a stable ASCII code, so an API or MCP
  // consumer reads the same contract the CLI does.
  for (const request of [
    { kind: 'search', q: '' },
    { kind: 'search', q: '维修', sql: 'SELECT * FROM documents' },
    { kind: 'search', q: '维修', limit: 101 },
  ]) {
    assert.match(queryFailure(fixture, consumerToken, productId, request), /^[A-Z][A-Z0-9_]*$/);
  }

  // The ticket introduces no new CLI command and therefore no new browser copy:
  // document search is served by the existing `product query` verb.
  const grouped = command(fixture, ['document', 'search', '--product', productId], { token: consumerToken });
  assert.equal(grouped.status, 2);
  assert.equal(grouped.error['code'], 'INVALID_COMMAND');
});

/** A suggestion is a bounded top-N list, so a page cursor is refused rather than replayed. */
test('a suggestion refuses a page cursor instead of replaying its first page', () => {
  const { fixture, consumerToken, productId } = readyProduct();
  const first = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 2 });
  assert.equal(typeof first.next_cursor, 'string');

  // Even a cursor this Release itself issued is not a suggestion cursor.
  assert.equal(
    queryFailure(fixture, consumerToken, productId, { kind: 'suggest', q: '巡', cursor: first.next_cursor }),
    'DATA_PRODUCT_QUERY_CURSOR_NOT_SUPPORTED',
  );

  // The same cursor still walks the search page it was issued for.
  const second = search(fixture, consumerToken, productId, { kind: 'search', q: '维修', limit: 2, cursor: first.next_cursor });
  assert.equal(second.returned, 1);
  assert.equal(second.next_cursor, null);
});
