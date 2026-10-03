import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { industrySaveMethod } from '../apps/web/industry-state.js';
import { isCurrentFundEdit } from '../apps/web/fund-screen-state.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._value = ''; this.isConnected = true; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  append(...items) { this.children.push(...items); if (this.tag === 'select' && this.children.length === items.length) this.value = items[0]?.value ?? ''; }
  replaceChildren(...items) { this.children = []; this.value = ''; this.append(...items); }
  setAttribute() {}
  scrollIntoView() {}
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({ preventDefault() {} }); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../apps/api/server.js', import.meta.url), 'utf8');
const settingsSource = api.slice(api.indexOf('const threeBucketSettings = '), api.indexOf('function threeBucketPythonOptions'));
const defaults = vm.runInNewContext(`${settingsSource}; threeBucketSettings`);
const panelSource = source.slice(source.indexOf('async function threeBucketConfigPanel('), source.indexOf('async function strategyConfigWorkbenchPanel('));

async function fixture() {
  const family = 'library.industry.value';
  const template = { title: 'three bucket', strategyTemplateId: 'strategy.legacy_three_bucket_monthly', snapshotId: 'snapshot.current',
    strategySettings: defaults, costModel: 'commission=.00025;slippage=.0005;annual_fee=0', factorFamilyIds: [family], factorWeights: [{ factorFamilyId: family, weight: 1 }] };
  const items = ['a', 'b'].map(name => ({ ...template, configId: `config.${name}`, title: name, revision: 1 }));
  const configs = { templates: [template], items };
  const writes = [];
  let delayedRead = null, delayedWrite = null;
  const element = (tag, text) => { const node = new Node(tag); node.textContent = text; return node; };
  const option = (value, text) => { const node = element('option', text); node.value = value; return node; };
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, element, option, industrySaveMethod, isCurrentFundEdit,
    refreshThreeBucketSnapshotChoices: null, editThreeBucketConfig: null, refreshFactorExecution: async () => {},
    populateSnapshotSelect: async (select, id) => select.append(option(id, id)),
    fetch: async (url, init) => {
      if (init) {
        const body = JSON.parse(init.body); writes.push({ url, method: init.method, body });
        if (delayedWrite) { const pending = delayedWrite; delayedWrite = null; await pending.promise; }
        return { ok: true, json: async () => ({ item: { configId: body.configId, revision: 2 } }) };
      }
      if (url.endsWith('/options')) return { ok: true, json: async () => ({ defaults, families: [family] }) };
      if (delayedRead) { const pending = delayedRead; delayedRead = null; await pending.promise; }
      return { ok: true, json: async () => configs };
    },
  });
  vm.runInContext(`${panelSource}; globalThis.createPanel = threeBucketConfigPanel`, context);
  const panel = await context.createPanel({ items: [{ factorFamilyId: family, title: 'value' }] });
  const nodes = descendants(panel), form = nodes.find(node => node.tag === 'form');
  const fields = Object.fromEntries(nodes.filter(node => node.name).map(node => [node.name, node]));
  const submit = nodes.find(node => node.type === 'submit'), fresh = nodes.find(node => node.tag === 'button' && node.type === 'button');
  return { context, form, fields, submit, fresh, writes, delayRead() { delayedRead = deferred(); return delayedRead; }, delayWrite() { delayedWrite = deferred(); return delayedWrite; } };
}

test('new three bucket form has no required empty saved selection and uses POST', async () => {
  const f = await fixture();
  assert.equal(f.fields.savedConfig.value, ''); assert.equal(f.fields.savedConfig.required, false);
  assert.ok(descendants(f.form).filter(node => node.required && node.type !== 'checkbox').every(node => node.value !== ''));
  await f.form.fire('submit');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].method, 'POST');
  assert.equal(f.writes[0].body.configId, 'config.three_bucket_manual');
});

test('delayed draft switch blocks writes to the previous configuration', async () => {
  const f = await fixture();
  await f.context.editThreeBucketConfig({ configId: 'config.a' });
  const delay = f.delayRead();
  const switching = f.context.editThreeBucketConfig({ configId: 'config.b' });
  f.fields.title.value = 'intended for b';
  assert.equal(f.submit.disabled, true);
  await f.form.fire('submit'); assert.equal(f.writes.length, 0);
  delay.resolve(); await switching;
  assert.equal(f.fields.configId.value, 'config.b'); assert.equal(f.submit.disabled, false);
  await f.form.fire('submit'); assert.equal(f.writes[0].url.endsWith('/config.b'), true);
});

test('new configuration cancels a stale draft load without restoring its fields', async () => {
  const f = await fixture(); const delay = f.delayRead();
  const switching = f.context.editThreeBucketConfig({ configId: 'config.b' });
  await f.fresh.fire('click'); const id = f.fields.configId.value;
  delay.resolve(); await switching;
  assert.equal(f.fields.configId.value, id); assert.equal(f.submit.disabled, false);
  await f.form.fire('submit'); assert.equal(f.writes[0].method, 'POST');
});

test('earlier save completion cannot enable submit while another draft is loading', async () => {
  const f = await fixture(); await f.context.editThreeBucketConfig({ configId: 'config.a' });
  const write = f.delayWrite(), saving = f.form.fire('submit');
  const read = f.delayRead(), switching = f.context.editThreeBucketConfig({ configId: 'config.b' });
  f.fields.savedConfig.value = 'config.b';
  write.resolve(); await saving;
  assert.equal(f.submit.disabled, true); assert.equal(f.fields.savedConfig.value, 'config.b');
  await f.form.fire('submit'); assert.equal(f.writes.length, 1);
  read.resolve(); await switching;
  assert.equal(f.submit.disabled, false); assert.equal(f.fields.configId.value, 'config.b');
});
