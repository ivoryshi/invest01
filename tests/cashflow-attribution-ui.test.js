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
const body = source.slice(source.indexOf('function cashflowAttributionPanel('), source.indexOf('function industryAttributionPanel('));
function render(a) {
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, element: (tag, text) => new Node(tag, text),
    option: (value, text) => Object.assign(new Node('option', text), { value }), fmtNum: value => String(value),
    resultDiagnosticTable: (title, headers, rows) => Object.assign(new Node('table', title), { headers, rows }) });
  vm.runInContext(body, context); return context.cashflowAttributionPanel(a);
}
test('cashflow result presents amount contributions and filters months without percentage or IRR relabeling', () => {
  const panel = render({ status: 'computed_cashflow_accounting_v1', explanation: 'not alpha or IRR', buckets: [{ key: 'fund:000001', value: 50 }],
    reconciliation: { totalContributed: 100, strategyProfit: 50, benchmarkProfit: 0, actualTerminalExcessValue: 50, componentsTotal: 50, error: 0 },
    monthly: ['2020-01', '2020-02'].map(month => ({ month, deposit: 50, components: { 'fund:000001': 25 }, total: 25 })), daily: [], calculationLogic: ['same flows'] });
  const select = walk(panel).find(n => n.tag === 'select'); assert.equal(select['aria-label'], '现金流归因月份');
  const table = () => walk(panel).find(n => n.textContent === '月度金额贡献（非当月收益率）');
  assert.equal(table().rows.length, 2); select.value = '2020-02'; select.listeners.change();
  assert.equal(table().rows.length, 1); assert.equal(table().rows[0][0], '2020-02');
  assert.ok(walk(panel).some(n => n.textContent === '资金与损益核对'));
  assert.equal(table().headers[2], '基金 000001 相对损益');
  assert.ok(!body.includes('fmtPct') && !body.includes('innerHTML'));
});
test('legacy placeholder and industry return attribution do not render as currency amounts', () => {
  for (const a of [null, {}, { status: 'computed_industry_accounting_v1' }]) assert.equal(render(a), null);
});
