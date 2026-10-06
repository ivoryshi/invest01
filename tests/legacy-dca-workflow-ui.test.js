import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Node {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value='';this.disabled=false;this.checked=false;}
  append(...children){children.forEach(child=>{child.parent=this;this.children.push(child);});}
  replaceChildren(...children){this.children=[];this.append(...children);}
  setAttribute(){}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  async fire(type){const work=[];for(let node=this;node;node=type==='change'?node.parent:null)for(const fn of node.listeners[type]||[])work.push(fn({target:this,preventDefault(){}}));await Promise.all(work);}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
const source=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
const panel=source.slice(source.indexOf('async function legacyDcaReplayPanel('),source.indexOf('async function customExpressionPanel('));
const frozen='snapshot.frozen.'+'f'.repeat(64), archive='a'.repeat(64), sha='b'.repeat(64);
const defaults={amount:10000,fee:.0001,slippage:.0005,nth:1,startMonth:'2026-05',endMonth:'2026-07',timingEnabled:true,peKey:'TTM',years:5,mode:'pool',cashRate:.02,ladder:[{hi:100,multiple:1}]};
async function fixture({missingArchive=false}={}){
  const posts=[];let configs=missingArchive?[{configId:'config.frozen_only',title:'Frozen only',revision:3,strategyTemplateId:'strategy.legacy_510300_pe_dca',snapshotId:frozen,strategySettings:{archiveId:archive,sourceSha256:sha,parameters:defaults},notes:'preserve me',comparisonLimits:['custom_same_currency']}]:[],refreshes=0;
  const element=(tag,text)=>Object.assign(new Node(tag),{textContent:text});
  const context=vm.createContext({element,option:(value,text)=>Object.assign(element('option',text),{value}),document:{createElement:tag=>new Node(tag)},URLSearchParams,
    editLegacyDcaConfig:null,refreshBacktestTools:async()=>{refreshes++;},refreshFactorExecution:async()=>{},fetch:async(url,init)=>{
      let data;
      if(init){const body=JSON.parse(init.body);posts.push({url,method:init.method,body});
        if(url.endsWith('/snapshots/frozen'))data={snapshotId:frozen};
        else{const item={...body,revision:init.method==='PUT'?2:1};configs=[item];data={item};}
      }else if(url.includes('/options')||url.includes('/frozen-options')){if(missingArchive&&!url.includes('/frozen-options'))return{ok:false,json:async()=>({error:'archive missing'})};const id=new URL('http://localhost'+url).searchParams.get('archiveId')||archive;data={sourceVersion:{archiveId:id,sha256:sha},defaults,archives:[{archiveId:archive,createdAt:'old'},{archiveId:'c'.repeat(64),createdAt:'new'}],pricePeriod:['2012-05-01','2026-07-31'],priceObservations:3446,peObservations:5179};}
      else if(url.includes('/experiment-configs/'))data={item:configs.find(c=>url.endsWith('/'+c.configId))};
      else data={items:configs};
      return{ok:true,json:async()=>data};
    }});
  vm.runInContext(`${panel};globalThis.create=legacyDcaReplayPanel`,context);
  const root=await context.create(),nodes=()=>descendants(root);
  return{posts,nodes,field:name=>nodes().find(n=>n.name===name),button:text=>nodes().find(n=>n.tag==='button'&&n.textContent===text),refreshes:()=>refreshes,edit:id=>context.editLegacyDcaConfig({configId:id}),update:fn=>{configs=configs.map(fn);}};
}
test('PE formal save requires an explicit selected archive freeze and never runs simulation',async()=>{
  const f=await fixture();await f.button('保存正式配置').fire('click');assert.equal(f.posts.length,0);
  await f.button('冻结当前归档版本').fire('click');await f.button('保存正式配置').fire('click');
  assert.equal(f.posts.length,2);assert.equal(f.posts[0].url,'/api/modules/factors/v1/snapshots/frozen');
  assert.deepEqual(f.posts[0].body.selection,{archiveId:archive,sourceSha256:sha});
  const config=f.posts[1].body;assert.equal(config.snapshotId,frozen);assert.equal(config.strategyTemplateId,'strategy.legacy_510300_pe_dca');
  assert.deepEqual(config.strategySettings.parameters,defaults);assert.equal(config.costModel,'commission=0.0001;slippage=0.0005');
  assert.ok(f.posts.every(p=>!p.url.includes('/run')&&!p.url.includes('/preview')));
});
test('PE saved configuration survives bubbling selection and edits use PUT with frozen identity',async()=>{
  const f=await fixture();f.field('peConfigId').value='config.pe_saved';await f.button('冻结当前归档版本').fire('click');await f.button('保存正式配置').fire('click');
  f.field('savedPeConfig').value='config.pe_saved';await f.field('savedPeConfig').fire('change');
  assert.equal(f.field('peConfigId').value,'config.pe_saved');assert.equal(f.field('peConfigId').disabled,true);
  f.field('amount').value='20000';await f.field('amount').fire('change');await f.button('保存正式配置').fire('click');
  assert.equal(f.posts.at(-1).method,'PUT');assert.ok(f.posts.at(-1).url.endsWith('/config.pe_saved'));
  assert.equal(f.posts.at(-1).body.strategySettings.parameters.amount,20000);assert.equal(f.posts.at(-1).body.snapshotId,frozen);
  assert.equal(f.posts.at(-1).body.expectedRevision,1);
});
test('frozen PE configuration loads latest revision and preserves metadata without original archive',async()=>{
  const f=await fixture({missingArchive:true});await f.edit('config.frozen_only');
  assert.equal(f.field('peConfigTitle').value,'Frozen only');assert.equal(f.button('复算归档数据').disabled,true);
  assert.equal(f.button('冻结当前归档版本').disabled,true);f.field('peConfigTitle').value='Renamed';await f.button('保存正式配置').fire('click');
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].method,'PUT');assert.equal(f.posts[0].body.expectedRevision,3);assert.equal(f.posts[0].body.notes,'preserve me');
  assert.ok(f.posts[0].body.comparisonLimits.includes('custom_same_currency'));
  f.update(c=>({...c,revision:9,title:'Latest outside edit'}));await f.edit('config.frozen_only');
  assert.equal(f.field('peConfigTitle').value,'Latest outside edit');await f.button('保存正式配置').fire('click');assert.equal(f.posts.at(-1).body.expectedRevision,9);
});
for (const [strategy, editor] of [['strategy.legacy_510300_pe_dca','editLegacyDcaConfig'],['strategy.monthly_dca_three_bucket','editDcaConfig']]) test(`configuration library routes ${strategy} to its dedicated editor`,async()=>{
  const start=source.lastIndexOf('  function renderConfigs()');
  const render=source.slice(start,source.indexOf('  picker.addEventListener(',start));
  let selected=null;const cards=new Node('section');
  const ctx=vm.createContext({saved:cards,configs:{templates:[],items:[{configId:'config.pe',strategyTemplateId:strategy,title:'DCA'}]},
    element:(tag,text)=>Object.assign(new Node(tag),{textContent:text}),document:{createElement:tag=>new Node(tag)},[editor]:item=>{selected=item.configId;},fillConfig:()=>{throw Error('generic form must not receive executable DCA');}});
  vm.runInContext(render,ctx);ctx.renderConfigs();await descendants(cards).find(n=>n.tag==='button').fire('click');assert.equal(selected,'config.pe');
});
const dcaEditor=source.slice(source.indexOf('  let dcaEditGeneration = 0;'),source.indexOf('  function updateDcaSummary()',source.indexOf('  let dcaEditGeneration = 0;')));
test('broad DCA editor reads latest saved revision and ignores earlier or detached responses',async()=>{
  const pending=[],filled=[],panel={isConnected:true};
  const ctx=vm.createContext({panel,configs:{items:[]},editDcaConfig:null,fillDcaConfig:item=>filled.push(item),fetch:()=>new Promise(resolve=>pending.push(resolve)),dcaForm:{querySelector:()=>({})}});
  vm.runInContext(dcaEditor,ctx);
  const first=ctx.editDcaConfig({configId:'config.a'}),second=ctx.editDcaConfig({configId:'config.b'});
  const item={configId:'config.b',strategyTemplateId:'strategy.monthly_dca_three_bucket',revision:7,title:'Latest',snapshotId:frozen,transactionSettings:{amount:1234}};
  pending[1]({ok:true,json:async()=>({items:[item]})});await second;
  pending[0]({ok:true,json:async()=>({items:[{...item,configId:'config.a',revision:1}]})});await first;
  assert.deepEqual(filled,[item]);assert.equal(ctx.configs.items[0].revision,7);
  const detached=ctx.editDcaConfig({configId:'config.b'});panel.isConnected=false;
  pending[2]({ok:true,json:async()=>({items:[item]})});await detached;assert.equal(filled.length,1);
});
test('broad DCA editor refuses missing or wrong strategy without filling a generic form',async()=>{
  const message={textContent:''};let filled=false;
  const ctx=vm.createContext({panel:{isConnected:true},configs:{items:[]},editDcaConfig:null,fillDcaConfig:()=>{filled=true;},fetch:async()=>({ok:true,json:async()=>({items:[{configId:'config.a',strategyTemplateId:'strategy.legacy_510300_pe_dca'}]})}),dcaForm:{querySelector:()=>message}});
  vm.runInContext(dcaEditor,ctx);await ctx.editDcaConfig({configId:'config.a'});
  assert.equal(filled,false);assert.ok(message.textContent.includes('类型不匹配'));assert.deepEqual(ctx.configs.items,[]);
});
test('changing archived version clears old snapshot and requires freezing again',async()=>{
  const f=await fixture();await f.button('冻结当前归档版本').fire('click');
  f.field('archiveId').value='c'.repeat(64);await f.field('archiveId').fire('change');await f.button('保存正式配置').fire('click');
  assert.equal(f.posts.length,1);await f.button('冻结当前归档版本').fire('click');
  assert.equal(f.posts.at(-1).body.selection.archiveId,'c'.repeat(64));
});
