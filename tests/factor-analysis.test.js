import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountModeSeries, compareCurves, csvText, resultComparisonKey } from '../apps/web/factor-analysis.js';

const p = (date,value) => ({date,value});
test('PE comparison binds fees cash interest purchase day mode and actual contribution schedule',()=>{
  const item={configSnapshot:{snapshotId:'frozen',benchmarkId:'510300_fixed_dca_vwap',strategyTemplateId:'strategy.legacy_510300_pe_dca',costModel:'commission=.0001;slippage=.0005',
    strategySettings:{parameters:{fee:.0001,slippage:.0005,cashRate:.02,nth:1,mode:'pool'}}},dataScope:{sourceVersion:{sha256:'a'.repeat(64)}},
    accountLedger:[{date:'2026-05-01'}],cashFlows:[{date:'2026-05-01',amount:100}],benchmarkCashFlows:[{date:'2026-05-01',amount:100}]};
  const first=resultComparisonKey(item);assert.ok(first);
  for(const [key,value]of [['fee',.001],['slippage',.001],['cashRate',.03],['nth',-1],['mode','free']]){
    const next=structuredClone(item);next.configSnapshot.strategySettings.parameters[key]=value;assert.notEqual(resultComparisonKey(next),first);
  }
  const missing=structuredClone(item);delete missing.configSnapshot.strategySettings.parameters;assert.equal(resultComparisonKey(missing),null);
});
test('comparison uses one valid calendar window and normalized NAV, not cashflow IRR',()=>{
  const series={a:[p('2020-01-01',null),p('2021-01-01',2),p('2022-01-01',3)],b:[p('2020-01-01',1),p('2021-01-01',4),p('2022-01-01',6)]};
  const result=compareCurves(series,['a','b'],'b');assert.equal(result.status,'common_period_normalized_nav_only');
  assert.deepEqual(result.period,['2021-01-01','2022-01-01']);assert.equal(result.series.a[0].value,1);
  assert.equal(result.items[0].finalValue,1.5);assert.equal(result.items[0].excessAnnualizedReturn,0);assert.equal(result.items[0].moneyWeightedIrr,undefined);
});
test('comparison respects user dates, selection and chosen baseline',()=>{
  const series={a:[p('2020-01-01',1),p('2021-01-01',2),p('2022-01-01',3)],b:[p('2020-01-01',1),p('2021-01-01',1),p('2022-01-01',2)]};
  const result=compareCurves(series,['a'],'b','2021-01-01','2022-01-01');assert.equal(result.items.length,1);assert.equal(result.items[0].finalValue,1.5);
  assert.ok(result.items[0].excessAnnualizedReturn<0);assert.deepEqual(Object.keys(result.series),['a']);
});
test('comparison refuses internal missing values, inconsistent dates, duplicates and empty windows',()=>{
  const a=[p('2020-01-01',1),p('2021-01-01',2),p('2022-01-01',3)];
  for(const b of [[a[0],a[2]],[a[0],p('2021-01-01',null),a[2]],[a[0],a[0],a[2]]]) assert.notEqual(compareCurves({a,b},['a','b'],'b').status,'common_period_normalized_nav_only');
  assert.equal(compareCurves({a},[],'a').status,'empty_selection');assert.equal(compareCurves({a},['a'],'a','2030-01-01').status,'insufficient_common_period');
});
test('comparison sorts dated observations and rejects rolled-over calendar dates',()=>{
  const a=[p('2022-01-01',3),p('2020-01-01',1),p('2021-01-01',2)];
  assert.deepEqual(compareCurves({a},['a'],'a').period,['2020-01-01','2022-01-01']);
  assert.equal(compareCurves({a:[p('2020-02-30',1),p('2022-01-01',2)]},['a'],'a').status,'invalid_series');
});
test('cashflow simple return never fills zero deposits and drawdown retains full-history peak',()=>{
  const ledger=[{date:'2020-01-01',contributed:0,accountValue:0,benchmarkValue:0,unitNav:1,benchmarkNav:1},
    {date:'2021-01-01',contributed:100,accountValue:120,benchmarkValue:110,unitNav:2,benchmarkNav:1.1},
    {date:'2022-01-01',contributed:200,accountValue:220,benchmarkValue:200,unitNav:1.5,benchmarkNav:1}];
  const profit=accountModeSeries(ledger,'profit');assert.equal(profit.strategy[0].value,null);assert.ok(Math.abs(profit.strategy[2].value-.1)<1e-12);
  assert.equal(accountModeSeries(ledger,'drawdown').strategy[2].value,-.25);assert.throws(()=>accountModeSeries(ledger,'irr'));
  const different=accountModeSeries([{date:'2020-01-01',contributed:0,accountValue:0,benchmarkContributed:100,benchmarkValue:110}],'profit');
  assert.equal(different.strategy[0].value,null);assert.ok(Math.abs(different.benchmark[0].value-.1)<1e-12);
});
test('result comparison requires source cost benchmark and exact cashflows; screens excluded',()=>{
  const item={configSnapshot:{snapshotId:'s',benchmarkId:'b',costModel:'cost',rebalanceCalendar:'monthly'},dataScope:{sourceVersions:[{assetId:'a',sha256:'a'.repeat(64)}]},accountLedger:[{}],cashFlows:[{date:'2020-01-01',amount:100}]};
  assert.ok(resultComparisonKey(item));
  for(const changed of [{...item,configSnapshot:{...item.configSnapshot,costModel:'other'}},{...item,cashFlows:[{date:'2020-01-01',amount:200}]}]) assert.notEqual(resultComparisonKey(changed),resultComparisonKey(item));
  assert.equal(resultComparisonKey({...item,artifactType:'fund_cross_section_screen'}),null);
  assert.equal(resultComparisonKey({...item,dataScope:{}}),null);
});
test('CSV preserves quoted text, leading zero codes, null and nested audits without formula injection',()=>{
  const output=csvText([{code:'000001',title:'=HYPERLINK("bad")',value:null,amount:-12,audit:{a:1}}],['code','title','value','amount','audit']);
  assert.ok(output.includes('"000001"'));assert.ok(output.includes('"\'=HYPERLINK(""bad"")"'));assert.ok(output.includes('"-12"'));assert.ok(output.includes('"{""a"":1}"'));
});
test('three bucket comparison binds both effective annual fees and refuses missing fees',()=>{
  const item={configSnapshot:{strategyTemplateId:'strategy.legacy_three_bucket_monthly',snapshotId:'s',benchmarkId:'b',costModel:'cost',strategySettings:{broadAnnualFee:.005,sectorAnnualFee:.006}},dataScope:{sourceVersions:[{assetId:'a',sha256:'a'.repeat(64)}]},accountLedger:[{}],cashFlows:[]};
  assert.ok(resultComparisonKey(item));
  for(const key of ['broadAnnualFee','sectorAnnualFee']) {
    const changed=structuredClone(item);changed.configSnapshot.strategySettings[key]=.02;
    assert.notEqual(resultComparisonKey(changed),resultComparisonKey(item));
    delete changed.configSnapshot.strategySettings[key];assert.equal(resultComparisonKey(changed),null);
  }
  const edge=structuredClone(item);edge.configSnapshot.strategySettings={broadAnnualFee:.15,sectorAnnualFee:.2};assert.ok(resultComparisonKey(edge));
});
