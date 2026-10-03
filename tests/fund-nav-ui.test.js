import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { industrySaveMethod } from '../apps/web/industry-state.js';
import { isCurrentFundEdit } from '../apps/web/fund-screen-state.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._value = ''; this.attrs = {}; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  append(...items) { this.children.push(...items); if (this.tag === 'select' && this.children.length === items.length) this.value = items[0]?.value ?? ''; }
  replaceChildren(...items) { this.children = []; this.value = ''; this.append(...items); }
  setAttribute(key, value) { this.attrs[key] = value; }
  scrollIntoView() {}
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  async fire(type, event = {}) { for (const cb of this.listeners[type] || []) await cb({ preventDefault() {}, ...event }); }
  click() { return this.fire('click'); }
}
const descendants = n => [n, ...n.children.flatMap(descendants)];
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const panelSource = source.slice(source.indexOf('async function fundNavConfigPanel('), source.indexOf('async function strategyConfigWorkbenchPanel('));
const api = await readFile(new URL('../apps/api/server.js', import.meta.url), 'utf8');
const defaults = vm.runInNewContext(`${api.slice(api.indexOf('const fundNavSettings = '), api.indexOf('function fundNavRoot('))}; fundNavSettings`);

async function fixture() {
  const binding = [{ sourceId: 'nav.000001', sha256: 'abc', bytes: 4 }];
  const template = { title: 'fund', strategyTemplateId: 'strategy.fund_nav_fixed_dca', benchmarkId: 'CSI300', strategySettings: defaults, costModel: 'subscription=0;slippage=0' };
  const configs = { templates: [template], items: ['a', 'b'].map(x => ({ ...template, configId: `config.${x}`, revision: 1, strategySettings: { ...defaults, shares: [{ shareCode: '000001', weight: 1 }], sourceVersions: binding } })) };
  const profile = { sourceVersions: binding, commonStartDate: '2025-06-17', commonEndDate: '2026-07-31', commonObservations: 266,
    adjustmentMethod: 'self_calc', benchmark: { id: 'CSI300', kind: 'total' }, funds: [] };
  let delayedRead = null, delayedProfile = null, delayedWrite = null; const writes = [], gets = [];
  const element = (tag, text) => { const n = new Node(tag); n.textContent = text; return n; };
  const option = (value, text) => { const n = element('option', text); n.value = value; return n; };
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, element, option, industrySaveMethod, isCurrentFundEdit, URLSearchParams,
    editFundNavConfig: null, refreshFactorExecution: async () => {}, resultDiagnosticTable: () => new Node('table'),
    fetch: async (url, init) => {
      if (init) { const body = JSON.parse(init.body); writes.push({ url, method: init.method, body }); if (delayedWrite) { const pending = delayedWrite; delayedWrite = null; await pending.promise; } return { ok: true, json: async () => ({ item: { configId: body.configId, revision: 2 } }) }; }
      gets.push(url);
      if (url.includes('/catalog')) return { ok: true, json: async () => ({ defaults, benchmarks: ['CSI300','CSI500'], items: [], hasMore: false }) };
      if (url.includes('/profile')) { if (delayedProfile) { const pending = delayedProfile; delayedProfile = null; await pending.promise; } return { ok: true, json: async () => profile }; }
      if (delayedRead) { const pending = delayedRead; delayedRead = null; await pending.promise; }
      return { ok: true, json: async () => configs };
    },
  });
  vm.runInContext(`${panelSource}; globalThis.createPanel = fundNavConfigPanel`, context);
  const panel = await context.createPanel(), nodes = descendants(panel), form = nodes.find(n => n.tag === 'form');
  const fields = Object.fromEntries(nodes.filter(n => n.name).map(n => [n.name,n]));
  const button = text => nodes.find(n => n.tag === 'button' && n.textContent === text);
  const manual = nodes.find(n => n.attrs['aria-label'] === '手动基金份额代码');
  return { context, form, fields, nodes, writes, gets, manual, binding, submit: button('保存基金历史配置'), read: button('读取数据库净值与基准'), fresh: button('新建配置'), add: button('加入篮子'),
    delayRead() { delayedRead = deferred(); return delayedRead; }, delayProfile() { delayedProfile = deferred(); return delayedProfile; }, delayWrite() { delayedWrite = deferred(); return delayedWrite; } };
}

test('new fund form cannot save without DB source binding, profile enables POST', async () => {
  const f = await fixture(); assert.equal(f.fields.savedConfig.required, false); assert.equal(f.submit.disabled, true);
  await f.form.fire('submit'); assert.equal(f.writes.length, 0);
  f.manual.value = '000001'; await f.add.click(); await f.read.click(); await f.form.fire('submit');
  assert.equal(f.writes[0].method, 'POST'); assert.deepEqual(f.writes[0].body.strategySettings.sourceVersions, f.binding);
  assert.equal(f.writes[0].body.strategySettings.startDate, '2025-06-17');
});
test('profile arriving after benchmark change cannot restore stale binding', async () => {
  const f = await fixture(); f.manual.value = '000001'; await f.add.click();
  const delay = f.delayProfile(), reading = f.read.click();
  f.fields.benchmarkId.value = 'CSI500'; await f.fields.benchmarkId.fire('change');
  delay.resolve(); await reading; await f.form.fire('submit'); assert.equal(f.writes.length, 0); assert.equal(f.submit.disabled, true);
});
test('draft load blocks previous writes and basket changes; fresh cancels late response', async () => {
  const f = await fixture(); await f.context.editFundNavConfig({ configId: 'config.a' });
  const delay = f.delayRead(), loading = f.context.editFundNavConfig({ configId: 'config.b' });
  assert.equal(f.submit.disabled, true); f.manual.value = '000002'; await f.add.click(); await f.form.fire('submit'); assert.equal(f.writes.length, 0);
  await f.fresh.click(); const id = f.fields.configId.value; delay.resolve(); await loading;
  assert.equal(f.fields.configId.value, id); assert.equal(f.submit.disabled, true);
});
test('existing metadata edit preserves DB binding, changed ID saves separate POST', async () => {
  const f = await fixture(); await f.context.editFundNavConfig({ configId: 'config.a' });
  f.fields.title.value = 'updated'; await f.form.fire('submit'); assert.equal(f.writes[0].method, 'PUT');
  assert.deepEqual(f.writes[0].body.strategySettings.sourceVersions, f.binding);
  f.fields.configId.value = 'config.copy'; await f.form.fire('submit'); assert.equal(f.writes[1].method, 'POST');
});
test('Enter in manual code is a basket action, not form submission', async () => {
  const f = await fixture(); let prevented = false; f.manual.value = '000001';
  await f.manual.fire('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.writes.length, 0); await f.read.click(); await f.form.fire('submit'); assert.equal(f.writes.length, 1);
});
test('save completion distinguishes submitted version from later unsaved parameter edits', async () => {
  const f = await fixture(); await f.context.editFundNavConfig({ configId: 'config.a' });
  const delayed = f.delayWrite(), saving = f.form.fire('submit'); f.fields.amount.value = '20000';
  delayed.resolve(); await saving;
  assert.equal(f.writes[0].body.strategySettings.amount, 10000); assert.equal(f.fields.amount.value, '20000');
  assert.ok(f.nodes.some(n => n.textContent === '提交版本已保存；当前表单还有未保存修改。'));
});
test('result source provenance renders either asset or selected source identity', () => {
  assert.match(source, /source\.assetId \|\| source\.sourceId/);
});
test('basket edits during first POST retain created identity for subsequent PUT', async () => {
  const f = await fixture(); f.manual.value = '000001'; await f.add.click(); await f.read.click();
  const delay = f.delayWrite(), saving = f.form.fire('submit');
  f.manual.value = '000002'; await f.add.click(); await f.nodes.find(n => n.textContent === '等权').click(); await f.read.click();
  delay.resolve(); await saving; await f.form.fire('submit');
  assert.equal(f.writes[0].method, 'POST'); assert.equal(f.writes[1].method, 'PUT');
  assert.equal(f.writes[1].body.strategySettings.shares.length, 2);
});
test('fresh during first POST reserves another ID and cannot inherit old save identity', async () => {
  const f = await fixture(); f.manual.value = '000001'; await f.add.click(); await f.read.click();
  const originalId = f.fields.configId.value, delay = f.delayWrite(), saving = f.form.fire('submit');
  await f.fresh.click(); assert.notEqual(f.fields.configId.value, originalId);
  delay.resolve(); await saving; f.manual.value = '000002'; await f.add.click(); await f.read.click(); await f.form.fire('submit');
  assert.equal(f.writes[1].method, 'POST'); assert.notEqual(f.writes[1].body.configId, originalId);
});
