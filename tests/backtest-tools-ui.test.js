import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Node {
  constructor(tag) { this.tag=tag;this.children=[];this.listeners={};this.value='';this.checked=false;this.disabled=false; }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children=[];this.append(...items); }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  querySelectorAll(selector) { return descendants(this).filter(n=>n.tag===selector); }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({preventDefault(){}}); }
}
const descendants = n => [n,...n.children.flatMap(descendants)];
const source=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
const panel=source.slice(source.indexOf('async function backtestToolsPanel('),source.indexOf('async function executionPlanPanel('));
function delayed() { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
async function fixture({blocked=false, conflict=false}={}) {
  const posts=[], gets=[];let pending=null;
  const receipt={ready:!blocked,configId:'config.a',configRevision:1,snapshotId:'snapshot.frozen.'+'a'.repeat(64),researchMode:'assumption_simulation',
    preflightSha256:'b'.repeat(64),blockers:blocked?['historical_information_availability_not_verified']:[],temporalEligibility:{status:'not_point_in_time_verified'},
    limitations:['not PIT'],requiredAcknowledgements:['not_point_in_time_verified','proxy_or_adjusted_nav_not_real_execution']};
  const element=(tag,text)=>{const n=new Node(tag);n.textContent=text;return n;};
  const option=(value,text)=>{const n=element('option',text);n.value=value;return n;};
  const context=vm.createContext({element,option,document:{createElement:tag=>new Node(tag)},URLSearchParams,
    refreshBacktestTools:null,refreshFactorExecution:async()=>{},resultDiagnosticTable:()=>new Node('table'),fetch:async(url,init)=>{
      if(init){posts.push(JSON.parse(init.body));return {ok:!conflict,json:async()=>conflict?{error:'backtest_preflight_changed_repeat_review'}:{reused:false,resultArtifact:{artifactId:'result.a'},audit:{status:'review_required',checks:[],note:'stored audit'}}};}
      gets.push(url);
      if(url.includes('/preflight?')){if(pending){const p=pending;pending=null;await p.promise;}return {ok:true,json:async()=>receipt};}
      return {ok:true,json:async()=>({items:[{configId:'config.a',title:'a',revision:1},{configId:'config.b',title:'b',revision:1}]})};
    }});
  vm.runInContext(`${panel};globalThis.createPanel=backtestToolsPanel`,context);
  const root=await context.createPanel(), nodes=()=>descendants(root), field=name=>nodes().find(n=>n.name===name), button=text=>nodes().find(n=>n.tag==='button'&&n.textContent===text);
  return {posts,gets,root,field,run:button('确认并执行回测'),form:nodes().find(n=>n.tag==='form'),nodes,delay(){pending=delayed();return pending;},
    async checkAll(){for(const n of nodes().filter(n=>n.type==='checkbox')){n.checked=true;await n.fire('change');}}};
}
test('preflight does not run until both explicit assumptions are checked',async()=>{
  const f=await fixture();f.field('configId').value='config.a';await f.form.fire('submit');assert.equal(f.posts.length,0);assert.equal(f.run.disabled,true);
  await f.checkAll();assert.equal(f.run.disabled,false);await f.run.fire('click');assert.equal(f.posts.length,1);assert.equal(f.posts[0].configId,'config.a');assert.equal(f.run.disabled,true);
});
test('changing configuration invalidates receipt and all confirmations',async()=>{
  const f=await fixture();f.field('configId').value='config.a';await f.form.fire('submit');await f.checkAll();
  f.field('configId').value='config.b';await f.field('configId').fire('change');assert.equal(f.run.disabled,true);await f.run.fire('click');assert.equal(f.posts.length,0);
});
test('late preflight cannot bind old result after research mode changes',async()=>{
  const f=await fixture();f.field('configId').value='config.a';const delay=f.delay(), reading=f.form.fire('submit');
  f.field('researchMode').value='point_in_time_verified';await f.field('researchMode').fire('change');delay.resolve();await reading;
  assert.equal(f.nodes().filter(n=>n.type==='checkbox').length,0);assert.equal(f.run.disabled,true);
});
test('PIT blocked preflight never offers confirmation as a bypass',async()=>{
  const f=await fixture({blocked:true});f.field('configId').value='config.a';await f.form.fire('submit');
  assert.equal(f.run.disabled,true);assert.equal(f.nodes().filter(n=>n.type==='checkbox').length,0);await f.run.fire('click');assert.equal(f.posts.length,0);
});
test('conflict invalidates receipt and does not automatically retry',async()=>{
  const f=await fixture({conflict:true});f.field('configId').value='config.a';await f.form.fire('submit');await f.checkAll();await f.run.fire('click');
  assert.equal(f.posts.length,1);assert.equal(f.run.disabled,true);assert.ok(f.nodes().some(n=>n.textContent?.includes('勿自动重试')));
});
