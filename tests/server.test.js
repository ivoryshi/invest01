import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../apps/api/server.js';
import { createFrozenSnapshotStore } from '../modules/factors/src/frozen-snapshots.js';
import { factorDataAssets, factorSnapshotCandidates } from '../packages/contracts/factors.js';
import { fundMetadataEditPayload } from '../apps/web/fund-screen-state.js';
import { request } from './helpers.js';

const factorSubmissionsPath = new URL('../var/factors/library-submissions.json', import.meta.url);
const factorConfigsPath = new URL('../var/factors/experiment-configs.json', import.meta.url);
const factorRunRequestsPath = new URL('../var/factors/run-requests.json', import.meta.url);
const factorResultArtifactsPath = new URL('../var/factors/result-artifacts.json', import.meta.url);

// Runtime stores are intentionally absent from a fresh Git checkout.
await mkdir(new URL('../var/factors/',import.meta.url),{recursive:true});
for (const file of [factorSubmissionsPath,factorConfigsPath,factorRunRequestsPath,factorResultArtifactsPath]) {
  try { await writeFile(file,'{"schemaVersion":1,"module":"factors","items":[]}',{flag:'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

test('local API and public asset boundaries', async t => {
  const server = createServer();
  await t.test('health states data is not connected', async () => {
    const response = await request(server, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.json().dataConnected, false);
  });
  await t.test('module status separates copied UI from live data', async () => {
    const { items } = (await request(server, '/api/workspaces')).json();
    assert.deepEqual(items.map(x => x.id), ['observatory', 'research', 'factors', 'knowledge', 'portfolio', 'lance', 'daily']);
    assert.equal(items.filter(x=>x.status==='native_module').length,1);
    assert.equal(items.filter(x=>x.status==='readonly_index').length,1);
    assert.equal(items.find(x=>x.id==='daily').status,'paused_archive');
    assert.ok(items.filter(x=>!x.href && !['research','daily'].includes(x.id)).every(x=>x.status==='not_connected'));
  });
  await t.test('core contract exposes shared N02 fields', async () => {
    const contract = (await request(server, '/api/contracts/v1/core')).json();
    assert.equal(contract.status, 'draft_contract');
    assert.ok(contract.pausedModules.includes('daily'));
    assert.ok(contract.entityTypes.some(x => x.id === 'security'));
    assert.ok(contract.sourceRecord.required.includes('asOfDate'));
    assert.ok(contract.artifactRecord.statuses.includes('superseded'));
    assert.ok(contract.taskRecord.statuses.includes('blocked'));
  });
  await t.test('factor contract fixes experiment snapshot and result artifact shape', async () => {
    const contract = (await request(server, '/api/contracts/v1/factors')).json();
    assert.equal(contract.status, 'contract_only');
    assert.ok(contract.snapshotRecord.required.includes('snapshotId'));
    assert.ok(contract.factorDefinitionRecord.required.includes('missingValuePolicy'));
    assert.ok(contract.experimentRecord.required.includes('comparisonLimits'));
    assert.ok(contract.resultArtifactRecord.metrics.includes('informationCoefficient'));
    assert.ok(contract.comparisonLimits.some(x => x.includes('snapshotId')));
  });
  await t.test('factor data assets register existing wide tables and update scripts', async () => {
    const assets = (await request(server, '/api/modules/factors/v1/assets')).json();
    assert.equal(assets.mode, 'readonly_data_asset_index');
    assert.ok(assets.items.some(x => x.assetId === 'factors.fund_warehouse.wide_today'));
    assert.ok(assets.items.some(x => x.assetId === 'factors.fund_warehouse.monthly_update'));
    assert.ok(assets.items.some(x => x.assetType === 'parquet_panel'));
    assert.ok(assets.items.every(x => Object.hasOwn(x, 'exists')));
  });
  await t.test('factor snapshot candidates map assets without running backtests', async () => {
    const snapshots = (await request(server, '/api/modules/factors/v1/snapshots')).json();
    assert.equal(snapshots.mode, 'readonly_snapshot_candidates');
    assert.ok(snapshots.items.some(x => x.snapshotId === 'snapshot.fund_warehouse.wide_today.current'));
    assert.ok(snapshots.items.some(x => x.comparisonGroup === 'industry_factor_backtest'));
    assert.ok(snapshots.items.every(x => Array.isArray(x.assets)));
    assert.ok(snapshots.items.some(x => x.limitations.includes('do_not_mix_with_fund_cross_section')));
  });
  await t.test('factor definition candidates map source registry slots', async () => {
    const definitions = (await request(server, '/api/modules/factors/v1/definitions')).json();
    assert.equal(definitions.mode, 'readonly_factor_definition_candidates');
    assert.equal(definitions.count, 4);
    assert.equal(definitions.slotCount, 14);
    assert.ok(definitions.items.some(x => x.factorId === 'factor.value'));
    assert.ok(definitions.items.some(x => x.factorId === 'factor.crowding' && x.direction === 'lower_is_better'));
    assert.ok(definitions.timing.some(x => x.timingId === 'timing.pe_decile_gate'));
  });
  await t.test('common factor library registers fields before computing values', async () => {
    const library = (await request(server, '/api/modules/factors/v1/library')).json();
    assert.equal(library.mode, 'editable_common_factor_library');
    assert.equal(library.count, 12);
    assert.equal(library.fieldCount, 64);
    assert.equal(library.builtinCount, 12);
    assert.ok(library.items.some(x => x.factorFamilyId === 'library.industry.value'));
    assert.ok(library.items.some(x => x.factorFamilyId === 'library.fund.benchmark_relative'));
    assert.ok(library.items.some(x => x.factorFamilyId === 'library.industry.low_volatility'));
    assert.ok(library.items.some(x => x.factorFamilyId === 'library.fund.manager_product_structure'));
    assert.ok(library.items.some(x => x.fields.some(field => field.field === '信息比率')));
    assert.ok(library.items.some(x => x.fields.some(field => field.field === 'manager_tenure_days' && field.status === 'candidate')));
    assert.ok(library.items.every(x => Array.isArray(x.snapshotIds) && x.snapshotIds.length > 0));
  });
  await t.test('factor lab framework maps migration capabilities and usage records', async () => {
    const framework = (await request(server, '/api/modules/factors/v1/lab-framework')).json();
    assert.equal(framework.mode, 'native_factor_lab_migration_framework');
    assert.equal(framework.capabilityCount, 11);
    assert.ok(framework.factorInventory.some(x => x.factorFamilyId === 'library.industry.value' && x.fields.length >= 5));
    assert.ok(framework.capabilities.some(x => x.requirementRef === '2.8' && x.capabilityId === 'lab.alpha_smart_beta_attribution'));
    assert.ok(framework.capabilities.some(x => x.requirementRef === '2.10' && x.configFields.includes('dataScope')));
    assert.ok(framework.strategyTemplates.some(x => x.strategyTemplateId === 'strategy.monthly_dca_three_bucket'));
    assert.ok(framework.resultViews.some(x => x.viewId === 'view.error_sensitivity'));
    assert.ok(framework.usageRecords.artifactCandidates.every(x => x.computePolicy === 'manual_only_not_executed'));
  });
  await t.test('factor visual lab exposes old exported charts without rerunning backtests', async () => {
    const visual = (await request(server, '/api/modules/factors/v1/visual-lab')).json();
    assert.equal(visual.mode, 'readonly_native_visual_lab_from_old_exports');
    assert.equal(visual.computePolicy, 'read_exported_results_only_no_backtest');
    assert.ok(visual.series.spec.length > 20);
    assert.ok(visual.account.strategy.length > 20);
    assert.ok(visual.kpis.strategyIrr);
    assert.ok(visual.factorPositioning.some(x => x.key === 'value'));
    assert.ok(visual.factorStudy.attribution.some(x => x.key === 'residual'));
    assert.ok(visual.sensitivity.length >= 5);
  });
  await t.test('factor experiment comparison exposes native lab comps metrics', async () => {
    const comparison = (await request(server, '/api/modules/factors/v1/experiment-comparison')).json();
    assert.equal(comparison.mode, 'readonly_experiment_comparison_from_legacy_lab_comps');
    assert.equal(comparison.computePolicy, 'read_lab_comps_export_only_no_backtest_no_old_script');
    assert.equal(comparison.count, 13);
    assert.equal(comparison.variants.length, 8);
    assert.ok(comparison.items.some(x => x.key === 'B_equal' && x.metrics.finalValue > 1));
    assert.ok(comparison.items.some(x => x.key === 'B_base' && x.metrics.validStartDate));
    assert.ok(comparison.items.every(x => Array.isArray(x.series)));
  });
  await t.test('factor product state exposes full native lab workflow', async () => {
    const state = (await request(server, '/api/modules/factors/v1/product-state')).json();
    assert.equal(state.mode, 'native_factor_lab_product_state');
    assert.equal(state.computePolicy, 'configuration_and_exported_results_only_no_backtest');
    assert.ok(state.workflow.some(x => x.step === 'strategy_config' && x.status === 'editable'));
    assert.ok(state.strategyTools.some(x => x.strategyTemplateId === 'strategy.monthly_dca_three_bucket' && x.editableNow));
    assert.ok(state.customFactorBuilder.validationRules.includes('must_bind_snapshot'));
    assert.ok(state.resultComparison.metrics.some(x => x.metric === 'IRR'));
    assert.ok(state.factorPositioning.some(x => x.key === 'value'));
    assert.ok(state.errorModel.some(x => x.errorId === 'lookahead_risk'));
    assert.ok(state.scoringAndBacktestLogic.steps.includes('attributeExcess'));
  });
  await t.test('factor library accepts local submissions and revisions', async () => {
    const original = await readFile(factorSubmissionsPath, 'utf8');
    try {
      const payload = {
        factorFamilyId: 'library.custom.test_factor',
        title: '测试因子',
        universe: 'public_funds',
        category: 'custom',
        frequency: 'monthly',
        sourceAssetIds: ['factors.fund_warehouse.wide_today'],
        snapshotIds: ['snapshot.fund_warehouse.wide_today.current'],
        calculationLogic: 'score = zscore(metric_a) - zscore(metric_b)',
        usageLogic: '仅用于表单提交回归测试，不进入真实实验。',
        fields: [{
          field: 'metric_a',
          name: '指标A',
          role: 'sub_factor',
          formula: 'metric_a raw value',
          direction: 'higher_is_better',
          missingValuePolicy: 'missing remains missing',
          definition: '测试字段定义',
          usageLogic: '测试字段使用逻辑',
          comments: '测试注释',
        }],
      };
      const created = await request(server, '/api/modules/factors/v1/library/submissions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.factorFamilyId, payload.factorFamilyId);
      const listed = (await request(server, '/api/modules/factors/v1/library')).json();
      assert.ok(listed.items.some(x => x.factorFamilyId === payload.factorFamilyId));
      assert.equal(listed.submittedCount, 1);
      const revised = await request(server, `/api/modules/factors/v1/library/submissions/${payload.factorFamilyId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload, usageLogic: '修改后的使用逻辑。' }),
      });
      assert.equal(revised.status, 200);
      assert.equal(revised.json().item.revision, 2);
    } finally {
      await writeFile(factorSubmissionsPath, original);
    }
  });
  await t.test('factor experiment config tool saves drafts without running backtests', async () => {
    const original = await readFile(factorConfigsPath, 'utf8');
    try {
      const index = (await request(server, '/api/modules/factors/v1/experiment-configs')).json();
      assert.equal(index.mode, 'local_experiment_config_drafts');
      assert.ok(index.templates.some(x => x.templateId === 'template.industry_monthly_topn'));
      const payload = {
        configId: 'config.test_factor_experiment',
        title: '测试因子实验配置',
        snapshotId: 'snapshot.etf_smartbeta.industry_panel.current',
        factorFamilyIds: ['library.industry.value', 'library.industry.momentum'],
        benchmarkId: 'factors.etf_smartbeta.bench',
        universe: 'sw_industry_and_etf_proxy',
        portfolioRule: 'monthly top 3 equal weight',
        rebalanceCalendar: 'month_first_trading_day',
        costModel: 'commission=0.00025; slippage=0.0005',
        constraints: ['same_snapshot_only'],
        comparisonLimits: ['same benchmark and cost only'],
        factorWeights: [{ factorFamilyId: 'library.industry.value', weight: 0.55 }, { factorFamilyId: 'library.industry.momentum', weight: 0.45 }],
        strategySettings: { topN: 3, weightingMethod: 'score_weighted', rebalanceFrequency: 'monthly' },
        transactionSettings: { frequency: 'monthly', amount: 10000, buyRule: 'fixed monthly buy' },
        notes: '只用于配置保存测试，不运行回测。',
      };
      const created = await request(server, '/api/modules/factors/v1/experiment-configs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.runPolicy, 'save_config_only_no_backtest');
      assert.equal(created.json().item.factorWeights.length, 2);
      assert.equal(created.json().item.strategySettings.topN, 3);
      assert.equal(created.json().item.transactionSettings.amount, 10000);
      const revised = await request(server, `/api/modules/factors/v1/experiment-configs/${payload.configId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload, notes: '修改后的配置备注。' }),
      });
      assert.equal(revised.status, 200);
      assert.equal(revised.json().item.revision, 2);
    } finally {
      await writeFile(factorConfigsPath, original);
    }
  });
  await t.test('factor execution plan prepares run requests without running backtests', async () => {
    const originalConfigs = await readFile(factorConfigsPath, 'utf8');
    let originalRequests = '{"schemaVersion":1,"module":"factors","items":[]}';
    let originalResults = '{"schemaVersion":1,"module":"factors","items":[]}';
    try { originalRequests = await readFile(factorRunRequestsPath, 'utf8'); } catch {}
    try { originalResults = await readFile(factorResultArtifactsPath, 'utf8'); } catch {}
    try {
      const configPayload = {
        configId: 'config.test_execution_ready',
        title: '测试执行准备配置',
        strategyTemplateId: 'strategy.factor_rotation_topn',
        snapshotId: 'snapshot.etf_smartbeta.industry_panel.current',
        factorFamilyIds: ['library.industry.value'],
        benchmarkId: 'factors.etf_smartbeta.bench',
        universe: 'sw_industry_and_etf_proxy',
        portfolioRule: 'monthly top 3 equal weight',
        rebalanceCalendar: 'monthly',
        costModel: 'commission=0.00025',
        strategySettings: { topN: 3, weightingMethod: 'equal_weight' },
      };
      await request(server, '/api/modules/factors/v1/experiment-configs', { method: 'POST', body: JSON.stringify(configPayload) });
      const plan = (await request(server, '/api/modules/factors/v1/execution-plan')).json();
      assert.equal(plan.mode, 'execution_preflight_plan_no_backtest');
      assert.ok(plan.configReadiness.some(x => x.configId === configPayload.configId && x.readyForPreflight));
      assert.ok(plan.engineCandidates.some(x => x.artifactCandidateId === 'artifact.factor.backtest.monthly_dca_engine'));
      const created = await request(server, '/api/modules/factors/v1/run-requests', {
        method: 'POST',
        body: JSON.stringify({ configId: configPayload.configId, title: '测试运行请求' }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.status, 'prepared_no_execution');
      assert.equal(created.json().item.computePolicy, 'prepare_request_only_no_backtest');
      const executed = await request(server, `/api/modules/factors/v1/run-requests/${created.json().item.requestId}/execute`, { method: 'POST' });
      assert.equal(executed.status, 200);
      assert.equal(executed.json().item.status, 'completed_local_result_artifact');
      assert.equal(executed.json().resultArtifact.computePolicy, 'panel_json_monthly_cross_section_engine_v1_no_fetch_no_old_script');
      assert.equal(executed.json().resultArtifact.executionMode, 'native_workbench_panel_json_monthly_topn_v1');
      assert.ok(executed.json().resultArtifact.metrics.excessIrr !== undefined);
      assert.ok(executed.json().resultArtifact.metrics.informationCoefficient !== undefined);
      assert.ok(executed.json().resultArtifact.attribution.factorDiagnostics.some(x => x.factorKey === 'value'));
      assert.ok(executed.json().resultArtifact.holdings.length > 0);
      const results = (await request(server, '/api/modules/factors/v1/result-artifacts')).json();
      assert.equal(results.mode, 'local_factor_result_artifacts');
      assert.ok(results.items.some(x => x.requestId === created.json().item.requestId));
      const detail = (await request(server, `/api/modules/factors/v1/result-artifacts/${executed.json().resultArtifact.artifactId}`)).json();
      assert.equal(detail.mode, 'local_factor_result_artifact_detail');
      assert.equal(detail.item.artifactId, executed.json().resultArtifact.artifactId);
      assert.ok(detail.reviewChecklist.some(x => x.checkId === 'warning_review' && x.status === 'review_required'));
    } finally {
      await writeFile(factorConfigsPath, originalConfigs);
      await writeFile(factorRunRequestsPath, originalRequests);
      await writeFile(factorResultArtifactsPath, originalResults);
    }
  });
  await t.test('factor data layer exposes wide tables update jobs and legacy exports', async () => {
    const dataLayer = (await request(server, '/api/modules/factors/v1/data-layer')).json();
    assert.equal(dataLayer.mode, 'factor_data_layer_control_plane');
    assert.ok(dataLayer.assets.some(x => x.assetId === 'factors.fund_warehouse.wide_today'));
    assert.ok(dataLayer.updateJobs.some(x => x.jobId === 'job.factor_data.monthly_update_script'));
    const monthlyAsset = dataLayer.assets.find(x => x.assetId === 'factors.fund_warehouse.monthly_update');
    assert.equal(dataLayer.updateJobs.find(x => x.jobId === 'job.factor_data.monthly_update_script').status, monthlyAsset.exists ? 'ready_manual' : 'documented');
    assert.ok(dataLayer.legacyExports.some(x => x.title === 'report.json' && x.migrationStatus === 'used_by_native_factor_lab'));
    assert.equal(dataLayer.computePolicy, 'metadata_and_update_job_registry_no_fetch');
    assert.equal(dataLayer.databaseMaintenance.status, 'offline_manual_tools_available');
    assert.equal(dataLayer.databaseMaintenance.policy, 'explicit_offline_no_fetch_no_schedule_restore_to_new_only');
    assert.match(dataLayer.databaseMaintenance.restoreCommand, /--output <new-file>/);
  });
  await t.test('broad DCA execution recomputes from parquet and rejects unsupported policies', async () => {
    const paths = [factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath];
    const originals = await Promise.all(paths.map(async file => {
      try { return await readFile(file, 'utf8'); } catch { return '{"schemaVersion":1,"module":"factors","items":[]}'; }
    }));
    const frozenRoot = await mkdtemp(path.join(os.tmpdir(), 'dca-frozen-api-'));
    const store = createFrozenSnapshotStore({ root: frozenRoot, assets: factorDataAssets, candidates: factorSnapshotCandidates });
    const frozenServer = createServer({ snapshotStore: store });
    try {
      const config = {
        configId: 'config.test_broad_dca', title: '宽基定投执行测试', strategyTemplateId: 'strategy.monthly_dca_three_bucket',
        snapshotId: 'snapshot.etf_smartbeta.broad_panel.current', factorFamilyIds: [], benchmarkId: 'hs300_total_return',
        portfolioRule: 'fixed broad DCA', rebalanceCalendar: 'monthly', costModel: 'commission=0;slippage=0;broad_fee=0',
        transactionSettings: { startDate: '2020-01-01', endDate: '2020-06-30', frequency: 'monthly', amount: 100,
          targetId: 'hs300_total_return', cashBucketPolicy: 'broad_only', executionRule: 'fixed_contribution_hold' },
      };
      const createdConfig = await request(server, '/api/modules/factors/v1/experiment-configs', { method: 'POST', body: JSON.stringify(config) });
      assert.equal(createdConfig.status, 201);
      const plan = (await request(server, '/api/modules/factors/v1/execution-plan')).json();
      assert.ok(plan.configReadiness.find(item => item.configId === config.configId).readyForPreflight);
      const created = await request(server, '/api/modules/factors/v1/run-requests', { method: 'POST', body: JSON.stringify({ configId: config.configId }) });
      const executeUrl = `/api/modules/factors/v1/run-requests/${created.json().item.requestId}/execute`;
      const first = await request(server, executeUrl, { method: 'POST' });
      assert.equal(first.status, 200);
      const result = first.json().resultArtifact;
      assert.equal(result.executionMode, 'native_workbench_parquet_broad_dca_v1');
      assert.equal(result.metrics.totalContributed, 600);
      assert.equal(result.cashFlows.length, 6);
      assert.ok(result.accountLedger.length > 50);
      assert.equal(result.metrics.finalValue, result.metrics.benchmarkFinalValue);
      assert.match(result.dataScope.sourceVersion.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.attribution.alphaReturn, null);
      assert.equal(result.attribution.status, 'computed_cashflow_accounting_v1');
      assert.equal(result.attribution.unit, 'account_currency');
      assert.ok(Math.abs(result.attribution.reconciliation.error) < 1e-7);
      assert.equal(result.attribution.daily.length, result.accountLedger.length);
      assert.match(result.dataScope.calculationSourceSha256, /^[a-f0-9]{64}$/);
      const detail = (await request(server, `/api/modules/factors/v1/result-artifacts/${result.artifactId}`)).json();
      assert.equal(detail.reviewChecklist.find(item => item.checkId === 'factor_diagnostics').status, 'not_applicable');
      config.transactionSettings.amount = 200;
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const second = (await request(server, executeUrl, { method: 'POST' })).json().resultArtifact;
      assert.ok(Math.abs(second.metrics.finalValue - 2 * result.metrics.finalValue) < 1e-8);
      assert.ok(Math.abs(second.metrics.moneyWeightedIrr - result.metrics.moneyWeightedIrr) < 1e-8);
      assert.equal(second.configSnapshot.configRevision, 2);
      const frozen = (await store.freeze(config.snapshotId)).item;
      config.snapshotId = frozen.snapshotId;
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const frozenResponse = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(frozenResponse.status, 200, frozenResponse.text());
      const frozenResult = frozenResponse.json().resultArtifact;
      assert.equal(frozenResult.metrics.finalValue, second.metrics.finalValue);
      assert.equal(frozenResult.dataScope.frozenSnapshot.snapshotId, frozen.snapshotId);
      assert.equal(frozenResult.dataScope.frozenSnapshot.verification, 'sha256_verified');
      assert.equal(frozenResult.dataScope.sourceVersion.sha256, frozen.files.find(item => item.assetId === 'factors.etf_smartbeta.broad').sha256);
      config.transactionSettings.cashBucketPolicy = 'bucket_a_b_c';
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const before = (await request(server, '/api/modules/factors/v1/result-artifacts')).json().count;
      const rejected = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(rejected.status, 422);
      assert.equal(rejected.json().error, 'unsupported_dca_bucket_policy');
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, before);
    } finally {
      await Promise.all(paths.map((file, index) => writeFile(file, originals[index])));
      await rm(frozenRoot, { recursive: true, force: true });
    }
  });
  await t.test('fund wide screen binds actual fields exact groups and saved result versions', async () => {
    const paths = [factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath];
    const originals = await Promise.all(paths.map(file => readFile(file, 'utf8')));
    const frozenRoot = await mkdtemp(path.join(os.tmpdir(), 'fund-frozen-api-'));
    const store = createFrozenSnapshotStore({ root: frozenRoot, assets: factorDataAssets, candidates: factorSnapshotCandidates });
    const frozenServer = createServer({ snapshotStore: store });
    try {
      const options = (await request(server, '/api/modules/factors/v1/fund-screen/options')).json();
      assert.equal(options.mode, 'fund_screen_field_bindings_header_only');
      assert.ok(options.rankableCount > 0);
      const fee = options.fields.find(item => item.field === '管理费率_pct');
      assert.equal(fee.sourceField, '管理费率');
      assert.ok(fee.rankable);
      assert.ok(options.fields.some(item => !item.available && item.factorFamilyId === 'library.fund.manager_product_structure'));
      const profileResponse = await request(server, '/api/modules/factors/v1/fund-screen/profile');
      assert.equal(profileResponse.status, 200);
      const profile = profileResponse.json();
      assert.ok(profile.rowCount > 0);
      assert.equal(profile.groups.reduce((sum, item) => sum + item.rowCount, 0), profile.rowCount);
      const group = profile.groups.filter(item => item.comparisonGroup.strategyType && item.comparisonGroup.frequency).sort((a, b) => b.primaryCount - a.primaryCount)[0];
      const field = options.fields.find(item => item.field === '年化收益_pct');
      assert.ok(field.rankable);
      const config = {
        configId: 'config.test_fund_screen', title: '基金同组筛选测试', strategyTemplateId: 'strategy.fund_cross_section_screen',
        snapshotId: 'snapshot.fund_warehouse.wide_today.current', factorFamilyIds: [field.factorFamilyId], benchmarkId: 'fund_mapped_benchmark',
        portfolioRule: 'same_group_rank', rebalanceCalendar: 'manual_snapshot_review', costModel: 'cross_section_no_transaction_cost',
        strategySettings: { comparisonGroup: group.comparisonGroup, rankFields: [{ factorFamilyId: field.factorFamilyId, field: field.field, weight: 1 }], sourceSha256: profile.sourceVersion.sha256, topN: 3, missingValuePolicy: 'exclude', primaryShareOnly: true },
      };
      assert.equal((await request(server, '/api/modules/factors/v1/experiment-configs', { method: 'POST', body: JSON.stringify(config) })).status, 201);
      const created = await request(server, '/api/modules/factors/v1/run-requests', { method: 'POST', body: JSON.stringify({ configId: config.configId }) });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.artifactCandidateId, 'artifact.factor.fund_cross_section_screen');
      const executeUrl = `/api/modules/factors/v1/run-requests/${created.json().item.requestId}/execute`;
      const executed = await request(server, executeUrl, { method: 'POST' });
      assert.equal(executed.status, 200, JSON.stringify(executed.json()));
      const result = executed.json().resultArtifact;
      assert.equal(result.artifactType, 'fund_cross_section_screen');
      assert.equal(result.metrics.selectedCount, 3);
      assert.equal(result.dataScope.sourceVersion.sha256, profile.sourceVersion.sha256);
      assert.deepEqual(result.screening.comparisonGroup, group.comparisonGroup);
      assert.equal(result.screening.candidates[0].factorDetails.length, 1);
      assert.equal(result.screening.factorDefinitions[0].sourceField, field.sourceField);
      assert.ok(result.screening.filterAudit.some(item => item.filter === 'fund_or_share_deduplication'));
      assert.ok(!Object.hasOwn(result.metrics, 'annualizedReturn'));
      assert.deepEqual(result.series, {});
      const detail = (await request(server, `/api/modules/factors/v1/result-artifacts/${result.artifactId}`)).json();
      assert.equal(detail.reviewChecklist.find(item => item.checkId === 'field_bindings').status, 'ready');
      assert.equal(detail.reviewChecklist.find(item => item.checkId === 'historical_returns').status, 'not_applicable');
      const frozen = (await store.freeze(config.snapshotId)).item;
      config.snapshotId = frozen.snapshotId;
      const frozenProfile = await request(frozenServer, `/api/modules/factors/v1/fund-screen/profile?snapshotId=${frozen.snapshotId}`);
      assert.equal(frozenProfile.status, 200);
      assert.equal(frozenProfile.json().snapshotId, frozen.snapshotId);
      assert.equal(frozenProfile.json().sourceVersion.sha256, profile.sourceVersion.sha256);
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const frozenResponse = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(frozenResponse.status, 200, frozenResponse.text());
      assert.deepEqual(frozenResponse.json().resultArtifact.screening.candidates, result.screening.candidates);
      assert.equal(frozenResponse.json().resultArtifact.dataScope.frozenSnapshot.snapshotId, frozen.snapshotId);
      const before = (await request(server, '/api/modules/factors/v1/result-artifacts')).json().count;
      config.snapshotId = `snapshot.frozen.${'0'.repeat(64)}`;
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const missing = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(missing.status, 404);
      assert.equal(missing.json().error, 'frozen_snapshot_not_found');
      config.snapshotId = frozen.snapshotId;
      config.strategySettings.sourceSha256 = '0'.repeat(64);
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const rejected = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(rejected.status, 422);
      assert.equal(rejected.json().error, 'fund_source_version_changed_reload_profile');
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, before);
      config.strategySettings.sourceSha256 = profile.sourceVersion.sha256;
      config.strategySettings.rankFields = [];
      await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      assert.equal((await request(frozenServer, executeUrl, { method: 'POST' })).status, 422);
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, before);
      const frozenCsv = (await store.resolve(frozen.snapshotId, 'factors.fund_warehouse.wide_today')).storageRef;
      await chmod(frozenCsv, 0o600); await writeFile(frozenCsv, 'invalid');
      const corrupt = await request(frozenServer, executeUrl, { method: 'POST' });
      assert.equal(corrupt.status, 409);
      assert.equal(corrupt.json().error, 'frozen_snapshot_integrity_failed');
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, before);
      const saved = (await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`)).json().item;
      const metadataEdit = fundMetadataEditPayload(saved, { title: '不可用版本备注修订', notes: '保留原数据绑定，等待修复' });
      const updated = await request(server, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(metadataEdit) });
      assert.equal(updated.status, 200);
      assert.equal(updated.json().item.title, metadataEdit.title);
      assert.equal(updated.json().item.snapshotId, saved.snapshotId);
      assert.deepEqual(updated.json().item.strategySettings, saved.strategySettings);
      assert.equal((await request(frozenServer, executeUrl, { method: 'POST' })).status, 409);
    } finally {
      await Promise.all(paths.map((file, index) => writeFile(file, originals[index])));
      await rm(frozenRoot, { recursive: true, force: true });
    }
  });
  await t.test('raw industry parquet executes with frozen investability and rejects unsupported rules', async () => {
    const paths = [factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath];
    const originals = await Promise.all(paths.map(file => readFile(file, 'utf8')));
    const root = await mkdtemp(path.join(os.tmpdir(), 'industry-api-'));
    const store = createFrozenSnapshotStore({ root, candidates: factorSnapshotCandidates, assets: factorDataAssets });
    const frozenServer = createServer({ snapshotStore: store });
    try {
      const options = await request(server, '/api/modules/factors/v1/industry-engine/options');
      assert.equal(options.status, 200);
      assert.equal(options.json().families.length, 7);
      const config = {
        configId: 'config.test_industry_raw', title: '原始行业回測测试', strategyTemplateId: 'strategy.industry_parquet_monthly_topn',
        snapshotId: 'snapshot.etf_smartbeta.industry_execution.current', universe: 'sw_industry_and_etf_proxy',
        factorFamilyIds: ['library.industry.value'], factorWeights: [{ factorFamilyId: 'library.industry.value', weight: 1 }],
        benchmarkId: 'hs300_total_return', portfolioRule: 'monthly_topn_equal_weight_prior_signal', rebalanceCalendar: 'monthly',
        costModel: 'commission=0.00025;slippage=0.0005;annual_fee=0.006',
        strategySettings: { startDate: '2025-01-02', endDate: '2026-07-30', topN: 3, minInvestable: 8, signalLagDays: 1, weightingMethod: 'equal_weight', missingValuePolicy: 'neutral_with_coverage' },
      };
      assert.equal((await request(server, '/api/modules/factors/v1/experiment-configs', { method: 'POST', body: JSON.stringify(config) })).status, 201);
      const created = await request(server, '/api/modules/factors/v1/run-requests', { method: 'POST', body: JSON.stringify({ configId: config.configId }) });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.artifactCandidateId, 'artifact.factor.industry_parquet_topn');
      const execute = () => request(frozenServer, `/api/modules/factors/v1/run-requests/${created.json().item.requestId}/execute`, { method: 'POST' });
      const response = await execute();
      assert.equal(response.status, 200, response.text().slice(0, 500));
      const current = response.json().resultArtifact;
      assert.equal(current.executionMode, 'native_workbench_parquet_industry_topn_v1');
      assert.equal(current.metrics.moneyWeightedIrr, null);
      assert.ok(Number.isFinite(current.metrics.excessAnnualizedReturn));
      assert.equal(current.dataScope.sourceVersions.length, 3);
      assert.match(current.dataScope.calculationSourceSha256, /^[a-f0-9]{64}$/);
      assert.equal(current.configSnapshot.configRevision, 1);
      assert.ok(current.scoreHistory.every(row => row.signalDate < row.date));
      assert.ok(current.scoreHistory.at(-1).scores[0].factorDetails.length);
      assert.equal(current.sensitivity.length, 5);
      assert.ok(current.sensitivity.every(row => row.status === 'recomputed_same_captured_inputs'));
      assert.ok(current.riskModel.observations > 20);
      const frozen = await store.freeze(config.snapshotId);
      assert.equal(frozen.item.files.length, 3);
      config.snapshotId = frozen.snapshotId;
      const save = () => request(frozenServer, `/api/modules/factors/v1/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      assert.equal((await save()).status, 200);
      const frozenResponse = await execute();
      assert.equal(frozenResponse.status, 200);
      assert.deepEqual(frozenResponse.json().resultArtifact.metrics, current.metrics);
      assert.deepEqual(frozenResponse.json().resultArtifact.riskModel, current.riskModel);
      assert.deepEqual(frozenResponse.json().resultArtifact.sensitivity, current.sensitivity);
      assert.equal(frozenResponse.json().resultArtifact.dataScope.frozenSnapshot.snapshotId, frozen.snapshotId);
      config.strategySettings.topN = 1;
      await save();
      const topOne = await execute();
      assert.equal(topOne.status, 200);
      assert.notEqual(topOne.json().resultArtifact.metrics.finalValue, current.metrics.finalValue);
      assert.equal(topOne.json().resultArtifact.configSnapshot.configRevision, 3);
      const count = (await request(server, '/api/modules/factors/v1/result-artifacts')).json().count;
      config.strategySettings.weightingMethod = 'risk_budget';
      await save();
      const rejected = await execute();
      assert.equal(rejected.status, 422);
      assert.equal(rejected.json().error, 'unsupported_industry_portfolio_rule');
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, count);
      config.strategySettings.weightingMethod = 'equal_weight';
      config.snapshotId = 'snapshot.etf_smartbeta.industry_panel.current';
      await save();
      assert.equal((await execute()).status, 422);
      config.snapshotId = frozen.snapshotId;
      await save();
      const { storageRef } = await store.resolve(frozen.snapshotId, 'factors.etf_smartbeta.investable');
      await chmod(storageRef, 0o600); await writeFile(storageRef, 'corrupt');
      assert.equal((await execute()).status, 409);
      assert.equal((await request(server, '/api/modules/factors/v1/result-artifacts')).json().count, count);
    } finally {
      for (let i = 0; i < paths.length; i += 1) await writeFile(paths[i], originals[i]);
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test('three bucket current and eight-file frozen execution audits timing and fund flows', async () => {
    const paths = [factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath];
    const originals = [];
    for (const file of paths) originals.push(await readFile(file, 'utf8'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'three-bucket-api-'));
    const store = createFrozenSnapshotStore({ root, candidates: factorSnapshotCandidates, assets: factorDataAssets });
    const frozenServer = createServer({ snapshotStore: store });
    try {
      const prefix = '/api/modules/factors/v1';
      const options = await request(server, `${prefix}/three-bucket-engine/options`);
      assert.equal(options.status, 200, options.text().slice(0, 300));
      const template = (await request(server, `${prefix}/experiment-configs`)).json().templates.find(item => item.strategyTemplateId === 'strategy.legacy_three_bucket_monthly');
      assert.deepEqual(template.strategySettings, options.json().defaults);
      const config = { ...template, configId: 'config.test_three_bucket', title: '三档测试', strategySettings: { ...template.strategySettings, startDate: '2025-01-02' } };
      assert.equal((await request(server, `${prefix}/experiment-configs`, { method: 'POST', body: JSON.stringify(config) })).status, 201);
      const created = await request(server, `${prefix}/run-requests`, { method: 'POST', body: JSON.stringify({ configId: config.configId }) });
      assert.equal(created.status, 201);
      assert.equal(created.json().item.artifactCandidateId, 'artifact.factor.three_bucket_monthly');
      const execute = () => request(frozenServer, `${prefix}/run-requests/${created.json().item.requestId}/execute`, { method: 'POST' });
      const save = () => request(frozenServer, `${prefix}/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const response = await execute();
      assert.equal(response.status, 200, response.text().slice(0, 500));
      const current = response.json().resultArtifact;
      assert.equal(current.executionMode, 'native_workbench_three_bucket_monthly_v1');
      assert.equal(current.dataScope.sourceVersions.length, 8);
      assert.equal(current.dataScope.calculationSources.length, 3);
      assert.equal(current.sleeveMetrics.length, 3);
      assert.equal(current.cashFlows.length, 19);
      assert.equal(current.accountLedger.length, 381);
      assert.ok(current.timingHistory.every(row => row.signalDate < row.date && row.timing.components.every(c => !c.availableAt || c.availableAt <= row.signalDate)));
      assert.ok(current.cashFlows.every(row => Math.abs(Object.values(row.allocations).reduce((a,b) => a+b, 0) - row.amount) < 1e-8));
      assert.equal(current.attribution.alphaReturn, null);
      assert.equal(current.attribution.status, 'computed_cashflow_accounting_v1');
      assert.ok(Math.abs(current.attribution.reconciliation.error) < 1e-6);
      const frozen = await store.freeze(config.snapshotId);
      assert.equal(frozen.item.files.length, 8);
      config.snapshotId = frozen.snapshotId; assert.equal((await save()).status, 200);
      const frozenResponse = await execute(); assert.equal(frozenResponse.status, 200);
      assert.deepEqual(frozenResponse.json().resultArtifact.metrics, current.metrics);
      assert.deepEqual(frozenResponse.json().resultArtifact.attribution, current.attribution);
      assert.deepEqual(frozenResponse.json().resultArtifact.timingHistory, current.timingHistory);
      config.strategySettings.amount = 20000; await save();
      const larger = await execute(); assert.equal(larger.status, 200);
      assert.ok(Math.abs(larger.json().resultArtifact.metrics.finalValue - current.metrics.finalValue * 2) < .0001);
      config.strategySettings.peGate = 0; config.strategySettings.trendGate = true; await save();
      const gated = await execute(); assert.equal(gated.status, 200);
      assert.notEqual(gated.json().resultArtifact.metrics.finalValue, larger.json().resultArtifact.metrics.finalValue);
      config.costModel = 'commission=.01;slippage=.01;annual_fee=0'; await save();
      const costly = await execute(); assert.equal(costly.status, 200);
      assert.notEqual(costly.json().resultArtifact.metrics.finalValue, gated.json().resultArtifact.metrics.finalValue);
      const count = (await request(server, `${prefix}/result-artifacts`)).json().count;
      config.strategySettings.shiborLagMonths = 0; await save();
      assert.equal((await execute()).status, 422);
      config.strategySettings.shiborLagMonths = 1; config.snapshotId = 'snapshot.etf_smartbeta.broad_panel.current'; await save();
      assert.equal((await execute()).status, 422);
      config.snapshotId = frozen.snapshotId; await save();
      const { storageRef } = await store.resolve(frozen.snapshotId, 'factors.etf_smartbeta.macro_shibor');
      await chmod(storageRef, 0o600); await writeFile(storageRef, 'corrupt');
      assert.equal((await execute()).status, 409);
      assert.equal((await request(server, `${prefix}/result-artifacts`)).json().count, count);
    } finally {
      for (let i = 0; i < paths.length; i += 1) await writeFile(paths[i], originals[i]);
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test('fund database profile and fixed basket execution bind imported sources', async () => {
    const paths = [factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath], originals = [];
    for (const file of paths) originals.push(await readFile(file, 'utf8'));
    try {
      const prefix = '/api/modules/factors/v1';
      const catalog = await request(server, `${prefix}/fund-nav/catalog?q=014165`);
      assert.equal(catalog.status, 200, catalog.text().slice(0,300));
      assert.equal(catalog.json().database.storage, 'workbench_sqlite');
      assert.ok(catalog.json().items.some(x => x.shareCode === '014165' && x.historyAvailable));
      assert.equal((await request(server, `${prefix}/fund-nav/catalog`)).json().items.length, 0);
      const profileResponse = await request(server, `${prefix}/fund-nav/profile?codes=014165,021847&benchmarkId=CSI300`);
      assert.equal(profileResponse.status, 200, profileResponse.text().slice(0,500));
      const profile = profileResponse.json();
      assert.equal(profile.sourceVersions.length, 4); assert.equal(profile.storage, 'workbench_sqlite');
      assert.equal(profile.commonEndDate, '2026-07-31');
      const template = (await request(server, `${prefix}/experiment-configs`)).json().templates.find(x => x.strategyTemplateId === 'strategy.fund_nav_fixed_dca');
      const config = { ...template, configId: 'config.test_fund_nav', title: '基金历史数据库测试', strategySettings: { ...template.strategySettings,
        startDate: profile.commonStartDate, endDate: '2026-07-30', shares: [{ shareCode: '014165', weight: .5 }, { shareCode: '021847', weight: .5 }], sourceVersions: profile.sourceVersions } };
      assert.equal((await request(server, `${prefix}/experiment-configs`, { method: 'POST', body: JSON.stringify(config) })).status, 201);
      const created = await request(server, `${prefix}/run-requests`, { method: 'POST', body: JSON.stringify({ configId: config.configId }) });
      assert.equal(created.status, 201); assert.equal(created.json().item.artifactCandidateId, 'artifact.factor.fund_nav_fixed_dca');
      const execute = () => request(server, `${prefix}/run-requests/${created.json().item.requestId}/execute`, { method: 'POST' });
      const save = () => request(server, `${prefix}/experiment-configs/${config.configId}`, { method: 'PUT', body: JSON.stringify(config) });
      const response = await execute(); assert.equal(response.status, 200, response.text().slice(0,500));
      const result = response.json().resultArtifact;
      assert.equal(result.fundNavProfile.storage, 'workbench_sqlite'); assert.equal(result.dataScope.calculationSources.length, 3);
      assert.equal(result.dataScope.sourceVersions.length, 4); assert.equal(result.accountLedger.length, 265);
      assert.equal(result.attribution.alphaReturn, null); assert.ok(result.cashFlows.length > 10);
      assert.equal(result.attribution.status, 'computed_cashflow_accounting_v1');
      assert.equal(result.attribution.daily.length, result.accountLedger.length);
      assert.ok(Math.abs(result.attribution.reconciliation.error) < 1e-6);
      assert.ok(result.cashFlows.every(x => Math.abs(Object.values(x.allocations).reduce((a,b) => a+b,0)-x.amount) < 1e-8));
      config.strategySettings.amount *= 2; await save();
      const larger = await execute(); assert.equal(larger.status, 200);
      assert.ok(Math.abs(larger.json().resultArtifact.metrics.finalValue - 2*result.metrics.finalValue) < .0001);
      assert.ok(Math.abs(larger.json().resultArtifact.metrics.moneyWeightedIrr-result.metrics.moneyWeightedIrr) < 1e-8);
      config.costModel = 'subscription=.01;slippage=.01'; await save();
      const costly = await execute(); assert.equal(costly.status, 200); assert.ok(costly.json().resultArtifact.metrics.totalCost > 0);
      const count = (await request(server, `${prefix}/result-artifacts`)).json().count;
      config.strategySettings.sourceVersions[1].sha256 = '0'.repeat(64); await save(); assert.equal((await execute()).status, 409);
      // Restore a fresh read, since the deliberate tamper modified the local profile object.
      config.strategySettings.sourceVersions = (await request(server, `${prefix}/fund-nav/profile?codes=014165,021847&benchmarkId=CSI300`)).json().sourceVersions;
      config.strategySettings.endDate = '2026-09-30'; await save(); assert.equal((await execute()).status, 422);
      config.strategySettings.endDate = '2026-07-30'; config.costModel = 'subscription=0;slippage=0;annual_fee=.01'; await save(); assert.equal((await execute()).status, 422);
      assert.equal((await request(server, `${prefix}/result-artifacts`)).json().count, count);
      assert.equal((await request(server, `${prefix}/fund-nav/profile?codes=../x&benchmarkId=CSI300`)).status, 422);
      assert.equal((await request(server, `${prefix}/fund-nav/profile?codes=000000&benchmarkId=CSI300`)).status, 422);
      assert.ok(!(await request(server, `${prefix}/snapshots/frozen`)).json().freezeOptions.some(x => x.baseSnapshotId === config.snapshotId));
      assert.equal((await request(server, `${prefix}/snapshots/frozen`, { method: 'POST', body: JSON.stringify({ baseSnapshotId: config.snapshotId }) })).status, 422);
      assert.equal((await request(server, '/var/factors/fund-history.sqlite')).status, 404);
    } finally { for (let i=0; i<paths.length; i++) await writeFile(paths[i], originals[i]); }
  });
  await t.test('factor data layer schema probe reads bounded headers and panel structure', async () => {
    const schema = (await request(server, '/api/modules/factors/v1/data-layer/schema')).json();
    assert.equal(schema.mode, 'factor_data_schema_probe');
    assert.equal(schema.computePolicy, 'bounded_schema_probe_no_full_wide_table_read_no_fetch');
    assert.ok(schema.items.some(x => x.assetId === 'legacy.etf_smartbeta.out.panel_json' && x.fieldCount === 14));
    assert.ok(schema.items.some(x => x.assetId === 'factors.etf_smartbeta.panel' && x.status === 'parquet_schema_readable' && x.parquet.rowCount > 0));
    assert.ok(schema.items.some(x => x.assetId === 'factors.fund_warehouse.fof_db' && x.status === 'sqlite_schema_readable' && x.tables.some(table => table.name === 'wide_today')));
  });
  await t.test('factor data quality audit exposes coverage repair and turnover risk', async () => {
    const audit = (await request(server, '/api/modules/factors/v1/data-quality')).json();
    assert.equal(audit.mode, 'factor_data_quality_audit');
    assert.equal(audit.computePolicy, 'read_exported_quality_logs_and_schema_only_no_fetch_no_old_script');
    assert.ok(audit.coverage.raw.failureCount > 0);
    assert.equal(audit.coverage.repair.failureCount, 0);
    assert.ok(audit.schemaAudit.items.some(x => x.assetId === 'factors.fund_warehouse.fof_db' && x.status === 'sqlite_schema_readable'));
    assert.ok(audit.schemaAudit.items.some(x => x.assetId === 'factors.etf_smartbeta.panel' && x.status === 'parquet_schema_readable'));
    assert.ok(audit.turnoverAudit.items.some(x => x.factorKey === 'crowd' && x.costSensitivity === 'high'));
    assert.ok(audit.preBacktestChecks.some(x => x.checkId === 'no_network_execution' && x.status === 'ready'));
  });
  await t.test('factor data preview enforces registered assets query limits and version consistency', async () => {
    const prefix = '/api/modules/factors/v1/data-layer/preview?';
    assert.equal((await request(server, `${prefix}assetId=/etc/passwd`)).status, 404);
    assert.equal((await request(server, `${prefix}assetId=factors.fund_warehouse.monthly_update`)).status, 422);
    const asset = 'assetId=factors.etf_smartbeta.panel';
    for (const params of ['limit=0', 'limit=51', 'offset=-1', 'offset=NaN', 'startDate=2026-02-30', 'startDate=2026-03-01&endDate=2026-02-01']) {
      assert.equal((await request(server, `${prefix}${asset}&${params}`)).status, 422);
    }
    assert.equal((await request(server, `${prefix}${asset}&field=unknown`)).status, 422);
    const first = await request(server, `${prefix}${asset}&field=date&field=close&limit=2`);
    assert.equal(first.status, 200);
    const sample = first.json();
    assert.equal(sample.rowCount, 2);
    assert.ok(sample.totalRows > 5000);
    assert.deepEqual(sample.columns, ['date', 'close']);
    assert.ok(sample.rows.every(row => Object.keys(row).length === 2));
    assert.equal(sample.scope, 'returned_sample_only');
    assert.ok(sample.snapshotIds.includes('snapshot.etf_smartbeta.industry_panel.current'));
    const changed = await request(server, `${prefix}${asset}&sourceVersion=outdated`);
    assert.equal(changed.status, 409);
    const next = await request(server, `${prefix}${asset}&field=date&limit=2&offset=${sample.nextOffset}&sourceVersion=${encodeURIComponent(sample.sourceVersion.fingerprint)}`);
    assert.equal(next.status, 200);
    assert.equal(next.json().offset, sample.nextOffset);
  });
  await t.test('factor legacy experiment asset library standardizes old results', async () => {
    const legacy = (await request(server, '/api/modules/factors/v1/legacy-experiments')).json();
    assert.equal(legacy.mode, 'readonly_legacy_experiment_asset_library');
    assert.equal(legacy.computePolicy, 'read_legacy_export_summaries_only_no_old_script_no_fetch');
    assert.equal(legacy.count, 1);
    assert.ok(legacy.assetCount >= 8);
    const experiment = legacy.experiments[0];
    assert.equal(experiment.snapshotId, 'snapshot.etf_smartbeta.industry_panel.current');
    assert.ok(experiment.resultAssets.some(x => x.fileName === 'panel.json' && x.migrationStatus === 'used_by_panel_json_engine_v1'));
    assert.ok(experiment.standardizationMap.some(x => x.from === 'factor_study.decomp' && x.status === 'mapped'));
    assert.ok(experiment.attribution.factorDiagnostics.some(x => x.factorKey === 'value'));
    assert.ok(experiment.dataQuality.migrationWarnings.includes('legacy_results_are_imported_as_readonly_assets'));
  });
  await t.test('archived historical records query versions without serving original HTML', async () => {
    const list = await request(server, '/api/modules/factors/v1/legacy-archives'); assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json().items));
    for (const item of list.json().items) {
      const detail = await request(server, `/api/modules/factors/v1/legacy-archives/${item.archiveId}?category=backtest_scenario&limit=1`);
      assert.equal(detail.status, 200); assert.ok(detail.json().items.length <= 1);
      assert.equal(detail.json().verification, 'manifest_identity_only_not_file_integrity');
      const badLimit = await request(server, `/api/modules/factors/v1/legacy-archives/${item.archiveId}?limit=101`); assert.equal(badLimit.status, 422);
    }
    assert.equal((await request(server, '/api/modules/factors/v1/legacy-archives/not-a-version')).status, 422);
    assert.equal((await request(server, '/var/factors/legacy-archives/index.html')).status, 404);
    assert.equal((await request(server, '/api/modules/factors/v1/legacy-archives', { method: 'POST' })).status, 405);
  });
  await t.test('factor backtest engine status exposes active panel engine and migration path', async () => {
    const engine = (await request(server, '/api/modules/factors/v1/backtest-engine')).json();
    assert.equal(engine.mode, 'backtest_engine_status');
    assert.equal(engine.activeEngine.engineId, 'engine.factor.panel_json_monthly_topn_v1');
    assert.ok(engine.activeEngine.supportedSnapshotIds.includes('snapshot.etf_smartbeta.industry_panel.current'));
    assert.ok(engine.panelInput.monthCount > 100);
    assert.ok(engine.panelInput.factorCategoryCoverage.some(x => x.key === 'value' && x.fields.length >= 4));
    assert.ok(engine.nextEngines.some(x => x.engineId === 'engine.factor.parquet_panel_monthly_topn_v2'));
    assert.equal(engine.nextEngines.find(x => x.engineId === 'engine.factor.parquet_panel_monthly_topn_v2').status, 'active_for_explicit_parquet_industry_configs');
    assert.ok(engine.auditChecklist.some(x => x.checkId === 'lag_policy'));
  });
  await t.test('custom factor definition validation immutable revisions preview and industry execution', async () => {
    const paths = [factorSubmissionsPath, factorConfigsPath, factorRunRequestsPath, factorResultArtifactsPath], originals = [];
    for (const file of paths) originals.push(await readFile(file, 'utf8'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'custom-expression-api-'));
    const store = createFrozenSnapshotStore({ root, candidates: factorSnapshotCandidates, assets: factorDataAssets });
    const api = createServer({ snapshotStore: store });
    const post = (url, body, method = 'POST') => request(api, `/api/modules/factors/v1/${url}`, { method, body: JSON.stringify(body) });
    try {
      const options = await request(api, '/api/modules/factors/v1/custom-expression/options'); assert.equal(options.status, 200);
      const spec = options.json().defaultSpec;
      assert.equal((await post('custom-expression/validate', {})).status, 422);
      assert.equal((await post('custom-expression/validate', null)).status, 422);
      const unsafe = structuredClone(spec); unsafe.nodes[0].expression = '__import__("os").system("touch /tmp/unsafe")';
      assert.equal((await post('custom-expression/validate', { executionSpec: unsafe })).status, 422);
      unsafe.nodes[0].expression = 'lag(price, -1)'; assert.equal((await post('custom-expression/validate', { executionSpec: unsafe })).status, 422);
      unsafe.nodes[0].expression = 'valuation_value'; unsafe.nodes[1].expression = 'momentum_value';
      assert.equal((await post('custom-expression/validate', { executionSpec: unsafe })).status, 422);
      const makeDefinition = executionSpec => ({ factorFamilyId: 'library.custom.test_expression', title: '可执行自研测试', category: 'custom', universe: 'sw_industry_and_etf_proxy', frequency: 'daily_panel_monthly_rebalance',
        calculationLogic: 'declared AST nodes', usageLogic: 'industry proxy boundary', sourceAssetIds: ['factors.etf_smartbeta.panel'], snapshotIds: ['snapshot.etf_smartbeta.industry_execution.current'], executionSpec,
        fields: executionSpec.nodes.map(n => ({ field: n.id, name: n.id, role: 'sub_factor', formula: n.expression, definition: n.definition, direction: n.direction, missingValuePolicy: 'complete_case' })) });
      const rejected = await post('library/submissions', makeDefinition(unsafe)); assert.equal(rejected.status, 422);
      assert.equal(await readFile(factorSubmissionsPath, 'utf8'), originals[0]);
      const submitted = await post('library/submissions', makeDefinition(spec)); assert.equal(submitted.status, 201, submitted.text());
      assert.match(submitted.json().item.executionSha256, /^[a-f0-9]{64}$/);
      const family = (await request(api, '/api/modules/factors/v1/custom-expression/options')).json().families.find(x => x.factorFamilyId === 'library.custom.test_expression');
      const template = (await request(api, '/api/modules/factors/v1/experiment-configs')).json().templates.find(x => x.strategyTemplateId === 'strategy.custom_industry_expression');
      const config = { ...template, configId: 'config.test_custom_expression', factorFamilyIds: [family.factorFamilyId], factorWeights: [{ factorFamilyId: family.factorFamilyId, weight: 1 }], strategySettings: { ...template.strategySettings, factorProgram: family.program } };
      const tampered = structuredClone(config); tampered.strategySettings.factorProgram.executionSha256 = 'bad';
      assert.equal((await post('experiment-configs', tampered)).status, 409);
      const unknown = structuredClone(config); unknown.strategySettings.factorProgram.revision = 999;
      assert.equal((await post('experiment-configs', unknown)).status, 422);
      const genericTemplate = (await request(api, '/api/modules/factors/v1/experiment-configs')).json().templates.find(x => x.strategyTemplateId !== 'strategy.custom_industry_expression');
      const forged = { ...genericTemplate, configId: 'config.forged_expression', strategySettings: { ...genericTemplate.strategySettings, factorProgram: unknown.strategySettings.factorProgram } };
      assert.equal((await post('experiment-configs', forged)).status, 201);
      assert.equal((await post('experiment-configs', unknown)).status, 422, 'non-custom metadata is not proof of a registered formula revision');
      const save = () => post(`experiment-configs/${config.configId}`, config, 'PUT');
      const saved = await post('experiment-configs', config); assert.equal(saved.status, 201, saved.text());
      const before = await readFile(factorResultArtifactsPath, 'utf8');
      const preview = await post('custom-expression/preview', { config }); assert.equal(preview.status, 200, preview.text());
      assert.equal(preview.json().policy, 'same_date_calculation_preview_not_execution_signal');
      assert.ok(preview.json().ranked.length); assert.equal(preview.json().metrics, undefined);
      assert.equal(await readFile(factorResultArtifactsPath, 'utf8'), before);
      const created = await post('run-requests', { configId: config.configId }); assert.equal(created.status, 201);
      assert.equal(created.json().item.artifactCandidateId, 'artifact.factor.custom_industry_expression');
      const execute = () => post(`run-requests/${created.json().item.requestId}/execute`, {});
      const executed = await execute(); assert.equal(executed.status, 200, executed.text().slice(0, 500));
      const current = executed.json().resultArtifact;
      assert.equal(current.executionMode, 'native_workbench_custom_industry_expression_v1');
      assert.equal(current.factorProgram.revision, 1); assert.equal(current.dataScope.sourceVersions.length, 3);
      assert.equal(current.dataScope.calculationSources.length, 3); assert.ok(current.formulaAudit.dependencies.momentum_value.includes('price'));
      assert.equal(current.attribution.status, 'computed_industry_accounting_v1');
      assert.ok(Math.abs(current.attribution.reconciliation.error) < 1e-9);
      assert.equal(current.attribution.smartBetaReturn, null);
      assert.equal(current.attribution.daily.length, current.accountLedger.length);
      assert.ok(current.scoreHistory.every(x => x.signalDate < x.date)); assert.equal(current.metrics.moneyWeightedIrr, null);
      const revised = structuredClone(spec); revised.nodes[0].expression = 'pct_change(price, 63)';
      assert.equal((await post(`library/submissions/${family.factorFamilyId}`, makeDefinition(revised), 'PUT')).status, 200);
      config.notes = 'old formula metadata edit'; assert.equal((await save()).status, 200);
      const repeat = await execute(); assert.equal(repeat.status, 200);
      assert.deepEqual(repeat.json().resultArtifact.metrics, current.metrics); assert.equal(repeat.json().resultArtifact.factorProgram.revision, 1);
      const frozen = await store.freeze(config.snapshotId); config.snapshotId = frozen.snapshotId;
      assert.equal((await save()).status, 200); const frozenResult = await execute(); assert.equal(frozenResult.status, 200);
      assert.deepEqual(frozenResult.json().resultArtifact.metrics, current.metrics);
      config.strategySettings.factorProgram = (await request(api, '/api/modules/factors/v1/custom-expression/options')).json().families.find(x => x.factorFamilyId === family.factorFamilyId).program;
      assert.equal((await save()).status, 200); const upgraded = await execute(); assert.equal(upgraded.status, 200);
      assert.equal(upgraded.json().resultArtifact.factorProgram.revision, 2); assert.notEqual(upgraded.json().resultArtifact.metrics.finalValue, current.metrics.finalValue);
      const count = (await request(api, '/api/modules/factors/v1/result-artifacts')).json().count;
      const { storageRef } = await store.resolve(frozen.snapshotId, 'factors.etf_smartbeta.investable'); await chmod(storageRef, 0o600); await writeFile(storageRef, 'corrupt');
      assert.equal((await execute()).status, 409); assert.equal((await post('custom-expression/preview', { config })).status, 409);
      assert.equal((await request(api, '/api/modules/factors/v1/result-artifacts')).json().count, count);
    } finally {
      for (let i = 0; i < paths.length; i += 1) await writeFile(paths[i], originals[i]);
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test('factor artifact candidates map old experiment outputs without execution', async () => {
    const artifacts = (await request(server, '/api/modules/factors/v1/artifact-candidates')).json();
    assert.equal(artifacts.mode, 'readonly_artifact_candidates');
    assert.equal(artifacts.count, 8);
    assert.ok(artifacts.items.some(x => x.artifactCandidateId === 'artifact.factor.backtest.monthly_dca_engine'));
    assert.ok(artifacts.items.some(x => x.artifactType === 'loo_diagnostic'));
    assert.ok(artifacts.items.every(x => x.computePolicy === 'manual_only_not_executed'));
    assert.ok(artifacts.items.every(x => Object.hasOwn(x, 'exists')));
  });
  await t.test('registry exposes source artifact entity and task indexes', async () => {
    const sources = (await request(server, '/api/registry/v1/sources')).json();
    assert.equal(sources.registry, 'sources');
    assert.ok(sources.items.some(x => x.sourceId === 'observatory.source.pbc'));
    assert.ok(sources.items.every(x => x.moduleOwner === 'observatory'));
    const artifacts = (await request(server, '/api/registry/v1/artifacts?limit=5')).json();
    assert.equal(artifacts.registry, 'artifacts');
    assert.ok(artifacts.items.some(x => x.artifactId === 'observatory.research_config'));
    const factorArtifacts = (await request(server, '/api/registry/v1/artifacts?limit=100')).json();
    assert.ok(factorArtifacts.items.some(x => x.artifactId === 'factors.fund_warehouse.wide_today'));
    assert.ok(factorArtifacts.items.some(x => x.artifactId === 'artifact.factor.study.decomposition'));
    const entities = (await request(server, '/api/registry/v1/entities?limit=200')).json();
    assert.equal(entities.registry, 'entities');
    assert.ok(entities.items.some(x => x.entityType === 'company'));
    assert.ok(entities.items.some(x => x.entityType === 'macro_metric'));
    const tasks = (await request(server, '/api/registry/v1/tasks')).json();
    assert.equal(tasks.registry, 'tasks');
    assert.equal(tasks.count, 0);
  });
  await t.test('registry snapshot endpoint is explicit before generation', async () => {
    const response = await request(server, '/api/registry/v1/snapshot');
    assert.ok([200, 404].includes(response.status));
    if (response.status === 200) assert.equal(response.json().mode, 'readonly_snapshot');
    else assert.equal(response.json().error, 'snapshot_not_found');
  });
  await t.test('only public assets are reachable', async () => {
    for (const route of ['/', '/app.js', '/module-loader.js', '/fund-screen-state.js', '/styles.css']) assert.equal((await request(server, route)).status, 200);
    for (const route of ['/.env', '/package.json', '/AGENTS.md', '/%2e%2e/README.md', '/api/missing']) assert.equal((await request(server, route)).status, 404);
  });
  await t.test('writes rejected and HEAD has no response body', async () => {
    const response = await request(server, '/api/workspaces', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal((await request(server, '/', { method: 'HEAD' })).text(), '');
  });
});
