process.chdir(require('path').resolve(__dirname,'../../..'));
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const config=JSON.parse(fs.readFileSync('modules/observatory/public/research-config.json','utf8'));
const elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,style:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},focus(){},remove(){},click(){},append(){},value:''});return elements.get(id)}
const local=new Map();
const context=vm.createContext({console,URL,Blob,Date,Math,JSON,Number,String,Map,Set,Array,Error,RegExp,Promise,setTimeout(){return 0},clearTimeout(){},crypto:{randomUUID:()=> 'test-id'},localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v)},document:{getElementById:el,querySelectorAll:()=>[],querySelector:(s)=>s==='.drawer .close'?el('close-drawer'):null,addEventListener(){},createElement:()=>el('dynamic-input'),body:{style:{},append(){}},activeElement:null},window:{scrollTo(){}},confirm:()=>true});
vm.runInContext('const CFG='+JSON.stringify(config)+';\n'+fs.readFileSync('modules/observatory/src/app.js','utf8')+'\n'+fs.readFileSync('modules/observatory/src/complete.js','utf8')+'\nrender();',context);
let checks=0;function run(code){checks++;return vm.runInContext(code,context)}
for(const mode of ['real','demo'])for(const page of ['home','overview','markets','styles','signals','macro','narratives','chains','companies','horizon','evidence','sources']){
 run(`state.mode='${mode}';state.page='${page}';state.panel=null;state.market='ALL';render()`);
 const html=el('main').innerHTML;assert(html.length>500,`${page} renders`);assert(!html.includes('NaN'),`${page} has no NaN`);assert(!html.includes('undefined'),`${page} has no undefined`);
 if(mode==='real')assert(!html.includes('<svg'),`${page} has no fabricated charts`);
}
for(const mode of ['real','demo'])for(const market of ['ALL','CN','US'])for(const panel of config.panels){run(`state.mode='${mode}';state.page='overview';state.market='${market}';state.panel='${panel.id}';render()`);assert(!el('main').innerHTML.includes('undefined'))}
for(const chain of config.chains){run(`state.chain='${chain.id}';state.page='chains';render()`);assert(el('main').innerHTML.includes(chain.question))}
run("state.mode='real';state.market='ALL';state.search='NVDA';state.companyChain='ALL';state.stage='ALL';state.page='companies';render()");assert(el('main').innerHTML.includes('英伟达'));assert(!el('main').innerHTML.includes('data-asset="NVDA"')===false);
run("state.search='无匹配样本';render()");assert(el('main').innerHTML.includes('没有匹配对象'));
const valid={metricId:'us_inflation',period:'2026-07-31',publishedAt:'2026-08-28',value:2.4,sourceUrl:'https://www.bea.gov/data',sourceLabel:'test',sampleSize:null,notes:'test only'};
context.valid=valid;
assert.equal(run('validateRecords([valid])[0].value'),2.4);
for(const patch of [{value:null},{value:'2.4'},{value:Infinity},{metricId:'invalid'},{period:'2026-02-30'},{publishedAt:'2020-01-01'},{sourceUrl:'javascript:alert(1)'},{sourceLabel:''},{sampleSize:-1},{sampleSize:1.2}]){context.bad={...valid,...patch};assert.throws(()=>run('validateRecords([bad])'))}
assert.throws(()=>run('validateRecords([valid,valid])'));
run('mergeRecords(validateRecords([valid]))');assert.equal(run('saved.records.length'),1);assert.equal(run('saved.revisions.length'),0);
run('mergeRecords(validateRecords([{...valid,value:2.8}]))');assert.equal(run('saved.records[0].value'),2.8);assert.equal(run('saved.revisions[0].value'),2.4);
run('mergeRecords(validateRecords([{...valid,value:2.8}]))');assert.equal(run('saved.revisions.length'),1);
assert.equal(run('backup().revisions.length'),1);assert(local.has('workbench01-observatory-v1'));
assert.equal(run("esc('<script>alert(1)</script>')"),'&lt;script&gt;alert(1)&lt;/script&gt;');assert.equal(run("safeUrl('javascript:alert(1)')"),null);
for(const mode of ['real','demo']){run(`state.mode='${mode}';openMetric('us_inflation')`);assert(el('drawer-root').innerHTML.includes('核心PCE三个月年化'));run("openCompany('JPM')");assert(el('drawer-root').innerHTML.includes('专用模板'))}
assert.equal(config.factors.length,20);
assert.equal(config.narratives.length,7);
assert.equal(config.backgrounds.length,9);
assert.equal(config.metrics.length,40);
for(const mode of ['real','demo'])for(const factor of ['量价','基本面','价值','动量'])for(const assetType of ['company','index','etf']){run(`state.mode='${mode}';state.factor='${factor}';state.assetType='${assetType}';state.page='signals';state.market='ALL';state.signalSearch='';render()`);assert(!el('main').innerHTML.includes('NaN'));assert(el('main').innerHTML.includes('本维度的计算口径'))}
for(const mode of ['real','demo'])for(const narrative of config.narratives){run(`state.mode='${mode}';state.narrative='${narrative.id}';state.page='narratives';render()`);assert(el('main').innerHTML.includes(narrative.name));assert(el('main').innerHTML.includes('保存判断版本'))}
for(const macro of ['CN','US']){run(`state.macroTab='${macro}';state.page='macro';render()`);assert(el('main').innerHTML.includes('核心宏观与验证序列'))}
run("state.page='home';state.mode='real';state.market='ALL';render()");
for(const phrase of ['从市场变化','四个市场锚点','长期叙事工作台','公司观察池'])assert(el('main').innerHTML.includes(phrase));
for(const id of ['MSFT','JPM','SOX','TOPIX','IWF','UST10']){run(`openAsset('${id}')`);assert(el('drawer-root').innerHTML.includes('录入已核实指标'))}
const security={assetId:'MSFT',field:'ret3',period:'2026-08-31',publishedAt:'2026-09-01',value:3.2,currency:'USD',basis:'total_return',sourceUrl:'https://example.com/source',sourceLabel:'fixture',notes:'fixture only'};
context.security=security;
assert.equal(run('validateSecurities([security])[0].value'),3.2);
for(const patch of [{value:null},{currency:'EUR'},{basis:'not_applicable'},{field:'unknown'},{assetId:'unknown'},{field:'valuationRank',value:101},{field:'drawdown',value:1},{field:'pe',value:-2},{assetId:'JPM',field:'fcfYield'},{notes:''},{sourceUrl:'javascript:x()'}]){context.badSecurity={...security,...patch};assert.throws(()=>run('validateSecurities([badSecurity])'))}
assert.throws(()=>run('validateSecurities([security,security])'));
run('mergeSecurities(validateSecurities([security]))');assert.equal(run('saved.securities.length'),1);
run('mergeSecurities(validateSecurities([{...security,value:4.2}]))');assert.equal(run('saved.securityRevisions[0].value'),3.2);
assert.equal(run('backup().securities.length'),1);assert.equal(run('backup().securityRevisions.length'),1);
assert.equal(run('validateExtendedBackup(backup()).securities.length'),1);
assert.equal(run('validateExtendedBackup({}).history.length'),0);
assert.throws(()=>run("validateExtendedBackup({thesisHistory:[{id:'x'}]})"));
run("state.mode='real';mergeSecurities(validateSecurities([{...security,assetId:'IWF',field:'totalReturn',value:100},{...security,assetId:'IWD',field:'totalReturn',value:100}]))");
assert.equal(run('styleData(6).rows[0].value'),100);
run("mergeSecurities(validateSecurities([{...security,assetId:'IWD',field:'totalReturn',value:100,currency:'CNY'}]))");
assert.equal(run('styleData(6).rows.length'),0);
run("state.mode='demo'");for(let i=0;i<10;i++)assert.equal(run(`styleData(${i}).rows.length`),24);
run("state.mode='real';state.page='sources';render()");assert(el('main').innerHTML.includes('导入对象指标'));assert(el('main').innerHTML.includes('导入指标数据'));

assert.equal(run('securityTemplate().records[0].currency'),'USD');
assert.equal(run('securityTemplate().records[0].assetId'),'MSFT');
assert.equal(run('securityTemplate().records[0].value'),null);
console.log(JSON.stringify({passed:true,checks,coverage:'Inherited observatory pages and modes, panels, chains, search, revisions, validation, backup and templates',limitations:'DOM stub logic; daily archive and browser acceptance recorded separately'},null,2));
