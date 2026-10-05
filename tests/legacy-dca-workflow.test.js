import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dispatchRequest } from '../apps/api/server.js';
import { createFrozenSnapshotStore, legacyDcaSnapshotId } from '../modules/factors/src/frozen-snapshots.js';
import { factorDataAssets, factorSnapshotCandidates } from '../packages/contracts/factors.js';
import { resultComparisonKey } from '../apps/web/factor-analysis.js';

const project = fileURLToPath(new URL('../', import.meta.url));
test('PE workflow freezes a selected archive and writes only isolated standard assets', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pe-workflow-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  // Import a separate project copy so API JSON stores never point at user research assets.
  for (const name of ['apps/api','packages','modules/factors/src','.agents/skills']) {
    await cp(path.join(project,name),path.join(root,name),{recursive:true});
  }
  const options = JSON.parse((await dispatchRequest({}, {url:'/api/modules/factors/v1/legacy-dca/options'})).body);
  const chosen = {archiveId:options.sourceVersion.archiveId,sourceSha256:options.sourceVersion.sha256};
  const archiveRoot = path.join(root,'archives');
  await mkdir(path.join(archiveRoot,'versions'),{recursive:true});
  await cp(path.join(project,'var/factors/legacy-archives/versions',chosen.archiveId),path.join(archiveRoot,'versions',chosen.archiveId),{recursive:true});
  const store = createFrozenSnapshotStore({root:path.join(root,'frozen'),assets:factorDataAssets,candidates:factorSnapshotCandidates,legacyArchiveRoot:archiveRoot});
  await store.freeze(legacyDcaSnapshotId,'isolated',chosen);
  const isolated = await import(pathToFileURL(path.join(root,'apps/api/server.js')).href);
  const call = async (url,body,method=body===undefined?'GET':'POST') => {
    if(method==='PUT'&&body.expectedRevision===undefined){const current=await isolated.dispatchRequest({snapshotStore:store},{url:'/api/modules/factors/v1/'+url});body={...body,expectedRevision:JSON.parse(current.body).item.revision};}
    const response = await isolated.dispatchRequest({snapshotStore:store},{url:'/api/modules/factors/v1/'+url,method,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:JSON.parse(response.body)};
  };
  const freeze = await call('snapshots/frozen',{baseSnapshotId:legacyDcaSnapshotId,selection:chosen});
  assert.equal(freeze.status,201,JSON.stringify(freeze.data));
  assert.deepEqual(freeze.data.item.selection,chosen);
  assert.equal((await store.freeze(legacyDcaSnapshotId,'again',chosen)).snapshotId,freeze.data.snapshotId);
  await assert.rejects(store.freeze(legacyDcaSnapshotId,'',{...chosen,sourceSha256:'0'.repeat(64)}),/version_mismatch/);
  await assert.rejects(store.freeze(legacyDcaSnapshotId,'',{...chosen,path:'/tmp/anything'}),/selection_required/);
  const p = {...options.defaults,startMonth:'2026-05',endMonth:'2026-07',timingEnabled:false};
  const config = {configId:'config.pe_workflow_test',title:'PE isolated acceptance',strategyTemplateId:'strategy.legacy_510300_pe_dca',snapshotId:freeze.data.snapshotId,
    factorFamilyIds:[],factorWeights:[],benchmarkId:'510300_fixed_dca_vwap',universe:'archived_510300_adjusted_vwap',portfolioRule:'pe_ladder_monthly_dca',rebalanceCalendar:'monthly',
    costModel:`commission=${p.fee};slippage=${p.slippage}`,strategySettings:{...chosen,parameters:p},transactionSettings:{}};
  assert.equal((await call('experiment-configs',config)).status,201);
  const preflight = async (mode='assumption_simulation') => call('backtest-tools/preflight?'+new URLSearchParams({configId:config.configId,researchMode:mode}));
  const run = receipt => call('backtest-tools/run',{configId:config.configId,preflightSha256:receipt.preflightSha256,acknowledgements:receipt.requiredAcknowledgements});
  const count = async () => (await call('result-artifacts')).data.count;
  const beforeFiles = await readFile(path.join(root,'var/factors/experiment-configs.json'));
  const receipt = (await preflight()).data;
  assert.equal(receipt.ready,true,JSON.stringify(receipt));
  assert.equal(await count(),0);
  assert.deepEqual(await readFile(path.join(root,'var/factors/experiment-configs.json')),beforeFiles);
  assert.equal((await preflight('point_in_time_verified')).data.ready,false);
  assert.equal((await call('backtest-tools/run',{configId:config.configId,preflightSha256:receipt.preflightSha256,acknowledgements:[]})).status,422);
  const manual = await call('run-requests',{configId:config.configId});
  assert.equal(manual.status,201);
  assert.equal((await call(`run-requests/${manual.data.item.requestId}/execute`,{})).status,422);
  assert.equal(await count(),0);
  config.title = 'PE edited revision';
  assert.equal((await call(`experiment-configs/${config.configId}`,config,'PUT')).data.item.revision,2);
  assert.equal((await run(receipt)).status,409);
  const currentReceipt = (await preflight()).data;
  const result = await run(currentReceipt);
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.audit.status,'review_required');
  assert.equal(result.data.resultArtifact.configSnapshot.configRevision,2);
  assert.equal(result.data.resultArtifact.dataScope.calculationSources.length,3);
  assert.equal(result.data.resultArtifact.trades.length,3);
  assert.equal(result.data.resultArtifact.dataScope.sourceVersion.sha256,chosen.sourceSha256);
  assert.equal(result.data.resultArtifact.configSnapshot.strategyTemplateId,'strategy.legacy_510300_pe_dca');
  assert.deepEqual(result.data.resultArtifact.benchmarkCashFlows,result.data.resultArtifact.cashFlows);
  const resultKey=resultComparisonKey(result.data.resultArtifact);assert.ok(resultKey);
  const changedRate=structuredClone(result.data.resultArtifact);changedRate.configSnapshot.strategySettings.parameters.cashRate=.1;
  assert.notEqual(resultComparisonKey(changedRate),resultKey);
  const changedBenchmarkFlow=structuredClone(result.data.resultArtifact);changedBenchmarkFlow.benchmarkCashFlows[0].amount=200;
  assert.notEqual(resultComparisonKey(changedBenchmarkFlow),resultKey);
  const preview = JSON.parse((await dispatchRequest({}, {method:'POST',url:'/api/modules/factors/v1/legacy-dca/preview',body:JSON.stringify({...chosen,parameters:p})})).body);
  assert.deepEqual(result.data.resultArtifact.metrics,preview.metrics);
  assert.deepEqual(result.data.resultArtifact.accountLedger,preview.accountLedger);
  const repeated = await run(currentReceipt);
  assert.equal(repeated.data.reused,true);
  assert.equal(repeated.data.resultArtifact.artifactId,result.data.resultArtifact.artifactId);
  assert.equal(await count(),1);
  assert.equal((await call(`run-requests/${result.data.item.requestId}/execute`,{})).status,409);
  // Once frozen, executing does not depend on original archive availability.
  await rm(archiveRoot,{recursive:true,force:true});
  const frozenOptions=await call('legacy-dca/frozen-options?'+new URLSearchParams({snapshotId:config.snapshotId}));
  assert.equal(frozenOptions.status,200,JSON.stringify(frozenOptions.data));
  assert.equal(frozenOptions.data.sourceVersion.archiveId,chosen.archiveId);
  const beforeConflict=await readFile(path.join(root,'var/factors/experiment-configs.json'));
  const conflict=await call(`experiment-configs/${config.configId}`,{...config,title:'stale overwrite',expectedRevision:1},'PUT');
  assert.equal(conflict.status,409);
  assert.deepEqual(await readFile(path.join(root,'var/factors/experiment-configs.json')),beforeConflict);
  config.strategySettings.parameters.amount = 20000;
  await call(`experiment-configs/${config.configId}`,config,'PUT');
  const nextReceipt = (await preflight()).data;
  assert.equal(nextReceipt.ready,true);
  const next = await run(nextReceipt);
  assert.equal(next.status,200,JSON.stringify(next.data));
  assert.ok(Math.abs(next.data.resultArtifact.metrics.finalValue-2*result.data.resultArtifact.metrics.finalValue)<1e-7);
  const validConfig = structuredClone(config);
  for (const change of [c=>{c.benchmarkId='OTHER';},c=>{c.costModel='commission=0;slippage=0';},c=>{c.strategySettings.sourceSha256='0'.repeat(64);},c=>{c.strategySettings.parameters.ladder=[{hi:99,multiple:1}];},c=>{c.strategySettings.parameters.startMonth='1900-01';},c=>{c.transactionSettings={amount:5};}]) {
    const bad=structuredClone(validConfig);change(bad);await call(`experiment-configs/${bad.configId}`,bad,'PUT');
    assert.equal((await preflight()).data.ready,false);
    assert.equal(await count(),2);
  }
  await call(`experiment-configs/${config.configId}`,validConfig,'PUT');
  const resolved = await store.resolve(config.snapshotId,'factors.legacy.510300');
  await chmod(resolved.storageRef,0o600);
  await writeFile(resolved.storageRef,'corrupted');
  assert.equal((await preflight()).data.ready,false);
  assert.equal((await run(nextReceipt)).status,409);
  assert.equal(await count(),2);
});
