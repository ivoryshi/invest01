import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { industrySaveMethod } from '../apps/web/industry-state.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._value = ''; this.attrs = {}; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get options() { return this.children; }
  append(...items) { for (const n of items) n.parent = this; this.children.push(...items); if (this.tag === 'select' && this.children.length === items.length) this.value = items[0]?.value ?? ''; }
  replaceChildren(...items) { this.children = []; this.value = ''; this.append(...items); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  setAttribute(key, value) { this.attrs[key] = value; }
  scrollIntoView() {}
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  async fire(type) { for (const cb of this.listeners[type] || []) await cb({ preventDefault() {} }); }
}
const walk = n => [n, ...n.children.flatMap(walk)];
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const extracted = source.slice(source.indexOf('async function customExpressionPanel('), source.indexOf('async function customFactorStudioPanel('));
async function fixture() {
  const spec = { dialect: 'industry_expression_v1', bindings: { price: 'close' }, nodes: [{ id: 'momentum', expression: 'pct_change(price, 21)', definition: '<unsafe> retained as text', direction: 'higher_is_better', weight: 1 }], missingValuePolicy: 'complete_case', normalization: 'cross_section_zscore_clip_3' };
  const family = { factorFamilyId: 'library.custom.test', title: 'Test', revision: 1, executionSpec: spec, executionSha256: 'old', usageLogic: 'boundary', researchNotes: 'source' };
  let families = [{ ...family, program: { factorFamilyId: family.factorFamilyId, revision: 2, executionSpec: spec, executionSha256: 'new' } }];
  const template = { strategyTemplateId: 'strategy.custom_industry_expression', title: 'strategy', snapshotId: 'current', costModel: 'commission=0;slippage=0;annual_fee=0', strategySettings: { startDate: '2025-01-02', endDate: '2026-07-30', topN: 3, minInvestable: 8, signalLagDays: 1, missingValuePolicy: 'complete_case', weightingMethod: 'equal_weight' } };
  const old = { ...template, configId: 'config.existing', revision: 1, strategySettings: { ...template.strategySettings, factorProgram: { factorFamilyId: family.factorFamilyId, revision: 1, executionSpec: spec, executionSha256: 'old' } } };
  const configs = { templates: [template], items: [old] }, writes = [];
  let delay = null;
  const element = (tag, text) => { const n = new Node(tag); n.textContent = text; return n; }, option = (value, text) => { const n = element('option', text); n.value = value; return n; };
  const context = vm.createContext({ document: { createElement: t => new Node(t) }, element, option, industrySaveMethod,
    editExpressionFactor: null, editExpressionConfig: null, fmtNum: x => String(x), refreshFactorExecution: async () => {}, resultDiagnosticTable: (title, labels, rows) => { const n = element('table', title); n.rows = rows; return n; },
    populateSnapshotSelect: async s => s.append(option('current', 'current')),
    fetch: async (url, init) => {
      if (delay) { const p = delay; delay = null; await p; }
      const body = init && JSON.parse(init.body); let data;
      if (body) {
        writes.push({ url, method: init.method, body });
        if (url.endsWith('/validate')) data = { executionSha256: 'hash', evaluationOrder: ['momentum'], dependencies: { momentum: ['price'] } };
        else if (url.endsWith('/preview')) data = { previewDate: '2026-07-30', ranked: [{ code: 'a', score: 1, factorDetails: [{ field: 'momentum', contribution: 1 }] }] };
        else { data = { item: { ...body, revision: 2 } }; if (url.includes('/experiment-configs')) { configs.items = configs.items.filter(x => x.configId !== body.configId); configs.items.push(data.item); } else { families = [...families.filter(x => x.factorFamilyId !== body.factorFamilyId), { ...body, program: { factorFamilyId: body.factorFamilyId, revision: 2, executionSha256: 'saved', executionSpec: body.executionSpec } }]; } }
      } else if (url.endsWith('/options')) data = { fields: [{ field: 'close', name: 'price', definition: 'index' }], defaultSpec: spec, families };
      else if (url.includes('/library/submissions/')) data = { item: family };
      else data = configs;
      return { ok: true, json: async () => data };
    } });
  vm.runInContext(`${extracted}; globalThis.panel = customExpressionPanel`, context);
  const root = await context.panel(), forms = walk(root).filter(n => n.tag === 'form');
  return { root, forms, context, writes, fields: form => Object.fromEntries(walk(form).filter(n => n.name).map(n => [n.name, n])),
    button: text => walk(root).find(n => n.tag === 'button' && n.textContent === text),
    hold() { let resolve; delay = new Promise(r => { resolve = r; }); return resolve; } };
}
test('native expression definition preserves all structured fields and POST then PUT identity', async () => {
  const f = await fixture(), form = f.forms[0];
  await form.fire('submit'); await form.fire('submit');
  assert.equal(f.writes[0].method, 'POST'); assert.equal(f.writes[1].method, 'PUT');
  assert.equal(f.writes[0].body.fields[0].definition, '<unsafe> retained as text');
  assert.equal(f.writes[0].body.executionSpec.nodes.length, 1);
  assert.equal(f.writes[0].body.fields[0].missingValuePolicy, 'complete_case');
  assert.ok(!extracted.includes('innerHTML'));
});
test('config saves captured older program, only explicit factor selection upgrades revision', async () => {
  const f = await fixture(); await f.context.editExpressionConfig({ configId: 'config.existing' });
  await f.forms[1].fire('submit'); assert.equal(f.writes[0].method, 'PUT');
  assert.equal(f.writes[0].body.strategySettings.factorProgram.executionSha256, 'old');
  const field = f.fields(f.forms[1]).family;
  assert.ok(field.options.some(x => x.value === field.value && x.textContent.includes('r1')));
  const latest = field.options.find(x => x.textContent === 'Test · r2');
  assert.notEqual(latest.value, field.value);
  field.value = latest.value; await field.fire('change');
  await f.forms[1].fire('submit'); assert.equal(f.writes[1].body.strategySettings.factorProgram.revision, 2);
});
test('historical binding survives switching to latest or unbound and back', async () => {
  const f = await fixture(); await f.context.editExpressionConfig({ configId: 'config.existing' });
  const field = f.fields(f.forms[1]).family, historical = field.value;
  field.value = field.options.find(x => x.textContent === 'Test · r2').value; await field.fire('change');
  field.value = historical; await field.fire('change');
  await f.forms[1].fire('submit'); assert.equal(f.writes[0].body.strategySettings.factorProgram.revision, 1);
  field.value = ''; await field.fire('change'); field.value = historical; await field.fire('change');
  await f.forms[1].fire('submit'); assert.equal(f.writes[1].body.strategySettings.factorProgram.executionSha256, 'old');
});
test('unbound strategy never writes, same-date preview stays separate from result assets', async () => {
  const f = await fixture(); await f.forms[1].fire('submit'); assert.equal(f.writes.length, 0);
  const field = f.fields(f.forms[1]).family; field.value = field.options.find(x => x.textContent === 'Test · r2').value; await field.fire('change');
  await f.button('试算因子定位').fire('click');
  assert.equal(f.writes.length, 1); assert.ok(f.writes[0].url.endsWith('/preview'));
  assert.ok(walk(f.root).some(n => n.textContent === '2026-07-30 · 同日横截面试算（非执行信号）'));
});
test('pending loads lock writes and new actions rather than resurrect prior draft', async () => {
  const f = await fixture(), release = f.hold(), loading = f.context.editExpressionConfig({ configId: 'config.existing' });
  assert.equal(walk(f.forms[1]).find(n => n.tag === 'fieldset').disabled, true);
  await f.forms[1].fire('submit'); await f.button('新建公式策略').fire('click'); assert.equal(f.writes.length, 0);
  release(); await loading; assert.equal(f.fields(f.forms[1]).configId.value, 'config.existing');
});
test('definition query restores editable structured nodes and blocks duplicate asynchronous saves', async () => {
  const f = await fixture(); await f.context.editExpressionFactor({ factorFamilyId: 'library.custom.test' });
  const release = f.hold(), saving = f.forms[0].fire('submit');
  await f.forms[0].fire('submit'); await f.button('新增指标').fire('click');
  release(); await saving;
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].method, 'PUT'); assert.equal(f.writes[0].body.executionSpec.nodes.length, 1);
});
