import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../apps/api/server.js';
import { request } from './helpers.js';
test('copied observatory module and public boundaries',async t=>{
 const server=createServer({});
 const response=await request(server, '/modules/observatory/');assert.equal(response.status,200);
 assert.match(response.text(),/app.js/);
 assert.doesNotMatch(response.text(),/投资早晚报/);
 assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'self'/);
 assert.equal((await request(server, '/modules/observatory')).status,308);
 const dailyPaused=await request(server, '/modules/daily/');
 assert.equal(dailyPaused.status,200);
 const workbench=await request(server,'/');
 assert.doesNotMatch(workbench.text(),/<iframe/i);
  assert.match(workbench.text(),/workbench-main/);
 const loader=await request(server,'/module-loader.js');
 assert.match(loader.text(),/attachShadow/);
 for(const route of ['/modules/observatory/src/build.py','/modules/daily/data/catalog.json','/modules/daily/legacy/publish.py','/modules/observatory/%2e%2e/%2e%2e/AGENTS.md']) assert.equal((await request(server, route)).status,404);
});
test('versioned module APIs expose core contract, observatory and research read models',async()=>{
 const server=createServer({});
 const contract=await request(server,'/api/contracts/v1/core');assert.equal(contract.status,200);assert.equal(contract.json().pausedModules[0],'daily');
 const factorContract=await request(server,'/api/contracts/v1/factors');assert.equal(factorContract.status,200);assert.equal(factorContract.json().module,'factors');
 const factorAssets=await request(server,'/api/modules/factors/v1/assets');assert.equal(factorAssets.status,200);assert.ok(factorAssets.json().items.some(x=>x.assetType==='wide_table'));
 const factorSnapshots=await request(server,'/api/modules/factors/v1/snapshots');assert.equal(factorSnapshots.status,200);assert.equal(factorSnapshots.json().mode,'readonly_snapshot_candidates');
 const factorDefinitions=await request(server,'/api/modules/factors/v1/definitions');assert.equal(factorDefinitions.status,200);assert.equal(factorDefinitions.json().slotCount,14);
 const factorLibrary=await request(server,'/api/modules/factors/v1/library');assert.equal(factorLibrary.status,200);assert.equal(factorLibrary.json().mode,'editable_common_factor_library');assert.ok(factorLibrary.json().fieldCount>=64);
 const factorConfigs=await request(server,'/api/modules/factors/v1/experiment-configs');assert.equal(factorConfigs.status,200);assert.ok(factorConfigs.json().templates.length>=2);
 const factorArtifactCandidates=await request(server,'/api/modules/factors/v1/artifact-candidates');assert.equal(factorArtifactCandidates.status,200);assert.equal(factorArtifactCandidates.json().count,8);
 const registry=await request(server,'/api/registry/v1/artifacts?limit=10');assert.equal(registry.status,200);assert.equal(registry.json().registry,'artifacts');
 const sources=await request(server,'/api/modules/observatory/v1/sources');assert.equal(sources.status,200);assert.equal(sources.json().counts.indices,16);
 const skills=await request(server,'/api/modules/research/v1/skills');assert.equal(skills.status,200);assert.deepEqual(skills.json().supportedNow,['skill_registry','workflow_entry','artifact_query']);
 const artifacts=await request(server,'/api/modules/research/v1/artifacts?limit=3');assert.equal(artifacts.status,200);assert.ok(artifacts.json().items.length<=3);
});
test('each module starts without the workbench UI',async t=>{
 for(const name of ['observatory']){
  const server=createServer({modules:['observatory'],standalone:name});
  const redirect=await request(server, '/');assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),`/modules/${name}/`);
  const response=await request(server, `/modules/${name}/`);assert.equal(response.status,200);
  assert.equal((await request(server, '/api/workspaces')).status,404);
 }
});
