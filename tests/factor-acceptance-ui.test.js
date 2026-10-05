import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Node {
  constructor(tag, text) { this.tag = tag; this.textContent = text; this.children = []; this.value = ''; this.listeners = {}; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  getBoundingClientRect() { return {left:0,width:760}; }
  setPointerCapture() {}
}
const walk = n => [n, ...n.children.flatMap(walk)];
const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../apps/api/server.js', import.meta.url), 'utf8');
const element = (tag, text) => new Node(tag, text);
const context = vm.createContext({ document: { createElement: element }, element, option:element, fmtNum: v => String(v),
  svg: (tag, attrs = {}) => Object.assign(new Node(tag), attrs) });
vm.runInContext(source.slice(source.indexOf('function lineChart('), source.indexOf('function barTrack(')), context);
vm.runInContext(source.slice(source.indexOf('function factorRecordBrowser('), source.indexOf('async function executionPlanPanel(')), context);
vm.runInContext(apiSource.slice(apiSource.indexOf('function sampleSeries('),apiSource.indexOf('async function factorLibrary(')),context);
const point = (date, value) => ({ date, value });
test('charts align equal dates across unequal starts and ignore deselected scale', () => {
  const chart = context.lineChart({ a: [point('2020-01-01', 1), point('2020-01-03', 2)], b: [point('2020-01-03', 2)], hidden: [point('2010-01-01', 999)] }, { items: [{key:'a'}, {key:'b'}] });
  const dots = walk(chart).filter(n => n.tag === 'circle');
  assert.equal(dots[1].cx, dots[2].cx); assert.equal(dots[1].cy, dots[2].cy);
  assert.ok(!walk(chart).some(n => n.textContent === '2010-01-01' || n.textContent === '999'));
  assert.ok(walk(chart).some(n => n.tag === 'title' && n.textContent.includes('2020-01-03')));
});
test('charts split missing observations, do not turn null into zero or NaN', () => {
  const chart = context.lineChart({a:[point('2020-01-01',1),point('2020-01-02',null),point('2020-01-03',2),point('bad',8),point('2020-01-04',Infinity)]},{items:[{key:'a'}]});
  assert.equal(walk(chart).filter(n => n.tag === 'polyline').length, 2);
  assert.equal(walk(chart).filter(n => n.tag === 'circle').length, 2);
  assert.ok(!JSON.stringify(chart).includes('NaN'));
});
test('empty chart selection has an explicit finite empty state', () => {
  const chart = context.lineChart({ a: [point('2020-01-01', 1)] }, { items: [] });
  assert.ok(walk(chart).some(n => n.textContent === '无可显示的有效观测'));
  assert.ok(!JSON.stringify(chart).includes('Infinity'));
});
test('display sampling retains gaps that fall between sampled dates and rejects empty scalar values',()=>{
  const dates=['2020-01-01','2020-01-02','2020-01-03','2020-01-04','2020-01-05'];
  const rows=context.sampleSeries(dates,[1,null,2,3,4],2);
  assert.ok(rows.some(row=>row.date==='2020-01-02'&&row.value===null));
  const blanks=context.sampleSeries(dates,[1,'',false,'  ',null],5);
  assert.equal(blanks.filter(row=>row.value===null).length,4);
});
test('drag selection uses visible curve dates, not hidden histories or input padding',()=>{
  const node=context.chartWorkspace({a:[point('2020-01-03',1),point('2022-01-03',2)],hidden:[point('2010-01-01',1),point('2030-01-01',1)]},{items:[{key:'a'}],label:'日期域'});
  const start=walk(node).find(n=>n['aria-label']==='日期域开始日期'),end=walk(node).find(n=>n['aria-label']==='日期域结束日期');
  start.value='2019-12-31';end.value='2022-01-05';start.listeners.change();
  const chart=walk(node).find(n=>n.tag==='svg');
  chart.listeners.pointerdown({button:0,clientX:46,pointerId:1});chart.listeners.pointerup({clientX:742,pointerId:1});
  assert.equal(start.value,'2020-01-03');assert.equal(end.value,'2022-01-03');
});
test('record browser can reach every historical result and retains query after refresh', () => {
  const browser = context.factorRecordBrowser('结果资产', row => element('article', row.artifactId));
  const items = Array.from({length:23}, (_,i) => ({artifactId:`result.${i}`,title:`t${i}`}));
  browser.setItems(items);
  const find = label => walk(browser.node).find(n => n['aria-label'] === label);
  find('结果资产下一页').listeners.click(); find('结果资产下一页').listeners.click();
  assert.deepEqual(walk(browser.node).filter(n=>n.tag==='article').map(n=>n.textContent),['result.20','result.21','result.22']);
  find('结果资产查询').value = 'result.1'; find('结果资产查询').listeners.input();
  browser.setItems(items);
  assert.equal(find('结果资产查询').value, 'result.1');
  assert.equal(walk(browser.node).filter(n=>n.tag==='article').length, 10);
});
test('record browser bounds page after rows disappear and reports no matches', () => {
  const browser = context.factorRecordBrowser('运行请求', row => element('article',row.requestId));
  browser.setItems(Array.from({length:11},(_,i)=>({requestId:`run.${i}`})));
  walk(browser.node).find(n=>n['aria-label']==='运行请求下一页').listeners.click();
  browser.setItems([{requestId:'run.only'}]);
  assert.ok(walk(browser.node).some(n=>n.textContent==='run.only'));
  const query=walk(browser.node).find(n=>n.tag==='input');query.value='missing';query.listeners.input();
  assert.ok(walk(browser.node).some(n=>n.textContent==='暂无匹配记录'));
});
test('late result detail cannot overwrite a later selection or empty result library', async () => {
  const body = source.slice(source.indexOf('  async function renderResultDetail()'), source.indexOf('  function resultMetricGrid('));
  let finish;
  const detail = element('section');
  const ctx=vm.createContext({selectedResultId:'result.old',detailGeneration:0,resultDetail:detail,element,encodeURIComponent,
    fetch:async url=>{if(url.endsWith('result.old'))await new Promise(r=>{finish=r;});return {ok:false,json:async()=>({error:url})};}});
  vm.runInContext(body,ctx);
  const old=ctx.renderResultDetail();ctx.selectedResultId='result.new';await ctx.renderResultDetail();finish();await old;
  assert.ok(walk(detail).some(n=>n.textContent?.endsWith('result.new')));
  ctx.selectedResultId='result.old';const pending=ctx.renderResultDetail();ctx.selectedResultId=null;await ctx.renderResultDetail();finish();await pending;
  assert.ok(walk(detail).some(n=>n.textContent==='还没有可查看的结果资产。'));
});
test('formal PE detail renders ledger trades and missing attribution without throwing',async()=>{
  const body=source.slice(source.indexOf('  async function renderResultDetail()'),source.indexOf('  function resultMetricGrid('));
  const detail=element('section');
  const item={artifactId:'result.pe',executionMode:'native_workbench_legacy_510300_pe_dca_v1',metrics:{benchmarkContributed:100},
    cashFlows:[{date:'2026-05-01',amount:100}],accountLedger:[{date:'2026-05-01',accountValue:100}],
    trades:[{date:'2026-05-01',status:'buy',deposit:100,spend:100}],warnings:['not_point_in_time_verified'],
    dataScope:{sourceVersion:{archiveId:'archive',sha256:'sha'}},comparisonPolicy:'different_cashflows_use_separate_xirr_no_wealth_ranking'};
  const ctx=vm.createContext({selectedResultId:'result.pe',detailGeneration:0,resultDetail:detail,element,encodeURIComponent,
    fmtPct:String,fmtNum:String,resultExportPanel:()=>element('exports'),industryAttributionPanel:()=>null,cashflowAttributionPanel:()=>null,proxyRiskPanel:()=>null,
    resultMetricGrid:()=>element('metrics'),resultDiagnosticTable:(title)=>element('table',title),
    factorRecordBrowser:(label)=>({node:element('browser',label),setItems:()=>{}}),
    fetch:async()=>({ok:true,json:async()=>({item,reviewChecklist:[]})})});
  vm.runInContext(body,ctx);await ctx.renderResultDetail();
  assert.ok(walk(detail).some(n=>n.textContent==='PE正式交易记录'));
  assert.ok(walk(detail).some(n=>n.textContent?.includes('different_cashflows_use_separate_xirr')));
});
