import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { acknowledgementsValid, fingerprint, workflowPolicy, workflowResultAudit, workflowVersion } from '../modules/factors/src/backtest-tools.js';
import { parseArgs, runTool } from '../scripts/factor-backtest.js';

const frozen = `snapshot.frozen.${'a'.repeat(64)}`;
const config = { configId: 'config.test', revision: 1, strategyTemplateId: 'strategy.fund_nav_fixed_dca', snapshotId: frozen };
test('guarded workflow distinguishes immutable inputs and historical information availability', () => {
  assert.deepEqual(workflowPolicy(config).blockers, []);
  assert.ok(workflowPolicy(config, 'point_in_time_verified').blockers.includes('historical_information_availability_not_verified'));
  assert.ok(workflowPolicy({ ...config, snapshotId: 'snapshot.fund_warehouse.nav_db.current' }).blockers.includes('frozen_snapshot_required'));
  assert.ok(workflowPolicy({ ...config, strategyTemplateId: 'strategy.fund_cross_section_screen' }).blockers.includes('strategy_not_supported_by_guarded_backtest'));
  assert.equal(workflowPolicy(config).temporalEligibility.availableAtField, null);
});
test('receipt identity preserves key independence but changes revision data or program', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  for (const changed of [{ ...config, revision: 2 }, { ...config, snapshotId: 'other' }, { ...config, extra: 'program' }]) assert.notEqual(fingerprint(config), fingerprint(changed));
});
test('acknowledgements require exact unique scope, no generic true', () => {
  const required = workflowPolicy(config).requiredAcknowledgements;
  assert.equal(acknowledgementsValid([...required].reverse(), required), true);
  for (const value of [true, [], [required[0],required[0]], [...required, 'extra']]) assert.equal(acknowledgementsValid(value, required), false);
});
test('audit never converts missing receipt or null research evidence into verified returns', () => {
  const audit = workflowResultAudit({ artifactId: 'result.old', metrics: { annualizedReturn: null } });
  assert.equal(audit.status, 'incomplete'); assert.equal(audit.temporalEligibility.status, 'not_point_in_time_verified');
  assert.ok(audit.checks.some(row => row.checkId === 'workflow_receipt_bound' && row.status === 'failed'));
  assert.equal(audit.verification, 'stored_result_structure_only_not_recalculation_or_pit');
});
test('CLI rejects arbitrary addresses and runs without explicit confirmation receipt', () => {
  for (const args of [['run','--config-id','config.test'], ['catalog','--port','http://example.com'], ['catalog','--url','http://example.com'], ['catalog','--port','0'], ['catalog','--port','4311','--port','4321'], ['preflight','--config-id','config.x','--confirm-execution']]) assert.throws(() => parseArgs(args));
});
test('CLI rejects known flags belonging to another command before any request', async () => {
  for (const args of [['catalog','--config-id','config.test'], ['audit','--artifact-id','result.test','--research-mode','assumption_simulation'], ['preflight','--config-id','config.test','--artifact-id','result.test'], ['run','--config-id','config.test','--artifact-id','result.other','--preflight-sha256','a'.repeat(64),'--confirm-execution','--acknowledge','x']]) {
    let calls = 0;
    await assert.rejects(runTool(args, async () => { calls++; }), /option_not_applicable/);
    assert.equal(calls, 0);
  }
});
test('CLI preflight stays read-only and blocked modes have distinct exit codes', async () => {
  const calls = [];
  const response = await runTool(['preflight','--config-id','config.test','--port','4323'], async (url, init) => {
    calls.push({url,init}); return { ok:true, json:async () => ({ready:false, blockers:['frozen_snapshot_required']}) };
  });
  assert.equal(response.exitCode, 2); assert.equal(calls.length,1); assert.equal(calls[0].init.method,undefined);
  assert.ok(calls[0].url.startsWith('http://127.0.0.1:4323/')); assert.equal(calls[0].init.redirect,'error');
});
test('CLI explicit run sends one guarded request and does not retry HTTP conflicts', async () => {
  let calls=0;
  const output = await runTool(['run','--config-id','config.test','--preflight-sha256','b'.repeat(64),'--confirm-execution','--acknowledge','not_point_in_time_verified,proxy_or_adjusted_nav_not_real_execution'], async (url,init) => {
    calls++; assert.equal(init.method,'POST'); assert.ok(url.endsWith('/backtest-tools/run'));
    const body=JSON.parse(init.body); assert.equal(body.researchMode,'assumption_simulation');
    return {ok:false,status:409,json:async()=>({error:'backtest_preflight_changed_repeat_review'})};
  });
  assert.equal(calls,1);assert.equal(output.exitCode,1);assert.equal(output.output.httpStatus,409);
});
test('all five guarded engine preflights reuse validators without running simulations', async () => {
  const run=promisify(execFile);
  const {stderr}=await run('python3',['-B','tests/factor_backtest_preflight_test.py'],{timeout:30000,maxBuffer:1024*1024});
  assert.match(stderr,/Ran 3 tests/);assert.match(stderr,/OK/);
});
