import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
class Node {
  constructor(tag,text) { this.tag=tag; this.textContent=text; this.children=[]; }
  append(...items) { this.children.push(...items); }
}
const walk = n => [n,...n.children.flatMap(walk)];
const source = await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
const body = source.slice(source.indexOf('function proxyRiskPanel('),source.indexOf('function resultDiagnosticTable('));
function render(model) {
  const ctx = vm.createContext({ document:{createElement:tag=>new Node(tag)},element:(tag,text)=>new Node(tag,text),fmtNum:String,fmtPct:String,
    resultDiagnosticTable:(title,headers,rows)=>Object.assign(new Node('table',title),{rows}) });
  vm.runInContext(body,ctx); return ctx.proxyRiskPanel(model);
}
test('risk panel displays signed risk, terminal closure and non-alpha boundaries', () => {
  const panel=render({status:'computed_proxy_multifactor_diagnostic',warning:'not causal alpha',loadings:[{key:'value',coefficient:.7}],
    linkedContributions:[{key:'sample_intercept',value:.01}],riskContributions:[{key:'value',varianceContribution:-.01,share:-.2}],
    observations:80,rank:3,columns:3,conditionNumber:2,reconciliation:{terminalExcessError:1e-15,varianceError:0},calculationLogic:['ddof=1'],daily:[]});
  assert.ok(walk(panel).some(n=>n.textContent==='not causal alpha'));
  const table=walk(panel).find(n=>n.textContent==='年化跟踪方差贡献（允许负值）');
  assert.equal(table.rows[0][1],'-0.01'); assert.ok(!body.includes('innerHTML'));
});
test('unidentified proxy risk never renders coefficients and missing old results remain supported', () => {
  const panel=render({status:'not_identifiable',warning:'proxy',reason:'collinear_or_ill_conditioned_proxies',observations:80,basis:['value']});
  assert.ok(walk(panel).some(n=>n.textContent?.includes('无法识别独立系数')));
  assert.equal(walk(panel).filter(n=>n.tag==='table').length,0); assert.equal(render(null),null);
});
