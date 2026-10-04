import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatchRequest } from '../apps/api/server.js';

test('archived PE replay is read-only, lagged, cost-aware and cashflow-correct',async()=>{
  const {stderr}=await promisify(execFile)('python3',['-B','-m','unittest','discover','-s','tests','-p','legacy_dca_replay_test.py'],{cwd:new URL('../',import.meta.url),timeout:30000});
  assert.match(stderr,/Ran 7 tests/);assert.match(stderr,/OK/);
});
test('archived replay API binds versions and refuses changed hashes or unsupported methods',async()=>{
  const options=await dispatchRequest({}, {url:'/api/modules/factors/v1/legacy-dca/options'});
  assert.equal(options.status,200);const data=JSON.parse(options.body);
  assert.equal(data.priceObservations,3446);assert.equal(data.peObservations,5179);
  const body={archiveId:data.sourceVersion.archiveId,sourceSha256:data.sourceVersion.sha256,parameters:{...data.defaults,startMonth:'2026-05',endMonth:'2026-07',timingEnabled:false}};
  const response=await dispatchRequest({}, {method:'POST',url:'/api/modules/factors/v1/legacy-dca/preview',body:JSON.stringify(body)});
  assert.equal(response.status,200);const result=JSON.parse(response.body);
  assert.equal(result.trades.length,3);assert.equal(result.accountLedger.at(-1).accountValue,result.accountLedger.at(-1).benchmarkValue);
  assert.equal(result.temporalEligibility.status,'not_point_in_time_verified');assert.equal(result.calculationSources.length,3);
  assert.equal(result.requestId,undefined);assert.equal(result.artifactId,undefined);
  assert.equal((await dispatchRequest({}, {method:'POST',url:'/api/modules/factors/v1/legacy-dca/preview',body:JSON.stringify({...body,sourceSha256:'0'.repeat(64)})})).status,409);
  assert.equal((await dispatchRequest({}, {method:'PUT',url:'/api/modules/factors/v1/legacy-dca/preview',body:JSON.stringify(body)})).status,405);
});
