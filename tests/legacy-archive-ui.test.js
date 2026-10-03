import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Node {
  constructor(tag, text) { this.tag = tag; this.textContent = text; this.children = []; this.listeners = {}; this.value = ''; }
  append(...items) { if (this.tag === 'select' && !this.children.length) this.value = items[0]?.value || ''; this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function legacyArchivePanel('), source.indexOf('async function customExpressionPanel('));
const ids = ['a'.repeat(64), 'b'.repeat(64)];
const list = { items: ids.map(archiveId => ({ archiveId, createdAt: '2026-10-03', recordCount: 25, categories: ['backtest_scenario'] })), errors: [] };
const payload = (title='first', hasMore=true) => ({ total: 25, assets: [{}], hasMore, limitations: ['not all historical runs'],
  items: [{ title, category: 'backtest_scenario', sourcePath: 'out/report.json', jsonPointer: '/base', sourceSha256: 'c'.repeat(64), parameterCompleteness: 'exported_config_only', parameters: { top_n: 3 } }] });
function context(fetch) {
  const c = vm.createContext({ fetch, URLSearchParams, document: { createElement: tag => new Node(tag) }, element: (tag, text) => new Node(tag, text),
    option: (value, text) => Object.assign(new Node('option', text), { value }) });
  vm.runInContext(body, c); return c;
}
const response = data => ({ ok: true, json: async () => data });
test('archive UI queries versions, text and bounded pages as read-only data', async () => {
  const requests = [];
  const c = context(async url => { requests.push(url); return response(url.endsWith('/legacy-archives') ? list : payload()); });
  const panel = await c.legacyArchivePanel(); const nodes = () => walk(panel);
  nodes().find(n => n.textContent === '下一页').listeners.click(); await tick(); assert.match(requests.at(-1), /offset=20/);
  const search = nodes().find(n => n.type === 'search'); search.value = '<script>x</script>';
  nodes().find(n => n.tag === 'form').listeners.submit({ preventDefault() {} }); await tick();
  const params = new URL('http://localhost'+requests.at(-1)).searchParams;
  assert.equal(params.get('q'), search.value); assert.equal(params.get('offset'), '0'); assert.equal(params.get('limit'), '20');
  assert.ok(nodes().some(n => n.textContent?.includes('仅旧结果归档')));
  assert.ok(!body.includes('innerHTML') && !body.includes('iframe'));
});
test('late old-version query cannot replace newer version and pages lock in flight', async () => {
  let resolveOld, defer = false;
  const c = context(async url => {
    if (url.endsWith('/legacy-archives')) return response(list);
    if (defer && url.includes(ids[0])) return new Promise(resolve => { resolveOld = resolve; });
    return response(payload(url.includes(ids[1]) ? 'new version' : 'initial', false));
  });
  const panel = await c.legacyArchivePanel(), nodes = () => walk(panel); defer = true;
  nodes().find(n => n.tag === 'form').listeners.submit({ preventDefault() {} }); await tick();
  assert.ok(nodes().find(n => n.textContent === '下一页').disabled);
  const version = nodes().find(n => n['aria-label'] === '历史归档版本'); version.value = ids[1]; version.listeners.change(); await tick();
  resolveOld(response(payload('stale version'))); await tick();
  assert.ok(nodes().some(n => n.textContent?.includes('new version')));
  assert.ok(!nodes().some(n => n.textContent?.includes('stale version')));
});
test('missing interface and empty/corrupt archive list retain explicit status', async () => {
  const unavailable = await context(async () => ({ ok: false })).legacyArchivePanel();
  assert.ok(walk(unavailable).some(n => n.textContent?.includes('重启工作台服务')));
  const empty = await context(async () => response({ items: [], errors: [{ archiveId: ids[0] }] })).legacyArchivePanel();
  assert.ok(walk(empty).some(n => n.textContent?.includes('清单损坏')));
});
