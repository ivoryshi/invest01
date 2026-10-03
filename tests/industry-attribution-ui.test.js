import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Node {
  constructor(tag, text) { this.tag = tag; this.textContent = text; this.children = []; this.listeners = {}; this.value = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('function industryAttributionPanel('), source.indexOf('function resultDiagnosticTable('));
const fixture = () => ({ status: 'computed_industry_accounting_v1', explanation: 'not investment alpha',
  buckets: [{ key: 'industrySelection', value: .02 }], reconciliation: { actualTerminalExcess: .02, componentsTotal: .02, error: 1e-17 },
  monthly: ['2020-01', '2020-02'].map(month => ({ month, cashExposure: 0, industrySelection: .01, managementFee: 0, tradingCost: 0, total: .01 })),
  daily: [], calculationLogic: ['exact terminal linking'], regression: { status: 'computed_sample_diagnostic', benchmarkBeta: 1.2,
    interceptPerObservation: .001, rSquared: .5, observations: 30, buckets: [{ key: 'sampleIntercept', value: .01 }] } });
function render(attribution) {
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, element: (tag, text) => new Node(tag, text),
    option: (value, text) => Object.assign(new Node('option', text), { value }), fmtPct: value => String(value), fmtNum: value => String(value),
    resultDiagnosticTable: (title, headers, rows) => Object.assign(new Node('table', title), { headers, rows }) });
  vm.runInContext(body, context); return context.industryAttributionPanel(attribution);
}
test('computed attribution displays closure and monthly filter without annualized relabeling', () => {
  const panel = render(fixture()), select = walk(panel).find(n => n.tag === 'select');
  assert.equal(select['aria-label'], '归因月份');
  const table = () => walk(panel).find(n => n.textContent === '月度全期链接贡献（非当月收益率）');
  assert.equal(table().rows.length, 2); select.value = '2020-02'; select.listeners.change();
  assert.equal(table().rows.length, 1); assert.equal(table().rows[0][0], '2020-02');
  assert.ok(walk(panel).some(n => n.textContent === '闭合校验'));
  assert.ok(walk(panel).some(n => n.textContent === '回归链接贡献（非投资Alpha）'));
  assert.ok(!body.includes('innerHTML'));
});
test('unidentified regression and legacy results retain explicit boundaries', () => {
  const input = fixture(); input.regression.status = 'insufficient_observations_or_constant_benchmark';
  const panel = render(input);
  assert.ok(walk(panel).some(n => n.textContent === '基准收益无变化或样本不足，回归不可识别。'));
  assert.equal(render({ factorDiagnostics: [] }), null); assert.equal(render(null), null);
});
