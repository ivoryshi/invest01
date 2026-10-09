import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, open as openFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { moduleAssets, readPublicAsset, modulePolicy } from './public-assets.js';
import { workspaces } from '../../packages/contracts/workspaces.js';
import { coreContract } from '../../packages/contracts/core.js';
import { commonFactorLibrary, factorArtifactCandidates, factorDataAssets, factorDefinitionCandidates, factorExperimentContract, factorLabCapabilityMap, factorResultViewSpecs, factorSnapshotCandidates, factorStrategyTemplates, factorTimingDefinitions } from '../../packages/contracts/factors.js';
import { createFrozenSnapshotStore, freezeBindings, frozenSnapshotIdValid } from '../../modules/factors/src/frozen-snapshots.js';
import { executePinnedPython } from '../../modules/factors/src/pinned-python.js';
import { listLegacyArchives, queryLegacyRecords, readLegacyArchive, readLegacyDcaSource } from '../../modules/factors/src/legacy-assets.js';
import { acknowledgementsValid, backtestSpecs, bytesHash, fingerprint, workflowPolicy, workflowResultAudit, workflowVersion } from '../../modules/factors/src/backtest-tools.js';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const oldResearchRoot = '/Users/samshi/dev/投研工具';
const oldFactorRoot = '/Users/samshi/Desktop/My Claude/etf-smartbeta';
const factorLibrarySubmissionFile = path.join(projectRoot, 'var/factors/library-submissions.json');
const factorExperimentConfigFile = path.join(projectRoot, 'var/factors/experiment-configs.json');
const factorRunRequestFile = path.join(projectRoot, 'var/factors/run-requests.json');
const factorResultArtifactFile = path.join(projectRoot, 'var/factors/result-artifacts.json');
const factorLegacyArchiveRoot = path.join(projectRoot, 'var/factors/legacy-archives');
const execFileAsync = promisify(execFile);
const defaultSnapshotStore = createFrozenSnapshotStore({ root: path.join(projectRoot, 'var/factors/frozen-snapshots'), candidates: factorSnapshotCandidates, assets: factorDataAssets, legacyArchiveRoot: factorLegacyArchiveRoot });
const legacyDcaEngine = { artifactCandidateId: 'artifact.factor.legacy_510300_pe_dca', title: '510300归档PE定投',
  artifactType: 'backtest_engine', computePolicy: 'frozen_archive_pe_lagged_vwap_simulation', inputSnapshotIds: ['snapshot.legacy.510300.archive'] };
const fundScreenEngine = {
  artifactCandidateId: 'artifact.factor.fund_cross_section_screen', title: '基金宽表同组筛选执行器',
  artifactType: 'cross_section_screen', status: 'local_execution_available',
  computePolicy: 'fund_csv_single_group_factor_rank_no_fetch_no_history_backtest',
  inputSnapshotIds: ['snapshot.fund_warehouse.wide_today.current'],
};
const industryEngine = {
  artifactCandidateId: 'artifact.factor.industry_parquet_topn', title: '原始行业Parquet月度TopN执行器',
  artifactType: 'backtest_engine', status: 'local_execution_available',
  computePolicy: 'raw_parquet_lagged_industry_topn_no_fetch_no_old_script',
  inputSnapshotIds: ['snapshot.etf_smartbeta.industry_execution.current'],
};
const customExpressionEngine = { ...industryEngine, artifactCandidateId: 'artifact.factor.custom_industry_expression', title: '自建公式行业月度TopN',
  computePolicy: 'bounded_ast_custom_factor_prior_signal_no_user_code' };
function expressionPythonOptions() { return { timeout: 60000, maxBuffer: 16*1024*1024,
  modules: ['industry_engine','factor_expression'].map(name => ({ name, path: path.join(projectRoot, `modules/factors/src/${name}.py`) })) }; }
async function expressionPython(mode, payload, paths) {
  const args = paths ? [mode, JSON.stringify(paths), JSON.stringify(payload)] : [mode, JSON.stringify(payload)];
  const result = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/custom_industry_engine.py'), args, expressionPythonOptions());
  const run = JSON.parse(result.stdout);
  if (run.error) throw Object.assign(new Error(run.error), { status: /hash_mismatch|source_changed/.test(run.error) ? 409 : 422 });
  return { ...result, run };
}
async function customSubmissionCheck(item) {
  if (!item.executionSpec) return;
  const { run } = await expressionPython('validate', item.executionSpec);
  const nodes = item.executionSpec.nodes;
  if (item.universe !== 'sw_industry_and_etf_proxy' || item.frequency !== 'daily_panel_monthly_rebalance'
    || !item.snapshotIds.includes(industryEngine.inputSnapshotIds[0]) || !item.sourceAssetIds.includes('factors.etf_smartbeta.panel')
    || item.fields.length !== nodes.length || new Set(item.fields.map(f => f.field)).size !== nodes.length
    || nodes.some(n => !item.fields.some(f => f.field === n.id && f.formula === n.expression && f.direction === n.direction && f.definition === n.definition && f.missingValuePolicy === 'complete_case'))) {
    throw Object.assign(new Error('custom_definition_fields_and_execution_must_match'), { status: 422 });
  }
  item.executionSha256 = run.executionSha256;
}
async function customConfigCheck(item, configs) {
  if (item.strategyTemplateId !== 'strategy.custom_industry_expression') return;
  const program = item.strategySettings?.factorProgram;
  if (!program) throw Object.assign(new Error('custom_program_binding_required'), { status: 422 });
  const { run } = await expressionPython('validate', program.executionSpec);
  if (run.executionSha256 !== program.executionSha256) throw Object.assign(new Error('custom_program_hash_mismatch'), { status: 409 });
  const library = await readFactorLibrarySubmissions();
  const current = library.items.some(f => f.factorFamilyId === program.factorFamilyId && f.revision === program.revision && f.executionSha256 === program.executionSha256);
  const recorded = configs.items.some(c => { const p = c.strategySettings?.factorProgram; return c.strategyTemplateId === 'strategy.custom_industry_expression' && p?.factorFamilyId === program.factorFamilyId && p.revision === program.revision && p.executionSha256 === program.executionSha256; });
  if (!current && !recorded) throw Object.assign(new Error('custom_program_revision_not_registered'), { status: 422 });
  await expressionPython('preflight', item);
}
async function legacyDcaApi(url, { method, body, json, snapshotStore }) {
  try {
    const frozenOptions = url.pathname.endsWith('/frozen-options');
    const options = frozenOptions || url.pathname.endsWith('/options');
    if (!(options ? ['GET','HEAD'].includes(method) : method === 'POST')) return json(405, {error:'method_not_allowed'});
    const parsed = options ? {value:{}} : parseJsonBody(body);
    if (parsed.error) return json(400, parsed);
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return json(422,{error:'legacy_dca_object_required'});
    if (!options && (Object.keys(parsed.value).some(key => !['archiveId','sourceSha256','parameters'].includes(key)) || !parsed.value.archiveId || !parsed.value.sourceSha256)) return json(422,{error:'legacy_dca_version_bound_parameters_required'});
    const archives = frozenOptions ? {items:[]} : await listLegacyArchives(factorLegacyArchiveRoot);
    const archiveId = options ? (url.searchParams.get('archiveId') || archives.items[0]?.archiveId) : parsed.value.archiveId;
    if (!archiveId && !frozenOptions) return json(404,{error:'legacy_dca_archive_not_found'});
    const frozen = frozenOptions ? await factorInput(url.searchParams.get('snapshotId'), 'factors.legacy.510300', legacyDcaEngine.inputSnapshotIds[0], snapshotStore) : null;
    const source = frozenOptions ? {storageRef:frozen.storageRef,sha256:frozen.expectedSha256,archiveId:frozen.snapshot.selection.archiveId,verification:'frozen_sha256_verified'} : await readLegacyDcaSource(factorLegacyArchiveRoot, archiveId);
    if (!options && parsed.value.sourceSha256 !== source.sha256) return json(409,{error:'legacy_dca_source_version_mismatch'});
    const directory = path.join(projectRoot, 'modules/factors/src');
    const {stdout,sourceHashes} = await executePinnedPython(path.join(directory,'legacy_dca_engine.py'), [source.storageRef,source.sha256,options?'options':'preview',JSON.stringify(parsed.value.parameters || {})],
      {timeout:30000,modules:['legacy_html_literals','dca_engine'].map(name=>({name,path:path.join(directory,`${name}.py`)}))});
    const run = JSON.parse(stdout);
    if (run.error) return json(run.error.includes('integrity')?409:422,{error:run.error});
    if (frozenOptions) await snapshotStore.verify(frozen.snapshot.snapshotId);
    else await readLegacyDcaSource(factorLegacyArchiveRoot, archiveId);
    const {storageRef,...sourceVersion} = source;
    return json(200,{...run,sourceVersion,calculationSources:sourceHashes,
      temporalEligibility:{status:'not_point_in_time_verified',reason:'估值观测日滞后不证明披露可得时间；当日VWAP与复权份额只作旧页面假设模拟。'},
      policy:'archived_native_replay_preview_no_config_request_result_write_no_fetch', readScope:frozenOptions?'frozen':'archive',
      ...(options?{archives:archives.items.filter(item=>item.assetCount>=13).map(item=>({archiveId:item.archiveId,createdAt:item.createdAt}))}:{})});
  } catch(error) {return json(error.status || (error.code==='ENOENT'?404:422),{error:error.code==='ENOENT'?'legacy_dca_archive_not_found':error.message});}
}
async function customExpressionApi(url, { method, body, json, snapshotStore }) {
  try {
    if (url.pathname.endsWith('/options') && ['GET','HEAD'].includes(method)) {
      const { run } = await expressionPython('options', {}); const library = await readFactorLibrarySubmissions();
      const families = library.items.filter(f => f.executionSpec).map(f => ({ factorFamilyId:f.factorFamilyId,title:f.title,
        program:{factorFamilyId:f.factorFamilyId,revision:f.revision,executionSha256:f.executionSha256,executionSpec:f.executionSpec} }));
      return json(200, { ...run, families });
    }
    if (method !== 'POST') return json(405, { error:'method_not_allowed' });
    const parsed = parseJsonBody(body); if (parsed.error) return json(400, parsed);
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return json(422, {error:'custom_object_required'});
    if (url.pathname.endsWith('/validate')) return json(200, (await expressionPython('validate', parsed.value.executionSpec)).run);
    const input = parsed.value.config;
    if (!input) return json(422, { error:'custom_config_required' });
    await customConfigCheck(input, await readFactorExperimentConfigs());
    const inputs = [];
    for (const id of ['panel','bench','investable']) inputs.push(await factorInput(input.snapshotId, `factors.etf_smartbeta.${id}`, industryEngine.inputSnapshotIds[0], snapshotStore));
    const { run } = await expressionPython('preview', input, inputs.map(x => x.storageRef));
    if (inputs.some((x,i) => x.expectedSha256 && x.expectedSha256 !== run.sourceVersions[i].sha256)) return json(409, { error:'frozen_snapshot_integrity_failed' });
    return json(200, run);
  } catch (error) { return json(error.status || 500, { error:error.status ? error.message : 'custom_expression_failed' }); }
}
const threeBucketEngine = {
  artifactCandidateId: 'artifact.factor.three_bucket_monthly', title: 'A/B/C三档月度定投执行器',
  artifactType: 'backtest_engine', status: 'local_execution_available',
  computePolicy: 'eight_parquet_three_bucket_lagged_signals_no_fetch',
  inputSnapshotIds: ['snapshot.etf_smartbeta.three_bucket_execution.current'],
};
const threeBucketSettings = { startDate: '2016-01-04', endDate: '2026-07-30', amount: 10000,
  bucketA: .6, bucketB: .2, bucketC: .2, hs300Weight: .5, topN: 3, minInvestable: 8,
  holdingLimitMonths: 12, holdingLimitPolicy: 'legacy_days_30_44', signalLagDays: 1, peGate: .8, peLookback: 2440, peMinObservations: 500,
  trendGate: false, missingPePolicy: 'open_with_warning', basisLookback: 500, basisMinObservations: 120,
  macroLookbackMonths: 60, macroMinObservations: 18, maxMacroAgeDays: 120, maxBasisAgeDays: 30,
  missingTimingPolicy: 'available_mean_else_neutral', neutralEquity: .5,
  pmiLagMonths: 1, m2LagMonths: 2, shiborLagMonths: 1,
  cashRate: .018, bondRate: .03, broadAnnualFee: .005, sectorAnnualFee: .006 };
function threeBucketPythonOptions() {
  return { timeout: 60000, maxBuffer: 12 * 1024 * 1024, modules: ['industry_engine', 'dca_engine'].map(name => ({ name, path: path.join(projectRoot, `modules/factors/src/${name}.py`) })) };
}
const fundNavEngine = { artifactCandidateId: 'artifact.factor.fund_nav_fixed_dca', title: '基金历史净值固定篮子定投', artifactType: 'backtest_engine', status: 'local_execution_available',
  computePolicy: 'manual_basket_sqlite_adjusted_nav_no_latest_factor_selection', inputSnapshotIds: ['snapshot.fund_warehouse.nav_db.current'] };
const fundNavSettings = { startDate: '2025-01-02', endDate: '2026-07-30', amount: 10000, frequency: 'monthly', calendarPolicy: 'common_observed_dates', maxGapDays: 14, benchmarkPolicy: 'same_flow_gross_index', shares: [], sourceVersions: [] };
function fundNavRoot() { return factorDataAssets.find(item => item.assetId === 'factors.fund_warehouse.nav_db').storageRef; }
async function fundNavPython(mode, payload, input = { storageRef: fundNavRoot(), expectedSha256: null }) {
  const result = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/fund_nav_engine.py'), [input.storageRef, mode, JSON.stringify(payload), input.expectedSha256 || ''], {
    timeout: 60000, maxBuffer: 12 * 1024 * 1024, modules: ['dca_engine', 'fund_history_store'].map(name => ({ name, path: path.join(projectRoot, `modules/factors/src/${name}.py`) })),
  });
  const run = JSON.parse(result.stdout);
  if (run.error) throw Object.assign(new Error(run.error), { status: /source_version_changed|source_changed_retry|frozen_snapshot_integrity_failed/.test(run.error) ? 409 : 422 });
  return { run, sourceHashes: result.sourceHashes };
}
const seedSkills = [
  ['idea','/idea','信号','发现与筛选','AI存储',true,'根据舆情、消息、技术异动、公报财报研报入手，产出信号层。'],
  ['screen','/screen','筛选','发现与筛选','ROE20+ PE5-30 半导体/存储',false,'跑筛选并产出候选标的清单。'],
  ['ingest','/ingest','摄入','知识摄入','PE口径不一致方法论笔记',false,'把外部材料或方法论笔记结构化进知识库。'],
  ['research','/research','研究','研究与验证','MU.US',true,'对单一标的做基本面、估值、技术位置、机构观点、催化剂和证伪深挖。'],
  ['compare','/compare','比较','研究与验证','MU.US SNDK.US WDC.US',false,'给定2-5个标的，产出对比矩阵。'],
  ['model','/model','模型','研究与验证','MU.US',false,'用 DCF 框架做内在价值测算和敏感性分析。'],
  ['redteam','/redteam','证伪','研究与验证','MU.US',false,'组织反方证据并评估叙事脆弱度。'],
  ['risk','/risk','风险','决策与风险','MU/SNDK/WDC/NVDA 候选组合',true,'做集中度、相关性和叙事失效复核，只做纸面推演。'],
  ['trade','/trade','记账','决策与风险','BUY NVDA.US 240 206.64',false,'只写本地纸面账本，不连接真实券商。'],
  ['today','/today','日报','跟踪与复盘','',true,'汇总当天产出并标注需要重新评估的失效条件。'],
  ['events','/events','事件','跟踪与复盘','MU/SNDK/WDC/NVDA 跟踪清单',false,'跟踪财报日期、量产公告等催化剂。'],
  ['weekly','/weekly','周报','跟踪与复盘','',false,'汇总一周日报，识别信号强化或减弱。'],
].map(([key, cmd, displayName, stage, defaultArg, live, desc], order) => ({ key, cmd, displayName, stage, defaultArg, live, desc, order }));
// Only explicitly public assets are served; repository files never become URL paths.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/fund-screen-state.js', ['fund-screen-state.js', 'text/javascript; charset=utf-8']],
  ['/industry-state.js', ['industry-state.js', 'text/javascript; charset=utf-8']],
  ['/factor-analysis.js', ['factor-analysis.js', 'text/javascript; charset=utf-8']],
  ['/module-loader.js', ['module-loader.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
let factorWriteBusy = false;
function requestErrorResponse(error, method) {
  const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
  return { status: missing ? 503 : 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    body: method === 'HEAD' ? undefined : JSON.stringify({ error: missing ? 'data_source_unavailable' : 'request_failed' }) };
}
export async function dispatchRequest(options = {}, request = {}) {
  let mutation = false;
  try { mutation = new URL(request.url || '/', 'http://localhost').pathname.startsWith('/api/modules/factors/v1/') && !['GET', 'HEAD'].includes(request.method || 'GET'); } catch { /* URL validation stays in the dispatcher. */ }
  if (!mutation) {
    try { return await dispatchUnlocked(options, request); }
    catch (error) { return requestErrorResponse(error, request.method); }
  }
  if (factorWriteBusy) return { status: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'factor_write_in_progress_do_not_retry_automatically' }) };
  factorWriteBusy = true;
  try { return await dispatchUnlocked(options, request); }
  catch (error) { return requestErrorResponse(error, request.method); }
  finally { factorWriteBusy = false; }
}

async function dispatchUnlocked({ modules, standalone, snapshotStore = defaultSnapshotStore, legacyExportReader = readOldFactorJson } = {}, { method = 'GET', url: rawUrl = '/', body } = {}) {
  const publicAssets = moduleAssets(modules);
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
  const reply = (status, body, extraHeaders = {}) => ({ status, headers: { ...headers, ...extraHeaders }, body: method === 'HEAD' ? undefined : body });
  const json = (status, value, extraHeaders = {}) => reply(status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  let url;
  try { url = new URL(rawUrl, 'http://localhost'); }
  catch { return json(400, { error: 'invalid_url' }); }
  const factorLibraryWrite = url.pathname === '/api/modules/factors/v1/library/submissions' || url.pathname.startsWith('/api/modules/factors/v1/library/submissions/');
  const factorConfigWrite = url.pathname === '/api/modules/factors/v1/experiment-configs' || url.pathname.startsWith('/api/modules/factors/v1/experiment-configs/');
  const factorRunRequestWrite = url.pathname === '/api/modules/factors/v1/run-requests';
  const factorRunExecuteWrite = /^\/api\/modules\/factors\/v1\/run-requests\/[^/]+\/execute$/.test(url.pathname);
  const factorSnapshotWrite = url.pathname === '/api/modules/factors/v1/snapshots/frozen' || /^\/api\/modules\/factors\/v1\/snapshots\/frozen\/[^/]+\/verify$/.test(url.pathname);
  const expressionWrite = ['/api/modules/factors/v1/custom-expression/validate','/api/modules/factors/v1/custom-expression/preview','/api/modules/factors/v1/legacy-dca/preview'].includes(url.pathname);
  const workflowWrite = url.pathname === '/api/modules/factors/v1/backtest-tools/run';
  if (method !== 'GET' && method !== 'HEAD' && !((factorLibraryWrite || factorConfigWrite) && ['POST', 'PUT'].includes(method)) && !(factorRunRequestWrite && method === 'POST') && !(factorRunExecuteWrite && method === 'POST') && !(factorSnapshotWrite && method === 'POST') && !(expressionWrite && method === 'POST') && !(workflowWrite && method === 'POST')) {
    return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  }
  if (standalone && url.pathname === '/') return reply(302, '', { Location: `/modules/${standalone}/` });
  if (/^\/modules\/(observatory|daily)$/.test(url.pathname)) return reply(308, '', { Location: url.pathname + '/' + url.search });
    const publicAsset = publicAssets.get(url.pathname);
    if (publicAsset) {
      try {
        const body = readPublicAsset(publicAsset);
        return reply(200, body, { 'Content-Type': publicAsset.type, 'Content-Security-Policy': modulePolicy(body, publicAsset.type) });
      } catch { return json(404, { error: 'asset_unavailable' }); }
    }
    if (standalone) return json(404, { error: 'not_found' });
    if (url.pathname === '/api/health') return json(200, { status: 'ok', version: '0.5.6', mode: 'local', dataConnected: false });
    if (url.pathname === '/api/workspaces') return json(200, { items: workspaces });
    if (url.pathname === '/api/contracts/v1/core') return json(200, coreContract);
    if (url.pathname === '/api/contracts/v1/factors') return json(200, factorExperimentContract);
    if (url.pathname === '/api/registry/v1/sources') return registrySources(json);
    if (url.pathname === '/api/registry/v1/artifacts') return registryArtifacts(url, json);
    if (url.pathname === '/api/registry/v1/entities') return registryEntities(url, json);
    if (url.pathname === '/api/registry/v1/tasks') return registryTasks(json);
    if (url.pathname === '/api/registry/v1/snapshot') return registrySnapshot(reply, json);
    if (url.pathname === '/api/modules/daily/v1/reports') return dailyReports(url, json);
    if (url.pathname.startsWith('/api/modules/daily/v1/reports/')) return dailyReport(url, json);
    if (url.pathname === '/api/modules/observatory/v1/config') return observatoryConfig(json);
    if (url.pathname === '/api/modules/observatory/v1/sources') return observatorySources(json);
    if (url.pathname === '/api/modules/factors/v1/assets') return factorAssets(json);
    if (url.pathname === '/api/modules/factors/v1/snapshots') return factorSnapshots(json);
    if (url.pathname === '/api/modules/factors/v1/snapshots/frozen' || url.pathname.startsWith('/api/modules/factors/v1/snapshots/frozen/')) return factorFrozenSnapshots(url, { method, body, json, snapshotStore });
    if (url.pathname === '/api/modules/factors/v1/definitions') return factorDefinitions(json);
    if (url.pathname === '/api/modules/factors/v1/visual-lab') return factorVisualLab(json, legacyExportReader);
    if (url.pathname === '/api/modules/factors/v1/experiment-comparison') return factorExperimentComparison(json, legacyExportReader);
    if (url.pathname === '/api/modules/factors/v1/product-state') return factorProductState(json, legacyExportReader);
    if (url.pathname === '/api/modules/factors/v1/library') return factorLibrary(json);
    if (['options','frozen-options','preview'].some(mode => url.pathname === `/api/modules/factors/v1/legacy-dca/${mode}`)) return legacyDcaApi(url, {method,body,json,snapshotStore});
    if (['options','validate','preview'].some(mode => url.pathname === `/api/modules/factors/v1/custom-expression/${mode}`)) return customExpressionApi(url, {method,body,json,snapshotStore});
    if (url.pathname === '/api/modules/factors/v1/library/submissions') return factorLibrarySubmissions({ method, body, json });
    if (url.pathname.startsWith('/api/modules/factors/v1/library/submissions/')) return factorLibrarySubmission(url, { method, body, json });
    if (url.pathname === '/api/modules/factors/v1/lab-framework') return factorLabFramework(json);
    if (url.pathname === '/api/modules/factors/v1/experiment-configs') return factorExperimentConfigs({ method, body, json });
    if (url.pathname.startsWith('/api/modules/factors/v1/experiment-configs/')) return factorExperimentConfig(url, { method, body, json });
    if (url.pathname === '/api/modules/factors/v1/execution-plan') return factorExecutionPlan(json);
    if (url.pathname === '/api/modules/factors/v1/backtest-tools' || url.pathname.startsWith('/api/modules/factors/v1/backtest-tools/')) return factorBacktestTools(url, { method, body, json, snapshotStore });
    if (url.pathname === '/api/modules/factors/v1/industry-engine/options') {
      const { stdout } = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/industry_engine.py'), ['--definitions'], { timeout: 10000 });
      return json(200, JSON.parse(stdout));
    }
    if (url.pathname === '/api/modules/factors/v1/three-bucket-engine/options') {
      const { stdout } = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/three_bucket_engine.py'), ['--definitions'], threeBucketPythonOptions());
      return json(200, JSON.parse(stdout));
    }
    if (url.pathname === '/api/modules/factors/v1/backtest-engine') return factorBacktestEngine(json);
    if (url.pathname === '/api/modules/factors/v1/run-requests') return factorRunRequests({ method, body, json });
    if (url.pathname.startsWith('/api/modules/factors/v1/run-requests/') && url.pathname.endsWith('/execute')) return factorRunRequestExecute(url, { method, json, snapshotStore });
    if (url.pathname === '/api/modules/factors/v1/result-artifacts') return factorResultArtifacts(json);
    if (url.pathname.startsWith('/api/modules/factors/v1/result-artifacts/')) return factorResultArtifact(url, json);
    if (url.pathname === '/api/modules/factors/v1/data-layer') return factorDataLayer(json);
    if (url.pathname === '/api/modules/factors/v1/data-layer/schema') return factorDataLayerSchema(json);
    if (url.pathname === '/api/modules/factors/v1/data-layer/preview') return factorDataPreview(url, json);
    if (url.pathname === '/api/modules/factors/v1/fund-screen/options') return factorFundScreenOptions(url, json, snapshotStore);
    if (url.pathname === '/api/modules/factors/v1/fund-screen/profile') return factorFundScreenProfile(url, json, snapshotStore);
    if (['/api/modules/factors/v1/fund-nav/catalog', '/api/modules/factors/v1/fund-nav/profile'].includes(url.pathname)) {
      try {
        const catalog = url.pathname.endsWith('/catalog');
        const snapshotId = url.searchParams.get('snapshotId') || fundNavEngine.inputSnapshotIds[0];
        const input = await factorInput(snapshotId, 'factors.fund_warehouse.nav_db', fundNavEngine.inputSnapshotIds[0], snapshotStore);
        const { run } = await fundNavPython(catalog ? 'catalog' : 'profile', catalog ? { query: url.searchParams.get('q') || '' } : { codes: (url.searchParams.get('codes') || '').split(','), benchmarkId: url.searchParams.get('benchmarkId') }, input);
        return json(200, { ...run, snapshotId, frozenSnapshot: input.snapshot });
      } catch (error) { return json(error.status || 500, { error: error.status ? error.message : 'fund_history_query_failed' }); }
    }
    if (url.pathname === '/api/modules/factors/v1/data-quality') return factorDataQuality(json);
    if (url.pathname === '/api/modules/factors/v1/legacy-archives') return json(200, await listLegacyArchives(factorLegacyArchiveRoot));
    if (url.pathname.startsWith('/api/modules/factors/v1/legacy-archives/')) {
      try {
        const id = url.pathname.slice('/api/modules/factors/v1/legacy-archives/'.length);
        const manifest = await readLegacyArchive(factorLegacyArchiveRoot, id);
        return json(200, { ...queryLegacyRecords(manifest, { q: url.searchParams.get('q') || '', category: url.searchParams.get('category') || '',
          sourcePath: url.searchParams.get('sourcePath') || '', offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 50) }),
          assets: manifest.assets, limitations: manifest.limitations, verification: 'manifest_identity_only_not_file_integrity' });
      } catch (error) { return json(error.code === 'ENOENT' ? 404 : 422, { error: error.code === 'ENOENT' ? 'legacy_archive_not_found' : error.message }); }
    }
    if (url.pathname === '/api/modules/factors/v1/legacy-experiments') return factorLegacyExperiments(json);
    if (url.pathname === '/api/modules/factors/v1/artifact-candidates') return factorArtifacts(json);
    if (url.pathname === '/api/modules/research/v1/skills') return researchSkills(json);
    if (url.pathname === '/api/modules/research/v1/workflows') return researchSkills(json);
    if (url.pathname === '/api/modules/research/v1/artifacts') return researchArtifacts(url, json);
    if (url.pathname.startsWith('/api/modules/research/v1/artifacts/')) return researchArtifact(url, method, reply, json);
    const asset = assets.get(url.pathname);
    if (!asset) return json(404, { error: 'not_found' });
    try {
      const body = await readFile(path.join(root, asset[0]));
      return reply(200, body, { 'Content-Type': asset[1] });
    } catch {
      return json(500, { error: 'asset_unavailable' });
    }
}

export function createServer({ modules, standalone, snapshotStore, legacyExportReader } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const response = await dispatchRequest({ modules, standalone, snapshotStore, legacyExportReader }, { method: req.method, url: req.url, body });
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    res.writeHead(response.status);
    res.end(response.body);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const response = requestErrorResponse(error, req.method);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    }
  });
  server.dispatch = request => dispatchRequest({ modules, standalone, snapshotStore, legacyExportReader }, request);
  return server;
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(projectRoot, relative), 'utf8'));
}

async function dailyReports(url, json) {
  const catalog = await readJson('modules/daily/data/catalog.json');
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const date = url.searchParams.get('date');
  const mode = url.searchParams.get('mode');
  let reports = catalog.reports.map(normalizeDaily);
  if (date) reports = reports.filter(report => report.date === date);
  if (mode && mode !== 'ALL') reports = reports.filter(report => report.mode === mode);
  if (q) reports = reports.filter(report => JSON.stringify(report.report).toLowerCase().includes(q));
  return json(200, { schemaVersion: 1, module: 'daily', apiVersion: 'v1', indexedAt: catalog.indexedAt, count: reports.length, items: reports.map(summaryDaily) });
}

async function dailyReport(url, json) {
  const key = decodeURIComponent(url.pathname.split('/').pop());
  const catalog = await readJson('modules/daily/data/catalog.json');
  const report = catalog.reports.map(normalizeDaily).find(item => item.archiveKey === key);
  if (!report) return json(404, { error: 'report_not_found' });
  return json(200, { schemaVersion: 1, module: 'daily', apiVersion: 'v1', item: report });
}

function normalizeDaily(report) {
  const publicationKind = report.report?.publication?.kind || (report.early ? 'early' : 'scheduled');
  return {
    ...report,
    date: report.report.report_date,
    title: report.report.title,
    cutoffAt: report.report.cutoff_at,
    qualityStatus: report.report.qa?.status || 'UNKNOWN',
    publicationKind,
    htmlUrl: report.htmlPath ? `/modules/daily/${report.htmlPath.replace(/^daily\//, '')}` : null,
    jsonUrl: report.jsonPath ? `/modules/daily/${report.jsonPath.replace(/^daily\//, '')}` : null,
  };
}

function summaryDaily(report) {
  const { report: raw, sourcePath, ...rest } = report;
  return { ...rest, summary: raw.summary, edition: raw.edition, missing: raw.qa?.missing || [] };
}

async function observatoryConfig(json) {
  const config = await readJson('modules/observatory/public/research-config.json');
  return json(200, { schemaVersion: 1, module: 'observatory', apiVersion: 'v1', config });
}

async function observatorySources(json) {
  const config = await readJson('modules/observatory/public/research-config.json');
  return json(200, { schemaVersion: 1, module: 'observatory', apiVersion: 'v1', items: config.sources, counts: { metrics: config.metrics.length, companies: config.companies.length, indices: config.indices.length, styles: config.styles.length, chains: config.chains.length, narratives: config.narratives?.length || 0 } });
}

async function registrySources(json) {
  const config = await readJson('modules/observatory/public/research-config.json');
  const items = Object.entries(config.sources).map(([key, value]) => {
    const [title, urlOrPath, notes] = value;
    return {
      sourceId: `observatory.source.${key}`,
      title,
      tier: urlOrPath ? 'S0_official' : 'S1_provider',
      retrievedAt: null,
      asOfDate: null,
      urlOrPath,
      hash: 'not_captured',
      moduleOwner: 'observatory',
      notes,
    };
  });
  return json(200, { schemaVersion: 1, apiVersion: 'v1', registry: 'sources', count: items.length, items });
}

async function registryArtifacts(url, json) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
  const items = [{
    artifactId: 'observatory.research_config',
    module: 'observatory',
    title: '观察台研究配置',
    version: 'v1',
    createdAt: null,
    sourceIds: ['observatory.source.calc', 'observatory.source.quote'],
    status: 'reviewed',
    storageRef: '/api/modules/observatory/v1/config',
    artifactType: 'config',
  }];
  for (const item of await listResearchArtifacts(limit)) {
    items.push({
      artifactId: `research.report.${item.file.replace(/\.md$/, '')}`,
      module: 'research',
      title: item.title,
      version: 'source-file',
      createdAt: item.updatedAt,
      sourceIds: [],
      status: 'reviewed',
      storageRef: `/api/modules/research/v1/artifacts/${encodeURIComponent(item.file)}`,
      artifactType: 'markdown_report',
      bytes: item.bytes,
    });
  }
  for (const item of await listFactorAssets()) {
    items.push({
      artifactId: item.assetId,
      module: 'factors',
      title: item.title,
      version: 'external-data-asset',
      createdAt: item.updatedAt,
      sourceIds: [],
      status: item.exists ? 'reviewed' : 'draft',
      storageRef: item.storageRef,
      artifactType: item.assetType,
      bytes: item.bytes,
      refreshMode: item.refreshMode,
      hashPolicy: item.hashPolicy,
    });
  }
  for (const item of await listFactorArtifacts()) {
    items.push({
      artifactId: item.artifactCandidateId,
      module: 'factors',
      title: item.title,
      version: 'candidate-from-old-project',
      createdAt: item.updatedAt,
      sourceIds: [],
      status: item.exists ? 'draft' : 'needs_review',
      storageRef: item.sourceScript,
      artifactType: item.artifactType,
      migrationPhase: item.migrationPhase,
      computePolicy: item.computePolicy,
      outputRefs: item.outputRefs,
    });
  }
  for (const item of (await readFactorResultArtifacts()).items) {
    items.push({
      artifactId: item.artifactId,
      module: 'factors',
      title: item.title,
      version: item.version,
      createdAt: item.createdAt,
      sourceIds: item.sourceIds || [],
      status: item.status,
      storageRef: item.storageRef,
      artifactType: 'result_artifact',
      experimentId: item.experimentId,
      metrics: item.metrics,
      warnings: item.warnings,
      computePolicy: item.computePolicy,
    });
  }
  return json(200, { schemaVersion: 1, apiVersion: 'v1', registry: 'artifacts', count: items.length, items: items.slice(0, limit) });
}

async function registryEntities(url, json) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
  const config = await readJson('modules/observatory/public/research-config.json');
  const items = [
    ...config.indices.map(item => ({ entityId: `index.${item.market}.${item.id}`, entityType: 'security', label: item.name, moduleOwner: 'observatory', symbol: item.id, market: item.market, assetType: 'index' })),
    ...config.companies.map(item => ({ entityId: `company.${item.market}.${item.id}`, entityType: 'company', label: item.name, moduleOwner: 'observatory', symbol: item.id, market: item.market, chain: item.chain, stage: item.stage })),
    ...config.metrics.map(item => ({ entityId: `metric.${item.id}`, entityType: 'macro_metric', label: item.name, moduleOwner: 'observatory', metricId: item.id, region: item.market, frequency: item.freq, sourceId: `observatory.source.${item.source}` })),
    ...(config.narratives || []).map(item => ({ entityId: `theme.${item.id}`, entityType: 'theme', label: item.title || item.name || item.id, moduleOwner: 'observatory', themeId: item.id, version: config.version || 'v1', thesisState: item.status || 'watching' })),
  ];
  return json(200, { schemaVersion: 1, apiVersion: 'v1', registry: 'entities', count: items.length, items: items.slice(0, limit) });
}

function registryTasks(json) {
  return json(200, {
    schemaVersion: 1,
    apiVersion: 'v1',
    registry: 'tasks',
    count: 0,
    items: [],
    note: '任务注册表只读壳已建立；长任务执行器、队列和恢复机制尚未接入。',
  });
}

async function factorAssets(json) {
  const items = await listFactorAssets();
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_data_asset_index',
    count: items.length,
    items,
    note: '仅登记历史宽表、面板和更新脚本；不复制大数据正文，不执行抓取。',
  });
}

async function listFactorAssets() {
  return Promise.all(factorDataAssets.map(async asset => {
    try {
      const info = await stat(asset.storageRef);
      return { ...asset, exists: true, bytes: info.size, updatedAt: info.mtime.toISOString() };
    } catch {
      return { ...asset, exists: false, bytes: null, updatedAt: null };
    }
  }));
}

async function factorSnapshots(json) {
  const items = await listFactorSnapshotRecords();
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_snapshot_candidates',
    count: items.length,
    items,
    note: 'snapshot候选由已登记数据资产派生；不读取宽表正文，不运行回测。',
  });
}

async function factorFrozenSnapshots(url, { method, body, json, snapshotStore }) {
  const base = '/api/modules/factors/v1/snapshots/frozen';
  try {
    if (url.pathname === base) {
      if (method === 'GET' || method === 'HEAD') {
        const items = await snapshotStore.list();
        return json(200, { module: 'factors', mode: 'local_frozen_snapshot_manifests', items, count: items.length,
          freezeOptions: factorSnapshotCandidates.filter(item => Object.hasOwn(freezeBindings, item.snapshotId)).map(item => ({ baseSnapshotId: item.snapshotId, title: item.title, assetIds: freezeBindings[item.snapshotId], selectionRequired: [fundNavEngine.inputSnapshotIds[0], legacyDcaEngine.inputSnapshotIds[0]].includes(item.snapshotId) })),
          note: '列表仅读取清单；内容校验由用户手动触发或在执行前进行。冻结时间不是数据截止日期。' });
      }
      const parsed = parseJsonBody(body);
      if (parsed.error) return json(400, parsed);
      if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value) || Object.keys(parsed.value).some(key => !['baseSnapshotId', 'title', 'selection'].includes(key))) return json(422, { error: 'invalid_snapshot_freeze_fields' });
      const result = await snapshotStore.freeze(clean(parsed.value.baseSnapshotId), clean(parsed.value.title), parsed.value.selection);
      return json(201, { module: 'factors', ...result });
    }
    const parts = url.pathname.slice(base.length + 1).split('/');
    if (parts.length === 1 && ['GET', 'HEAD'].includes(method)) return json(200, { item: await snapshotStore.read(parts[0]) });
    if (parts.length === 2 && parts[1] === 'verify' && method === 'POST') return json(200, { item: await snapshotStore.verify(parts[0]) });
    return json(405, { error: 'method_not_allowed' });
  } catch (error) { return json(error.status || 503, { error: error.status ? error.message : 'frozen_snapshot_unavailable' }); }
}

async function factorInput(snapshotId, assetId, baseSnapshotId, snapshotStore) {
  const asset = factorDataAssets.find(item => item.assetId === assetId);
  if (baseSnapshotId === legacyDcaEngine.inputSnapshotIds[0] && snapshotId === baseSnapshotId) throw Object.assign(new Error('frozen_snapshot_required'), {status:422});
  if (snapshotId === baseSnapshotId) return { storageRef: asset.storageRef, snapshot: null, expectedSha256: null };
  if (!frozenSnapshotIdValid(snapshotId)) throw Object.assign(new Error('unsupported_execution_snapshot'), { status: 422 });
  const resolved = await snapshotStore.resolve(snapshotId, assetId);
  if (resolved.item.baseSnapshotId !== baseSnapshotId) throw Object.assign(new Error('snapshot_comparison_group_mismatch'), { status: 422 });
  return { storageRef: resolved.storageRef, expectedSha256: resolved.file.sha256,
    snapshot: { snapshotId, baseSnapshotId, createdAt: resolved.item.createdAt, hashPolicy: resolved.item.hashPolicy, verification: 'sha256_verified',
      ...(resolved.item.selection ? { selection: resolved.item.selection, captureSources: resolved.item.captureSources } : {}),
      files: resolved.item.files.map(({ assetId, sha256, bytes }) => ({ assetId, sha256, bytes })) } };
}

async function listFactorSnapshotRecords() {
  const assets = await listFactorAssets();
  const byId = new Map(assets.map(asset => [asset.assetId, asset]));
  return factorSnapshotCandidates.map(candidate => {
    const linkedAssets = candidate.assetIds.map(id => byId.get(id)).filter(Boolean);
    const mtimes = linkedAssets.map(asset => asset.updatedAt).filter(Boolean).sort();
    return {
      ...candidate,
      exists: linkedAssets.length === candidate.assetIds.length && linkedAssets.every(asset => asset.exists),
      createdAt: mtimes.at(-1) || null,
      asOfDate: candidate.asOfDate,
      sourceUpdatedAt: mtimes.at(-1) || null,
      hash: linkedAssets.map(asset => `${asset.assetId}:${asset.bytes}:${asset.updatedAt}`).join('|') || candidate.hash,
      assets: linkedAssets.map(asset => ({ assetId: asset.assetId, bytes: asset.bytes, updatedAt: asset.updatedAt, exists: asset.exists })),
    };
  });
}

function factorDefinitions(json) {
  const slotCount = factorDefinitionCandidates.reduce((sum, item) => sum + item.slots.length, 0);
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_factor_definition_candidates',
    count: factorDefinitionCandidates.length,
    slotCount,
    items: factorDefinitionCandidates,
    timing: factorTimingDefinitions,
    note: '从旧factor_registry.py登记因子口径；不计算因子值，不运行回测。',
  });
}

async function factorVisualLab(json, readExport = readOldFactorJson) {
  const [app, report, study, loo, comps] = await Promise.all([
    readExport('out/app_data.json'),
    readExport('out/report.json'),
    readExport('out/factor_study.json'),
    readExport('out/factor_loo.json'),
    readExport('out/lab_comps.json'),
  ]);
  const base = report.base;
  const dates = app.dates;
  const seriesKeys = ['spec', 'opt', 'hs300', 'zz1000', 'sA', 'sB', 'sC'];
  const series = Object.fromEntries(seriesKeys.map(key => [key, sampleSeries(dates, app.series[key], 180)]));
  const accountSeries = ['strategy', 'bench_dca', 'contributed', 'nav_strategy', 'nav_bench', 'vA', 'vB', 'vC'];
  const account = Object.fromEntries(accountSeries.map(key => [key, sampleSeries(base.curve.date, base.curve[key], 180)]));
  const smartBeta = study.decomp.find(item => item.name.includes('Smart Beta'));
  const alpha = study.decomp.find(item => item.name.includes('Alpha'));
  const baseline = study.decomp[0];
  const attribution = [
    { key: 'smartBeta', label: 'Smart Beta 侧单独', value: smartBeta?.excess ?? 0, notes: '动量 + BM 价值单独回测' },
    { key: 'alpha', label: 'Alpha 侧单独', value: alpha?.excess ?? 0, notes: '景气度 + 拥挤度单独回测' },
    { key: 'total', label: '四因子合成总超额', value: baseline?.excess ?? 0, notes: '基线权重组合后的实际总超额' },
    { key: 'residual', label: '交互/残差项', value: (baseline?.excess ?? 0) - (smartBeta?.excess ?? 0) - (alpha?.excess ?? 0), notes: '总超额减去两侧单独贡献' },
  ];
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_native_visual_lab_from_old_exports',
    sourceProject: oldFactorRoot,
    sourceFiles: ['out/app_data.json', 'out/report.json', 'out/factor_study.json', 'out/factor_loo.json', 'out/lab_comps.json'],
    computePolicy: 'read_exported_results_only_no_backtest',
    period: base.period,
    config: app.config,
    seriesMeta: app.series_meta,
    series,
    account,
    kpis: {
      strategyIrr: base.irr_strategy,
      benchmarkIrr: base.irr_bench,
      irrExcess: base.irr_strategy - base.irr_bench,
      strategyFinal: base.final_strategy,
      benchmarkFinal: base.final_bench_dca,
      twrStrategy: base.twr_strategy,
      twrBenchmark: base.twr_bench,
      totalCost: base.total_cost,
      months: base.n_months,
    },
    sleeve: app.sleeve,
    sensitivity: app.sensitivity,
    factorStudy: {
      decomp: study.decomp,
      perturbStats: study.perturb_stats,
      verdict: study.verdict,
      loo: loo.cats,
      turnover: loo.turnover,
      attribution,
    },
    factorPositioning: loo.cats.map(item => ({
      key: item.key,
      label: item.cat,
      kind: item.kind,
      weight: item.weight,
      soloExcess: item.solo_excess,
      marginal: item.marginal,
      turnover: loo.turnover[item.key],
      ruleDegree: ({ value: 1, mom: 1, prosper: .55, crowd: .35 })[item.key] ?? null,
      ruleDegreePolicy: 'legacy_factor_registry_qualitative_annotation_not_measured',
    })),
    labComps: {
      variants: comps.b_variants,
      monthCount: comps.month_idx.length,
      keys: Object.keys(comps.comps),
    },
    notes: [
      '数据来自旧因子实验室已导出的结果文件；本接口不执行旧脚本、不重新回测。',
      '图表用于迁移旧页面交互和对比体验，结论仍需在新回测引擎迁入后复核。',
    ],
  });
}

async function factorExperimentComparison(json, readExport = readOldFactorJson) {
  const [app, comps] = await Promise.all([
    readExport('out/app_data.json'),
    readExport('out/lab_comps.json'),
  ]);
  const dates = app.dates;
  const items = Object.entries(comps.comps || {}).map(([key, values]) => {
    const group = key.startsWith('A_') ? 'A_benchmark_gate' : key.startsWith('B_') ? 'B_factor_weight' : 'C_combined';
    const label = comparisonLabel(key, comps.b_variants || []);
    return {
      comparisonId: `legacy.comparison.${key.toLowerCase()}`,
      key,
      label,
      group,
      activeMonthCount: Array.isArray(comps.b_active) ? comps.b_active.filter(Boolean).length : null,
      metrics: comparisonMetrics(dates, values),
      series: sampleSeries(dates, values, dates.length),
      weights: (comps.b_variants || []).find(item => `B_${item.key}` === key)?.weights || null,
    };
  });
  const baseline = items.find(item => item.key === 'B_base') || items.find(item => item.key === 'C') || items[0];
  const ranked = items
    .map(item => ({
      ...item,
      metrics: {
        ...item.metrics,
        finalExcessVsBaseline: baseline ? item.metrics.finalValue - baseline.metrics.finalValue : null,
        annualizedExcessVsBaseline: baseline ? item.metrics.annualizedReturn - baseline.metrics.annualizedReturn : null,
      },
    }))
    .sort((a, b) => b.metrics.finalValue - a.metrics.finalValue);
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_experiment_comparison_from_legacy_lab_comps',
    computePolicy: 'read_lab_comps_export_only_no_backtest_no_old_script',
    sourceFile: path.join(oldFactorRoot, 'out/lab_comps.json'),
    period: [dates[0], dates.at(-1)],
    count: ranked.length,
    variants: comps.b_variants || [],
    monthIndexCount: Array.isArray(comps.month_idx) ? comps.month_idx.length : 0,
    baselineKey: baseline?.key || null,
    items: ranked,
    notes: [
      '该接口读取旧实验导出的lab_comps.json，重算对比指标但不重新运行回测。',
      '不同序列有效起点可能不同，指标计算会跳过前置空值并暴露validStartDate。',
      'B组用于比较因子权重方案；A组用于比较基准和PE闸门；C组用于组合口径参照。',
    ],
  });
}

function comparisonLabel(key, variants) {
  const variant = variants.find(item => `B_${item.key}` === key);
  if (variant) return variant.label;
  const labels = {
    A_hs300_gate: 'A：沪深300 + PE闸门',
    A_hs300_nogate: 'A：沪深300 无闸门',
    A_zz1000_gate: 'A：中证1000 + PE闸门',
    A_zz1000_nogate: 'A：中证1000 无闸门',
    C: 'C：组合增强参照',
  };
  return labels[key] || key;
}

function comparisonMetrics(dates, values) {
  const rows = [];
  for (let i = 0; i < Math.min(dates.length, values.length); i += 1) {
    const value = Number(values[i]);
    if (Number.isFinite(value) && value > 0) rows.push({ date: dates[i], value });
  }
  if (!rows.length) return { validStartDate: null, validEndDate: null, pointCount: 0, finalValue: null, annualizedReturn: null, maxDrawdown: null, volatility: null };
  const first = rows[0];
  const last = rows.at(-1);
  const years = Math.max(1 / 252, rows.length / 252);
  const returns = [];
  let peak = first.value;
  let maxDrawdown = 0;
  for (let i = 1; i < rows.length; i += 1) {
    returns.push(rows[i].value / rows[i - 1].value - 1);
    peak = Math.max(peak, rows[i].value);
    maxDrawdown = Math.min(maxDrawdown, rows[i].value / peak - 1);
  }
  const avg = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, returns.length - 1);
  return {
    validStartDate: first.date,
    validEndDate: last.date,
    pointCount: rows.length,
    finalValue: last.value,
    annualizedReturn: (last.value / first.value) ** (1 / years) - 1,
    maxDrawdown,
    volatility: Math.sqrt(variance) * Math.sqrt(252),
  };
}

async function factorProductState(json, readExport = readOldFactorJson) {
  const [app, report, study, loo, configs] = await Promise.all([
    readExport('out/app_data.json'),
    readExport('out/report.json'),
    readExport('out/factor_study.json'),
    readExport('out/factor_loo.json'),
    readFactorExperimentConfigs(),
  ]);
  const base = report.base;
  const metricComparison = [
    { metric: 'IRR', strategy: base.irr_strategy, benchmark: base.irr_bench, unit: 'pct', interpretation: '定投现金流口径下的年化收益。' },
    { metric: 'TWR CAGR', strategy: base.twr_strategy.cagr, benchmark: base.twr_bench.cagr, unit: 'pct', interpretation: '剥离现金流影响后的组合复合收益。' },
    { metric: 'Volatility', strategy: base.twr_strategy.vol, benchmark: base.twr_bench.vol, unit: 'pct', interpretation: '单位净值口径年化波动。' },
    { metric: 'Max Drawdown', strategy: base.twr_strategy.mdd, benchmark: base.twr_bench.mdd, unit: 'pct', interpretation: '历史最大回撤，负数越大表示风险越高。' },
    { metric: 'Sharpe', strategy: base.twr_strategy.sharpe, benchmark: base.twr_bench.sharpe, unit: 'number', interpretation: '风险调整收益；当前样本下只作诊断。' },
    { metric: 'Final Value', strategy: base.final_strategy, benchmark: base.final_bench_dca, unit: 'number', interpretation: '定投账户终值，同现金流节奏比较。' },
  ].map(item => ({ ...item, excess: item.strategy - item.benchmark }));
  const factorPositioning = loo.cats.map(item => ({
    key: item.key,
    label: item.cat,
    kind: item.kind,
    currentWeight: item.weight,
    soloExcess: item.solo_excess,
    marginalContribution: item.marginal,
    turnover: loo.turnover[item.key],
    position: item.marginal >= 0 && item.solo_excess >= 0 ? 'preferred' : item.marginal >= 0 ? 'diversifier' : 'watch',
  }));
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'native_factor_lab_product_state',
    computePolicy: 'configuration_and_exported_results_only_no_backtest',
    workflow: [
      { step: 'factor_inventory', title: '因子库与字段口径', status: 'editable', output: 'factorFamilyId / fields / formula / missingValuePolicy' },
      { step: 'strategy_config', title: '策略配置工作台', status: 'editable', output: 'factorWeights / strategySettings / transactionSettings' },
      { step: 'custom_factor', title: '自建因子策略', status: 'executable_industry_expressions_and_definition_drafts', output: 'executionSpec / fieldBindings / dependencies / revisionSha / monthlyIndustryResults' },
      { step: 'result_review', title: '结果对比与定位', status: 'readonly_exported_results', output: 'metrics / account curves / factor positioning' },
      { step: 'attribution_risk', title: '归因、误差与敏感度', status: 'accounting_and_proxy_risk_diagnostic', output: 'terminalLinkedContributions / cashflowAmounts / proxyRisk / reconciliation / sensitivity' },
    ],
    strategyTools: factorStrategyTemplates.map(item => ({
      ...item,
      editableNow: ['strategy.factor_rotation_topn', 'strategy.monthly_dca_three_bucket', 'strategy.fund_cross_section_screen'].includes(item.strategyTemplateId),
      savedConfigCount: configs.items.filter(config => config.strategyTemplateId === item.strategyTemplateId).length,
    })),
    customFactorBuilder: {
      execution: { dialect: 'industry_expression_v1', strategyTemplateId: 'strategy.custom_industry_expression',
        optionsUrl: '/api/modules/factors/v1/custom-expression/options', supportedUniverse: 'sw_industry_and_etf_proxy',
        normalization: 'cross_section_zscore_clip_3', missingValuePolicy: 'complete_case',
        boundary: '以下defaultTemplate为定义草案；可执行行业表达式使用独立字段绑定/子因子表单，不自动执行旧自然语言公式。基金历史因子与完整归因未实现。' },
      fields: ['customFormula', 'inputFields', 'weightingRule', 'winsorization', 'neutralization', 'missingValuePolicy', 'riskTags', 'validationNotes'],
      defaultTemplate: {
        customFormula: 'score = 0.35*z(value) + 0.25*z(momentum) + 0.25*z(growth) - 0.15*z(crowding)',
        weightingRule: 'score_weighted_or_rank_bucket',
        winsorization: 'clip by cross_section p1/p99 before zscore',
        neutralization: 'industry_or_strategy_type_group_optional',
        missingValuePolicy: 'missing fields excluded from composite and flagged',
      },
      validationRules: ['must_bind_snapshot', 'must_define_direction', 'must_define_lag_policy', 'must_define_missing_value_policy', 'must_not_mix_universe_without_bridge'],
    },
    resultComparison: {
      period: base.period,
      metrics: metricComparison,
      accountViews: ['account_value', 'unit_nav', 'contributed_capital', 'drawdown', 'cash_flow_schedule'],
      comparePolicy: 'same_snapshot_benchmark_cost_rebalance_only',
    },
    factorPositioning,
    scoringAndBacktestLogic: {
      factorScoreFormula: 'compositeScore = weighted_z(value, momentum, growth, low_volatility, dividend, size) - crowdingPenalty',
      timingGate: 'valuationGate + macroContext + investabilityCheck; gate changes allocation strength, not the factor definition itself',
      rebalanceLogic: 'rank on rebalance date using only data visible before that date; build target weights; apply costs; record account and unit-nav views separately',
      dcaLogic: 'cash flow schedule first; bucket A/B/C allocation second; TWR and money-weighted IRR displayed separately',
      steps: ['loadSnapshot', 'validateUniverse', 'computeFactorScore', 'applyTimingGate', 'constructPortfolio', 'applyCosts', 'calculateMetrics', 'attributeExcess', 'runSensitivity'],
    },
    attributionModel: {
      nativeIndustry: { status: 'computed_industry_accounting_v1', resultField: 'attribution', version: 'industry-terminal-link-v1',
        components: ['cashExposure', 'industrySelection', 'managementFee', 'tradingCost'],
        unit: 'terminal_return_difference_initial_capital_1_not_annualized',
        limitations: ['expost_not_causal_timing', 'single_benchmark_ols_not_investment_alpha', 'smart_beta_not_identified', 'dca_and_three_bucket_not_covered'] },
      nativeCashflow: { status: 'computed_cashflow_accounting_v1', resultField: 'attribution', version: 'same-flow-wealth-difference-v1',
        strategies: ['broad_dca', 'fund_nav_fixed_dca', 'three_bucket_monthly'], unit: 'account_currency',
        limitations: ['wealth_difference_not_irr_or_twr', 'accounting_not_causal_timing', 'embedded_fund_fees_not_separable', 'multifactor_alpha_smart_beta_not_computed'] },
      buckets: study.decomp.map(item => ({ name: item.name, excess: item.excess, irr: item.irr })),
      residualPolicy: 'total_excess_minus_smart_beta_minus_alpha_must_remain_visible',
      timeVsNonTime: ['timing_gate_effect', 'cross_section_selection_effect', 'allocation_weight_effect', 'cost_and_rebalance_effect', 'unexplained_residual'],
    },
    errorModel: [
      { errorId: 'lookahead_risk', title: '前视偏差', logic: '估值、盈利和持仓字段必须按可见日期滞后。', mitigation: '保存lagPolicy并在回测器中强制校验。' },
      { errorId: 'survivorship_risk', title: '幸存者偏差', logic: '当前宽表或面板可能缺失退市/清盘样本。', mitigation: 'snapshot记录样本边界，结果卡显示样本覆盖率。' },
      { errorId: 'liquidity_error', title: '流动性误差', logic: '行业ETF代理和真实可交易ETF容量不同。', mitigation: '记录minInvestable、成交占比、换手和容量标记。' },
      { errorId: 'cost_error', title: '成本误差', logic: '佣金、滑点、管理费和申赎费变化会改变定投结果。', mitigation: '成本模型作为配置字段并进入敏感度。' },
      { errorId: 'rebalance_error', title: '调仓误差', logic: '月初、月末或节假日顺延会影响价格。', mitigation: 'rebalanceCalendar必须固定，并禁止跨日历比较。' },
      { errorId: 'parameter_sensitivity', title: '参数敏感度', logic: 'TopN、PE闸门、费用和权重可能造成历史最优幻觉。', mitigation: '展示扰动网格，不用单一最优参数直接上线。' },
    ],
    sensitivityControls: app.sensitivity.map(item => ({ case: item.case, irr: item.irr, excess: item.excess, final: item.final, mdd: item.mdd })),
    dataScopeNotes: [
      '基金宽表、行业面板、宽基面板分属不同comparison group，默认不可混排。',
      '旧导出结果仅用于恢复页面体验；新结果必须由后续回测执行器按配置重新生成。',
      '日报和早晚报项目保持暂停，不进入本模块默认检查。',
    ],
  });
}

async function readOldFactorJson(relative) {
  return JSON.parse(await readFile(path.join(oldFactorRoot, relative), 'utf8'));
}

function sampleSeries(dates, values, maxPoints = 180) {
  if (!Array.isArray(dates) || !Array.isArray(values)) return [];
  const n = Math.min(dates.length, values.length);
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const rows = [], valid = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
  const indices = []; for (let i = 0; i < n; i += step) indices.push(i);
  if (n && indices.at(-1) !== n-1) indices.push(n-1);
  let previous = -1;
  for (const i of indices) {
    // Keep a gap marker even when the display stride would skip missing rows.
    for (let j = previous+1; j < i; j++) if (!valid(values[j])) { rows.push({date:dates[j],value:null}); break; }
    rows.push({date:dates[i],value:valid(values[i]) ? Number(values[i]) : null}); previous=i;
  }
  return rows;
}

async function factorLibrary(json) {
  const submissions = await readFactorLibrarySubmissions();
  const items = [...commonFactorLibrary, ...submissions.items];
  const fieldCount = items.reduce((sum, item) => sum + item.fields.length, 0);
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'editable_common_factor_library',
    count: items.length,
    fieldCount,
    builtinCount: commonFactorLibrary.length,
    submittedCount: submissions.items.length,
    items,
    note: '常用因子库登记字段、计算逻辑、子因子/指标、使用逻辑、方向、频率、适用snapshot和缺失值策略；提交写入本地var/factors，不计算因子值。',
  });
}

async function factorLibrarySubmissions({ method, body, json }) {
  if (method === 'GET' || method === 'HEAD') {
    const submissions = await readFactorLibrarySubmissions();
    return json(200, {
      schemaVersion: 1,
      module: 'factors',
      apiVersion: 'v1',
      mode: 'local_factor_library_submissions',
      count: submissions.items.length,
      items: submissions.items,
    });
  }
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST' });
  const parsed = parseJsonBody(body);
  if (parsed.error) return json(400, parsed);
  const submissions = await readFactorLibrarySubmissions();
  const normalized = normalizeFactorLibrarySubmission(parsed.value, { existing: submissions.items });
  if (normalized.error) return json(422, normalized);
  try { await customSubmissionCheck(normalized.item); } catch (error) { return json(error.status || 500, {error:error.message}); }
  const now = new Date().toISOString();
  const item = { ...normalized.item, createdAt: now, updatedAt: now, revision: 1 };
  submissions.items.push(item);
  await writeFactorLibrarySubmissions(submissions);
  return json(201, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item });
}

async function factorLibrarySubmission(url, { method, body, json }) {
  const factorFamilyId = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!validId(factorFamilyId)) return json(400, { error: 'invalid_factor_family_id' });
  const submissions = await readFactorLibrarySubmissions();
  const index = submissions.items.findIndex(item => item.factorFamilyId === factorFamilyId);
  if (method === 'GET' || method === 'HEAD') {
    if (index < 0) return json(404, { error: 'factor_family_not_found' });
    return json(200, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item: submissions.items[index] });
  }
  if (method !== 'PUT') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, PUT' });
  if (index < 0) return json(404, { error: 'factor_family_not_found' });
  const parsed = parseJsonBody(body);
  if (parsed.error) return json(400, parsed);
  const normalized = normalizeFactorLibrarySubmission({ ...parsed.value, factorFamilyId }, { existing: submissions.items, currentId: factorFamilyId });
  if (normalized.error) return json(422, normalized);
  try { await customSubmissionCheck(normalized.item); } catch (error) { return json(error.status || 500, {error:error.message}); }
  const previous = submissions.items[index];
  const item = {
    ...normalized.item,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
    revision: (previous.revision || 1) + 1,
  };
  submissions.items[index] = item;
  await writeFactorLibrarySubmissions(submissions);
  return json(200, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item });
}

async function readFactorLibrarySubmissions() {
  try {
    const data = JSON.parse(await readFile(factorLibrarySubmissionFile, 'utf8'));
    return { schemaVersion: 1, module: 'factors', items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { schemaVersion: 1, module: 'factors', items: [] };
  }
}

async function writeFactorLibrarySubmissions(data) {
  await mkdir(path.dirname(factorLibrarySubmissionFile), { recursive: true });
  const payload = {
    schemaVersion: 1,
    module: 'factors',
    updatedAt: new Date().toISOString(),
    items: data.items,
  };
  await writeFile(factorLibrarySubmissionFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseJsonBody(body) {
  try {
    return { value: JSON.parse(String(body || '{}')) };
  } catch {
    return { error: 'invalid_json' };
  }
}

function validId(value) {
  return /^library\.[a-z0-9_.-]+$/.test(String(value || ''));
}

function normalizeFactorLibrarySubmission(input, { existing, currentId } = {}) {
  const errors = [];
  const title = clean(input.title);
  const category = clean(input.category);
  const universe = clean(input.universe);
  const frequency = clean(input.frequency);
  const factorFamilyId = clean(input.factorFamilyId || makeFactorId(title, category));
  const fields = Array.isArray(input.fields) ? input.fields.map(normalizeField).filter(Boolean) : [];
  if (!validId(factorFamilyId)) errors.push('factorFamilyId must look like library.custom.name');
  if (!title) errors.push('title is required');
  if (!category) errors.push('category is required');
  if (!universe) errors.push('universe is required');
  if (!frequency) errors.push('frequency is required');
  if (!clean(input.calculationLogic)) errors.push('calculationLogic is required');
  if (!clean(input.usageLogic)) errors.push('usageLogic is required');
  if (!fields.length) errors.push('at least one field/sub-factor is required');
  if (existing?.some(item => item.factorFamilyId === factorFamilyId && item.factorFamilyId !== currentId)) errors.push('factorFamilyId already exists');
  if (commonFactorLibrary.some(item => item.factorFamilyId === factorFamilyId)) errors.push('factorFamilyId conflicts with builtin library');
  for (const [i, field] of fields.entries()) {
    for (const key of ['field', 'name', 'role', 'formula', 'direction', 'missingValuePolicy']) {
      if (!clean(field[key])) errors.push(`fields[${i}].${key} is required`);
    }
  }
  if (errors.length) return { error: 'validation_failed', errors };
  return {
    item: {
      factorFamilyId,
      module: 'factors',
      title,
      universe,
      category,
      frequency,
      sourceAssetIds: normalizeList(input.sourceAssetIds),
      snapshotIds: normalizeList(input.snapshotIds),
      status: clean(input.status) || 'submitted',
      version: clean(input.version) || 'user-submission-v1',
      calculationLogic: clean(input.calculationLogic),
      usageLogic: clean(input.usageLogic),
      researchNotes: clean(input.researchNotes),
      comments: clean(input.comments),
      fields,
      ...(input.executionSpec ? {executionSpec:input.executionSpec} : {}),
    },
  };
}

function normalizeField(field) {
  if (!field || typeof field !== 'object') return null;
  return {
    field: clean(field.field),
    name: clean(field.name),
    role: clean(field.role),
    formula: clean(field.formula),
    direction: clean(field.direction),
    missingValuePolicy: clean(field.missingValuePolicy),
    definition: clean(field.definition),
    usageLogic: clean(field.usageLogic),
    comments: clean(field.comments),
    status: clean(field.status) || 'submitted',
  };
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '').split(/[\n,]/).map(clean).filter(Boolean);
}

function makeFactorId(title, category) {
  const base = `${category || 'custom'}.${title || 'factor'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `library.custom.${base || 'factor'}`;
}

async function factorArtifacts(json) {
  const items = await listFactorArtifacts();
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_artifact_candidates',
    count: items.length,
    items,
    note: '只登记旧因子项目的实验、导出和报告能力；不执行旧脚本，不生成回测结果。',
  });
}

async function factorDataLayer(json) {
  const [assets, snapshots, legacyExports] = await Promise.all([
    listFactorAssets(),
    listFactorSnapshotRecords(),
    listOldFactorExportFiles(),
  ]);
  const updateJobs = assets
    .filter(item => item.assetType === 'update_script' || item.refreshMode === 'monthly_incremental')
    .map(item => ({
      jobId: item.assetType === 'update_script' ? 'job.factor_data.monthly_update_script' : `job.${item.assetId.replace(/^factors\./, '').replace(/[^a-z0-9]+/g, '_')}`,
      module: 'factors',
      title: item.assetType === 'update_script' ? '基金宽表月度更新脚本' : `${item.title} 月度数据检查`,
      command: item.assetType === 'update_script' ? item.storageRef : 'manual_stat_check_only',
      frequency: item.refreshMode,
      workingDirectory: item.ownerProject,
      inputs: ['existing_raw_data', 'incremental_monthly_data'],
      outputs: [item.assetId],
      networkPolicy: item.assetType === 'update_script' ? 'manual_only_may_require_network' : 'no_network_stat_only',
      status: item.exists ? 'ready_manual' : 'documented',
      lastObservedAt: item.updatedAt,
      notes: item.notes,
    }));
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'factor_data_layer_control_plane',
    computePolicy: 'metadata_and_update_job_registry_no_fetch',
    assetCount: assets.length,
    snapshotCount: snapshots.length,
    updateJobCount: updateJobs.length,
    legacyExportCount: legacyExports.length,
    assets,
    snapshots,
    updateJobs,
    legacyExports,
    databaseMaintenance: {
      status: 'offline_manual_tools_available', databaseAssetId: 'factors.fund_warehouse.nav_db',
      importCommand: 'npm run import:fund-history -- --nav-codes <codes> --skip-benchmarks',
      backupCommand: 'npm run backup:fund-history -- create',
      verifyCommand: 'npm run backup:fund-history -- verify <pack>',
      restoreCommand: 'npm run backup:fund-history -- restore <pack> --output <new-file>',
      policy: 'explicit_offline_no_fetch_no_schedule_restore_to_new_only',
      notes: '整库备份包含已提交WAL；核验SHA/完整性/源版本。恢复不自动换库，不等同动态实验冻结或已建立外部备份。',
    },
    notes: [
      '历史宽表、SQLite、parquet面板和月度更新脚本已纳入因子实验室数据层管理。',
      '本接口只登记数据资产、快照候选和更新任务，不读取大宽表正文，不触发联网抓取。',
      '回测默认读取既有快照；数据更新任务和回测任务保持分离。',
    ],
  });
}

async function factorDataLayerSchema(json) {
  const assets = await listFactorAssets();
  const items = [];
  for (const asset of assets) items.push(await probeFactorAssetSchema(asset));
  const panel = await readOldFactorJson('out/panel.json');
  items.push({
    assetId: 'legacy.etf_smartbeta.out.panel_json',
    title: '旧实验导出 panel.json',
    storageRef: path.join(oldFactorRoot, 'out/panel.json'),
    assetType: 'json_export',
    status: 'readable',
    rowShape: 'months x industries x factor_fields',
    columns: ['months', 'inds', 'ind_names', 'fkeys', 'lib', 'z', 'inv', 'ret', 'bench', 'cfg'],
    fieldCount: panel.fkeys.length,
    sampleFields: panel.fkeys.slice(0, 14),
    notes: '当前panel.json执行器使用该结构重算月度TopN结果。',
  });
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'factor_data_schema_probe',
    computePolicy: 'bounded_schema_probe_no_full_wide_table_read_no_fetch',
    count: items.length,
    items,
    notes: [
      'CSV只读取文件开头用于表头识别，不扫描全量正文。',
      'SQLite只读读取表/视图结构和字段定义，不扫描业务正文。',
      'parquet只读读取metadata、字段和row group信息，不扫描列数据正文。',
      'schema探针用于确认字段映射，不代表数据质量审计已经完成。',
    ],
  });
}

async function factorDataPreview(url, json) {
  const asset = factorDataAssets.find(item => item.assetId === url.searchParams.get('assetId'));
  if (!asset) return json(404, { error: 'data_asset_not_found' });
  if (!/\.(csv|parquet)$/.test(asset.storageRef)) return json(422, { error: 'unsupported_preview_asset' });
  const query = {
    fields: url.searchParams.getAll('field'),
    limit: Number(url.searchParams.get('limit') ?? 20),
    offset: Number(url.searchParams.get('offset') ?? 0),
    q: (url.searchParams.get('q') || '').trim(),
    dateField: url.searchParams.get('dateField') || '',
    startDate: url.searchParams.get('startDate') || '',
    endDate: url.searchParams.get('endDate') || '',
  };
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50
    || !Number.isInteger(query.offset) || query.offset < 0 || query.offset > 1000000
    || query.fields.length > 12 || query.q.length > 100) return json(422, { error: 'invalid_preview_query' });
  for (const date of [query.startDate, query.endDate].filter(Boolean)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
      || new Date(date).toISOString().slice(0, 10) !== date) return json(422, { error: 'invalid_preview_date' });
  }
  if (query.startDate && query.endDate && query.startDate > query.endDate) return json(422, { error: 'invalid_preview_date_range' });
  try {
    const before = await stat(asset.storageRef);
    const expectedVersion = url.searchParams.get('sourceVersion');
    if (expectedVersion && expectedVersion !== `${before.size}:${before.mtimeMs}`) return json(409, { error: 'data_asset_changed_retry' });
    const { stdout } = await execFileAsync('python3', [path.join(projectRoot, 'modules/factors/src/data_preview.py'), asset.storageRef, JSON.stringify(query)], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    const sample = JSON.parse(stdout);
    if (sample.error) return json(422, sample);
    const after = await stat(asset.storageRef);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return json(409, { error: 'data_asset_changed_retry' });
    return json(200, {
      schemaVersion: 1, module: 'factors', apiVersion: 'v1', mode: 'bounded_factor_data_preview',
      computePolicy: 'explicit_bounded_read_no_fetch_no_update_no_backtest',
      assetId: asset.assetId, title: asset.title, query, ...sample,
      sourceVersion: { bytes: after.size, updatedAt: after.mtime.toISOString(), fingerprint: `${after.size}:${after.mtimeMs}`, hashPolicy: 'stat_only_not_content_hash' },
      snapshotIds: factorSnapshotCandidates.filter(item => item.assetIds.includes(asset.assetId)).map(item => item.snapshotId),
      notes: ['每次最多扫描当前位置之后5000行、返回50行；关键词只匹配所选字段。', '缺失值计数仅针对返回样本；当前文件版本由大小和修改时间标识，尚未冻结为内容哈希快照。'],
    });
  } catch (error) {
    return json(error.code === 'ENOENT' ? 404 : 503, { error: 'data_preview_unavailable' });
  }
}

async function fundScreenDefinitions(storageRef = factorDataAssets.find(item => item.assetId === 'factors.fund_warehouse.wide_today').storageRef) {
  const columns = new Set(parseCsvHeader(await readFirstCsvLine(storageRef)));
  const aliases = { '管理费率_pct': '管理费率', '托管费率_pct': '托管费率', '销售服务费率_pct': '销售服务费率', '综合费率_pct': '年综合费率', share_class_primary_flag: 'is_primary' };
  return commonFactorLibrary.filter(family => family.universe === 'public_funds').flatMap(family => family.fields.map(field => {
    const sourceField = columns.has(field.field) ? field.field : aliases[field.field] || field.field;
    const available = columns.has(sourceField);
    return { ...field, factorFamilyId: family.factorFamilyId, familyTitle: family.title, familyVersion: family.version,
      sourceField, available, rankable: available && ['higher_is_better', 'lower_is_better'].includes(field.direction),
      mappingPolicy: sourceField === field.field ? 'exact_field_name' : 'explicit_source_alias_no_unit_conversion' };
  }));
}

async function factorFundScreenOptions(url, json, snapshotStore) {
  try {
    const input = await factorInput(url.searchParams.get('snapshotId') || 'snapshot.fund_warehouse.wide_today.current', 'factors.fund_warehouse.wide_today', 'snapshot.fund_warehouse.wide_today.current', snapshotStore);
    const fields = await fundScreenDefinitions(input.storageRef);
    return json(200, { module: 'factors', apiVersion: 'v1', mode: 'fund_screen_field_bindings_header_only', fields,
      availableCount: fields.filter(item => item.available).length, rankableCount: fields.filter(item => item.rankable).length });
  } catch (error) {
    return json(error.status || 503, { error: error.status ? error.message : 'fund_screen_source_unavailable' });
  }
}

async function readFundScreen(mode, payload, storageRef = factorDataAssets.find(item => item.assetId === 'factors.fund_warehouse.wide_today').storageRef) {
  const { stdout } = await execFileAsync('python3', [path.join(projectRoot, 'modules/factors/src/fund_screen.py'), storageRef, mode, JSON.stringify(payload)], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (result.error) throw Object.assign(new Error(result.error), { status: 422 });
  return result;
}

async function factorFundScreenProfile(url, json, snapshotStore) {
  try {
    const snapshotId = url.searchParams.get('snapshotId') || 'snapshot.fund_warehouse.wide_today.current';
    const input = await factorInput(snapshotId, 'factors.fund_warehouse.wide_today', 'snapshot.fund_warehouse.wide_today.current', snapshotStore);
    const result = await readFundScreen('profile', { expectedSha256: input.expectedSha256 }, input.storageRef);
    return json(200, { module: 'factors', apiVersion: 'v1', mode: 'explicit_fund_comparison_group_profile', snapshotId, frozenSnapshot: input.snapshot, ...result });
  } catch (error) {
    return json(error.status || 503, { error: error.status ? error.message : 'fund_screen_source_unavailable' });
  }
}

async function factorDataQuality(json) {
  const [schemaResponse, coverage, repair, report, turnover] = await Promise.all([
    buildFactorSchemaProbe(),
    readOldFactorJson('out/coverage_dataset.json'),
    readOldFactorJson('out/coverage_repair.json'),
    readOldFactorJson('out/coverage_report.json'),
    readOldFactorJson('out/turnover.json'),
  ]);
  const coverageIssues = normalizeCoverageFailures(coverage.failures);
  const repairIssues = normalizeCoverageFailures(repair.failures);
  const reportIssues = normalizeCoverageFailures(report.failures);
  const turnoverItems = Object.entries(turnover || {}).map(([factorKey, annualizedTurnover]) => ({
    factorKey,
    annualizedTurnover,
    costSensitivity: annualizedTurnover >= 900 ? 'high' : annualizedTurnover >= 650 ? 'medium' : 'low',
    notes: annualizedTurnover >= 900 ? '换手较高，回测必须单独检查成本和调仓频率。' : '换手仍需随成本模型复核。',
  }));
  const schemaItems = schemaResponse.items || [];
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'factor_data_quality_audit',
    computePolicy: 'read_exported_quality_logs_and_schema_only_no_fetch_no_old_script',
    coverage: {
      raw: summarizeCoverageLog(coverage, coverageIssues),
      repair: summarizeCoverageLog(repair, repairIssues),
      report: summarizeCoverageLog(report, reportIssues),
      issues: coverageIssues.slice(0, 24),
    },
    schemaAudit: {
      assetCount: schemaItems.length,
      readableCount: schemaItems.filter(item => /readable/.test(item.status)).length,
      pendingReaderCount: schemaItems.filter(item => /requires_/.test(item.status)).length,
      totalFieldCount: schemaItems.reduce((sum, item) => sum + Number(item.fieldCount || 0), 0),
      items: schemaItems.map(item => ({
        assetId: item.assetId,
        title: item.title,
        status: item.status,
        fieldCount: item.fieldCount,
        rowShape: item.rowShape,
      })),
    },
    turnoverAudit: {
      count: turnoverItems.length,
      highSensitivityCount: turnoverItems.filter(item => item.costSensitivity === 'high').length,
      items: turnoverItems,
    },
    preBacktestChecks: [
      { checkId: 'coverage_repair_zero_failure', title: '覆盖率修复结果', status: repairIssues.length === 0 ? 'ready' : 'review_required', notes: repair.summary || '' },
      { checkId: 'raw_fetch_failures_not_reused', title: '原始采集失败隔离', status: coverageIssues.length ? 'review_required' : 'ready', notes: `${coverageIssues.length} 个原始失败来源需要保留为审计记录。` },
      { checkId: 'schema_fields_bound', title: '字段映射确认', status: schemaItems.some(item => item.status === 'sqlite_schema_readable') && schemaItems.some(item => item.status === 'parquet_schema_readable') ? 'ready' : 'pending', notes: 'SQLite宽表和parquet面板字段已可查；后续仍需做字段滞后和可见日期审计。' },
      { checkId: 'turnover_cost_sensitivity', title: '换手成本敏感度', status: turnoverItems.some(item => item.costSensitivity === 'high') ? 'review_required' : 'ready', notes: `${turnoverItems.filter(item => item.costSensitivity === 'high').length} 个高换手因子。` },
      { checkId: 'no_network_execution', title: '执行边界', status: 'ready', notes: '本审计只读旧导出日志和schema，不联网、不运行旧脚本。' },
    ],
    notes: [
      '数据质量审计用于回测前复核，不代表已完成全量数据质量校验。',
      'coverage_dataset记录原始采集失败，coverage_repair记录修复后状态；两者都要保留，避免误把修复结果当成原始数据质量。',
      '换手审计用于成本和调仓敏感度，不直接给出交易建议。',
    ],
  });
}

async function buildFactorSchemaProbe() {
  const assets = await listFactorAssets();
  const items = [];
  for (const asset of assets) items.push(await probeFactorAssetSchema(asset));
  const panel = await readOldFactorJson('out/panel.json');
  items.push({
    assetId: 'legacy.etf_smartbeta.out.panel_json',
    title: '旧实验导出 panel.json',
    storageRef: path.join(oldFactorRoot, 'out/panel.json'),
    assetType: 'json_export',
    status: 'readable',
    rowShape: 'months x industries x factor_fields',
    columns: ['months', 'inds', 'ind_names', 'fkeys', 'lib', 'z', 'inv', 'ret', 'bench', 'cfg'],
    fieldCount: panel.fkeys.length,
    sampleFields: panel.fkeys.slice(0, 14),
    notes: '当前panel.json执行器使用该结构重算月度TopN结果。',
  });
  return { items };
}

function summarizeCoverageLog(log, issues) {
  return {
    summary: log.summary || '',
    cacheHits: Number(log.hits?.cache || 0),
    networkHits: Number(log.hits?.network || 0),
    failureCount: issues.length,
    status: issues.length ? 'review_required' : 'ready',
  };
}

function normalizeCoverageFailures(failures) {
  if (!failures || typeof failures !== 'object') return [];
  return Object.entries(failures).flatMap(([source, rows]) => {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => ({
      source,
      key: Array.isArray(row) ? String(row[0] ?? '') : '',
      message: Array.isArray(row) ? String(row[1] ?? '').slice(0, 220) : String(row).slice(0, 220),
    }));
  });
}

async function factorLegacyExperiments(json) {
  const [exports, report, app, study, loo, coverage, turnover] = await Promise.all([
    listOldFactorExportFiles(),
    readOldFactorJson('out/report.json'),
    readOldFactorJson('out/app_data.json'),
    readOldFactorJson('out/factor_study.json'),
    readOldFactorJson('out/factor_loo.json'),
    readOldFactorJson('out/coverage_dataset.json'),
    readOldFactorJson('out/turnover.json'),
  ]);
  const base = report.base || {};
  const exportByName = new Map(exports.map(item => [item.title, item]));
  const resultAssets = [
    legacyAsset(exportByName, 'report.json', '完整回测报告', 'backtest_report', 'mapped_to_visual_lab_and_fallback_result'),
    legacyAsset(exportByName, 'app_data.json', '页面曲线与敏感度数据', 'chart_dataset', 'mapped_to_visual_lab'),
    legacyAsset(exportByName, 'factor_study.json', 'Alpha/Smart Beta归因', 'attribution_dataset', 'mapped_to_attribution_view'),
    legacyAsset(exportByName, 'factor_loo.json', '因子留一与边际贡献', 'factor_diagnostic_dataset', 'mapped_to_factor_positioning'),
    legacyAsset(exportByName, 'lab_comps.json', '实验组合对比', 'comparison_dataset', 'indexed_for_strategy_comparison'),
    legacyAsset(exportByName, 'turnover.json', '换手率分解', 'risk_cost_dataset', 'indexed_for_cost_audit'),
    legacyAsset(exportByName, 'coverage_dataset.json', '覆盖率检查数据', 'data_quality_dataset', 'indexed_for_data_quality'),
    legacyAsset(exportByName, 'panel.json', '月度横截面面板', 'panel_dataset', 'used_by_panel_json_engine_v1'),
  ].filter(Boolean);
  const experiment = {
    legacyExperimentId: 'legacy.etf_smartbeta.industry_monthly_topn.v2026_08',
    title: '旧因子实验室：行业ETF Smart Beta 月度TopN实验',
    sourceProject: oldFactorRoot,
    snapshotId: 'snapshot.etf_smartbeta.industry_panel.current',
    status: 'migrating_to_native_workbench',
    migrationPhase: 'standard_asset_library_v1',
    parameterSet: {
      period: base.period,
      months: base.n_months,
      costMode: base.cost_mode,
      config: base.config || app.config || {},
      benchmark: 'exported_bench_dca_and_panel_bench',
      factorWeights: loo.base_weights || study.decomp?.[0]?.weights || {},
      rebalanceCalendar: 'monthly',
      transactionRule: 'monthly_dca_or_panel_topn_depending_result_view',
    },
    resultSummary: {
      strategyIrr: base.irr_strategy ?? null,
      benchmarkIrr: base.irr_bench ?? null,
      excessIrr: Number.isFinite(base.irr_strategy - base.irr_bench) ? base.irr_strategy - base.irr_bench : null,
      finalStrategyValue: base.final_strategy ?? null,
      finalBenchmarkValue: base.final_bench_dca ?? null,
      maxDrawdown: base.twr_strategy?.mdd ?? null,
      volatility: base.twr_strategy?.vol ?? null,
      sharpe: base.twr_strategy?.sharpe ?? null,
      totalCost: base.total_cost ?? null,
    },
    attribution: {
      buckets: (study.decomp || []).map(item => ({
        name: item.name,
        tag: item.tag,
        irr: item.irr,
        excess: item.excess,
        weights: item.weights,
      })),
      factorDiagnostics: (loo.cats || []).map(item => ({
        factorKey: item.key,
        title: item.cat,
        kind: item.kind === 'sb' ? 'smart_beta' : 'alpha',
        configuredWeight: item.weight,
        soloIrr: item.solo_irr,
        soloExcess: item.solo_excess,
        marginalContribution: item.marginal,
        turnover: turnover[item.key] ?? loo.turnover?.[item.key] ?? null,
      })),
      verdict: study.verdict || null,
    },
    chartAssets: [
      { chartId: 'legacy.chart.nav_curve', title: '策略/基准净值曲线', sourceFile: 'report.json', series: Object.keys(base.curve || {}) },
      { chartId: 'legacy.chart.app_series', title: '旧页面主图序列', sourceFile: 'app_data.json', series: Object.keys(app.series || {}) },
      { chartId: 'legacy.chart.sensitivity', title: '敏感度案例', sourceFile: 'app_data.json', caseCount: Array.isArray(app.sensitivity) ? app.sensitivity.length : 0 },
      { chartId: 'legacy.chart.factor_attribution', title: 'Alpha/Smart Beta/残差拆解', sourceFile: 'factor_study.json', bucketCount: study.decomp?.length || 0 },
    ],
    dataQuality: {
      coverageSummary: coverage.summary || {},
      failureCount: Array.isArray(coverage.failures) ? coverage.failures.length : 0,
      hitCount: Array.isArray(coverage.hits) ? coverage.hits.length : 0,
      migrationWarnings: [
        'legacy_results_are_imported_as_readonly_assets',
        'new_result_artifacts_should_be_generated_from_run_requests',
        'panel_json_engine_v1_recomputes_monthly_topn_but_not_full_wide_table_backtest',
      ],
    },
    resultAssets,
    standardizationMap: [
      { from: 'report.base.config', to: 'experimentRecord.strategySettings', status: 'mapped' },
      { from: 'factor_study.decomp', to: 'resultArtifactRecord.attribution.buckets', status: 'mapped' },
      { from: 'factor_loo.cats', to: 'resultArtifactRecord.attribution.factorDiagnostics', status: 'mapped' },
      { from: 'app_data.sensitivity', to: 'resultArtifactRecord.sensitivity', status: 'mapped' },
      { from: 'coverage_dataset', to: 'dataQualityRecord.coverage', status: 'mapped' },
      { from: 'lab_comps', to: 'comparisonAssetRecord', status: 'mapped' },
    ],
  };
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'readonly_legacy_experiment_asset_library',
    computePolicy: 'read_legacy_export_summaries_only_no_old_script_no_fetch',
    count: 1,
    assetCount: resultAssets.length,
    experiments: [experiment],
    notes: [
      '旧实验记录、参数和结果先标准化为只读资产包，作为迁移和校准依据。',
      '这些资产不是新的回测结果；新的结果仍由run-requests和result-artifacts生成。',
      '后续可把lab_comps、coverage和turnover继续拆成更细的对比、数据质量和成本审计页面。',
    ],
  });
}

function legacyAsset(exportByName, fileName, title, artifactType, migrationStatus) {
  const item = exportByName.get(fileName);
  if (!item) return null;
  return {
    assetId: item.exportId,
    title,
    fileName,
    artifactType,
    storageRef: item.storageRef,
    bytes: item.bytes,
    updatedAt: item.updatedAt,
    migrationStatus,
  };
}

async function probeFactorAssetSchema(asset) {
  const base = {
    assetId: asset.assetId,
    title: asset.title,
    storageRef: asset.storageRef,
    assetType: asset.assetType,
    status: asset.exists ? 'found' : 'missing',
    rowShape: null,
    columns: [],
    fieldCount: 0,
    sampleFields: [],
    notes: asset.notes,
  };
  if (!asset.exists) return base;
  if (asset.storageRef.endsWith('.csv')) {
    const columns = parseCsvHeader(await readFirstCsvLine(asset.storageRef));
    return {
      ...base,
      status: columns.length ? 'header_readable' : 'header_unavailable',
      rowShape: 'csv_header_only',
      columns,
      fieldCount: columns.length,
      sampleFields: columns.slice(0, 18),
      notes: `${asset.notes} 表头探针只读取文件开头，不扫描正文。`,
    };
  }
  if (asset.storageRef.endsWith('.parquet')) {
    return readParquetSchema(asset, base);
  }
  if (asset.storageRef.endsWith('.db')) {
    return readSqliteSchema(asset, base);
  }
  return base;
}

async function readParquetSchema(asset, base) {
  const script = `
import json, sys
import pyarrow.parquet as pq
path = sys.argv[1]
pf = pq.ParquetFile(path)
schema = pf.schema_arrow
fields = [{"name": field.name, "type": str(field.type), "nullable": field.nullable} for field in schema]
metadata = pf.metadata
print(json.dumps({
    "num_rows": metadata.num_rows,
    "num_row_groups": metadata.num_row_groups,
    "columns": fields,
    "created_by": metadata.created_by,
}, ensure_ascii=False))
`;
  try {
    const { stdout } = await execFileAsync('python3', ['-c', script, asset.storageRef], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const schema = JSON.parse(stdout);
    const fields = Array.isArray(schema.columns) ? schema.columns : [];
    return {
      ...base,
      status: 'parquet_schema_readable',
      rowShape: `parquet_metadata_only:${schema.num_rows || 0}_rows:${schema.num_row_groups || 0}_row_groups`,
      columns: fields.map(field => `${field.name}:${field.type}`),
      fieldCount: fields.length,
      sampleFields: fields.slice(0, 18).map(field => field.name),
      parquet: {
        rowCount: schema.num_rows,
        rowGroupCount: schema.num_row_groups,
        createdBy: schema.created_by,
        fields,
      },
      notes: `${asset.notes} Parquet探针只读metadata/footer，不扫描列数据正文。`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'parquet_schema_error',
      rowShape: 'parquet_schema_probe_failed',
      notes: `${asset.notes} Parquet只读schema探针失败：${error.message}`,
    };
  }
}

async function readSqliteSchema(asset, base) {
  const script = `
import json, sqlite3, sys
path = sys.argv[1]
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
rows = conn.execute("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").fetchall()
tables = []
for row in rows:
    name = row["name"]
    safe_name = name.replace('"', '""')
    columns = [
        {"name": col[1], "type": col[2], "notNull": bool(col[3]), "primaryKey": bool(col[5])}
        for col in conn.execute(f'pragma table_info("{safe_name}")').fetchall()
    ]
    tables.append({"name": name, "type": row["type"], "columns": columns})
print(json.dumps({"tables": tables}, ensure_ascii=False))
`;
  try {
    const { stdout } = await execFileAsync('python3', ['-c', script, asset.storageRef], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const schema = JSON.parse(stdout);
    const tables = Array.isArray(schema.tables) ? schema.tables : [];
    const sampleFields = tables.flatMap(table => table.columns.map(column => `${table.name}.${column.name}`)).slice(0, 18);
    return {
      ...base,
      status: 'sqlite_schema_readable',
      rowShape: `sqlite_schema_only:${tables.length}_tables_or_views`,
      columns: tables.map(table => `${table.name}(${table.columns.length})`),
      fieldCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
      sampleFields,
      tables,
      notes: `${asset.notes} SQLite探针只读表/视图结构和字段定义，不扫描业务正文。`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'sqlite_schema_error',
      rowShape: 'sqlite_schema_probe_failed',
      notes: `${asset.notes} SQLite只读schema探针失败：${error.message}`,
    };
  }
}

async function readFirstCsvLine(file) {
  const handle = await openFile(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] || '';
  } finally {
    await handle.close();
  }
}

function parseCsvHeader(header) {
  const columns = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      columns.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current || header.endsWith(',')) columns.push(current.trim());
  return columns.filter(Boolean);
}

async function factorLabFramework(json) {
  const submissions = await readFactorLibrarySubmissions();
  const configs = await readFactorExperimentConfigs();
  const library = [...commonFactorLibrary, ...submissions.items];
  const configuredFactorIds = new Set([
    ...experimentConfigTemplates().flatMap(item => item.factorFamilyIds || []),
    ...configs.items.flatMap(item => item.factorFamilyIds || []),
  ]);
  const strategyUses = new Map();
  for (const template of factorStrategyTemplates) {
    for (const id of template.factorFamilyIds || []) {
      strategyUses.set(id, [...(strategyUses.get(id) || []), template.strategyTemplateId]);
    }
  }
  const configUses = new Map();
  for (const config of configs.items) {
    for (const id of config.factorFamilyIds || []) {
      configUses.set(id, [...(configUses.get(id) || []), config.configId]);
    }
  }
  const factorInventory = library.map(item => ({
    factorFamilyId: item.factorFamilyId,
    title: item.title,
    category: item.category,
    universe: item.universe,
    status: item.status,
    version: item.version,
    fieldCount: item.fields.length,
    fields: item.fields.map(field => ({
      field: field.field,
      name: field.name,
      role: field.role,
      formula: field.formula,
      direction: field.direction,
      missingValuePolicy: field.missingValuePolicy,
      usageLogic: field.usageLogic || item.usageLogic || item.notes || '',
      status: field.status,
    })),
    configured: configuredFactorIds.has(item.factorFamilyId),
    strategyUses: strategyUses.get(item.factorFamilyId) || [],
    configUses: configUses.get(item.factorFamilyId) || [],
    snapshotIds: item.snapshotIds || [],
  }));
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'native_factor_lab_migration_framework',
    factorCount: factorInventory.length,
    subFactorCount: factorInventory.reduce((sum, item) => sum + item.fieldCount, 0),
    configuredFactorCount: factorInventory.filter(item => item.configured).length,
    capabilityCount: factorLabCapabilityMap.length,
    factorInventory,
    capabilities: factorLabCapabilityMap,
    strategyTemplates: factorStrategyTemplates,
    resultViews: factorResultViewSpecs,
    usageRecords: {
      experimentConfigDrafts: configs.items.map(item => ({
        configId: item.configId,
        title: item.title,
        factorFamilyIds: item.factorFamilyIds,
        strategyTemplateId: item.strategyTemplateId || null,
        snapshotId: item.snapshotId,
        benchmarkId: item.benchmarkId,
        revision: item.revision,
        updatedAt: item.updatedAt,
      })),
      artifactCandidates: factorArtifactCandidates.map(item => ({
        artifactCandidateId: item.artifactCandidateId,
        title: item.title,
        artifactType: item.artifactType,
        inputSnapshotIds: item.inputSnapshotIds,
        migrationPhase: item.migrationPhase,
        computePolicy: item.computePolicy,
      })),
    },
    notes: [
      '本接口登记因子实验室完整迁移框架；不执行旧脚本、不读取宽表正文、不运行回测。',
      '回测结果进入resultArtifactRecord前，必须绑定snapshot、benchmark、costModel、rebalanceCalendar和comparisonLimits。',
      '因子有效性、策略表现和账户收益展示分层处理，避免把配置、回测和交易建议混在一起。',
    ],
  });
}

async function factorExperimentConfigs({ method, body, json }) {
  if (method === 'GET' || method === 'HEAD') {
    const configs = await readFactorExperimentConfigs();
    return json(200, {
      schemaVersion: 1,
      module: 'factors',
      apiVersion: 'v1',
      mode: 'local_experiment_config_drafts',
      count: configs.items.length,
      templates: experimentConfigTemplates(),
      items: configs.items,
      note: '只保存实验配置草案；不排队、不抓取、不运行回测。',
    });
  }
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST' });
  const parsed = parseJsonBody(body);
  if (parsed.error) return json(400, parsed);
  const configs = await readFactorExperimentConfigs();
  const normalized = normalizeExperimentConfig(parsed.value, { existing: configs.items });
  if (normalized.error) return json(422, normalized);
  try { await customConfigCheck(normalized.item, configs); } catch (error) { return json(error.status || 500, {error:error.message}); }
  const now = new Date().toISOString();
  const item = { ...normalized.item, createdAt: now, updatedAt: now, revision: 1 };
  configs.items.push(item);
  await writeFactorExperimentConfigs(configs);
  return json(201, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item });
}

async function factorExperimentConfig(url, { method, body, json }) {
  const configId = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!validConfigId(configId)) return json(400, { error: 'invalid_config_id' });
  const configs = await readFactorExperimentConfigs();
  const index = configs.items.findIndex(item => item.configId === configId);
  if (method === 'GET' || method === 'HEAD') {
    if (index < 0) return json(404, { error: 'experiment_config_not_found' });
    return json(200, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item: configs.items[index] });
  }
  if (method !== 'PUT') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, PUT' });
  if (index < 0) return json(404, { error: 'experiment_config_not_found' });
  const parsed = parseJsonBody(body);
  if (parsed.error) return json(400, parsed);
  const previous = configs.items[index];
  if (previous.strategyTemplateId === 'strategy.legacy_510300_pe_dca' || parsed.value?.strategyTemplateId === 'strategy.legacy_510300_pe_dca') {
    if (parsed.value?.expectedRevision !== previous.revision) return json(409,{error:'experiment_config_revision_conflict',currentRevision:previous.revision});
    if (previous.strategyTemplateId === 'strategy.legacy_510300_pe_dca' && parsed.value?.strategyTemplateId !== previous.strategyTemplateId) return json(422,{error:'legacy_dca_config_type_change_not_supported'});
  }
  const normalized = normalizeExperimentConfig({ ...parsed.value, configId }, { existing: configs.items, currentId: configId });
  if (normalized.error) return json(422, normalized);
  try { await customConfigCheck(normalized.item, configs); } catch (error) { return json(error.status || 500, {error:error.message}); }
  const item = {
    ...normalized.item,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
    revision: (previous.revision || 1) + 1,
  };
  configs.items[index] = item;
  await writeFactorExperimentConfigs(configs);
  return json(200, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item });
}

async function factorExecutionPlan(json) {
  const [configs, requests] = await Promise.all([readFactorExperimentConfigs(), readFactorRunRequests()]);
  const executionStages = [
    { stageId: 'bind_config', title: '绑定实验配置', gate: 'configId_exists', status: 'ready' },
    { stageId: 'validate_snapshot', title: '校验数据快照', gate: 'snapshotId_and_universe_bound', status: 'ready_for_preflight' },
    { stageId: 'resolve_factors', title: '解析因子与权重', gate: 'factorFamilyIds_and_factorWeights_checked', status: 'ready_for_preflight' },
    { stageId: 'select_engine', title: '选择回测执行器', gate: 'artifactCandidateId_selected', status: 'manual_only' },
    { stageId: 'run_backtest', title: '生成新回测结果', gate: 'supported_config_and_manual_execution', status: 'local_execution_available' },
    { stageId: 'publish_result_artifact', title: '登记结果产物', gate: 'metrics_warnings_storageRef_required', status: 'local_result_store_available' },
  ];
  const configReadiness = configs.items.map(config => {
    const missing = [];
    if (!config.snapshotId) missing.push('snapshotId');
    if (!config.factorFamilyIds?.length && !['strategy.monthly_dca_three_bucket', 'strategy.fund_nav_fixed_dca', 'strategy.legacy_510300_pe_dca'].includes(config.strategyTemplateId)) missing.push('factorFamilyIds');
    if (!config.benchmarkId) missing.push('benchmarkId');
    if (!config.costModel) missing.push('costModel');
    if (!config.rebalanceCalendar) missing.push('rebalanceCalendar');
    const hasStructuredStrategy = Object.keys(config.strategySettings || {}).length > 0 || Object.keys(config.transactionSettings || {}).length > 0;
    if (!hasStructuredStrategy) missing.push('strategySettings_or_transactionSettings');
    if (config.strategyTemplateId === 'strategy.fund_cross_section_screen') {
      if (!config.strategySettings?.rankFields?.length) missing.push('rankFields');
      if (!config.strategySettings?.comparisonGroup?.strategyType || !config.strategySettings?.comparisonGroup?.frequency) missing.push('comparisonGroup');
      if (!config.strategySettings?.sourceSha256) missing.push('sourceSha256');
    }
    if (config.strategyTemplateId === 'strategy.industry_parquet_monthly_topn') {
      for (const key of ['startDate', 'endDate', 'topN', 'signalLagDays', 'minInvestable', 'weightingMethod', 'missingValuePolicy']) if (!config.strategySettings?.[key]) missing.push(key);
      if (!config.factorWeights?.length) missing.push('factorWeights');
    }
    if (config.strategyTemplateId === 'strategy.legacy_three_bucket_monthly') {
      for (const key of Object.keys(threeBucketSettings)) if (!Object.hasOwn(config.strategySettings || {}, key)) missing.push(key);
      if (!config.factorWeights?.length) missing.push('factorWeights');
    }
    if (config.strategyTemplateId === 'strategy.fund_nav_fixed_dca') {
      if (!config.strategySettings?.shares?.length) missing.push('shares');
      if (!config.strategySettings?.sourceVersions?.length) missing.push('sourceVersions');
    }
    if (config.strategyTemplateId === 'strategy.custom_industry_expression' && !config.strategySettings?.factorProgram?.executionSha256) missing.push('factorProgram');
    return {
      configId: config.configId,
      title: config.title,
      strategyTemplateId: config.strategyTemplateId || null,
      readyForPreflight: missing.length === 0,
      missing,
      runPolicy: config.runPolicy,
      lastRequestId: requests.items.findLast?.(item => item.configId === config.configId)?.requestId || null,
    };
  });
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'execution_preflight_plan_no_backtest',
    computePolicy: 'prepare_run_request_only_no_execution',
    executionStages,
    engineCandidates: [...factorArtifactCandidates.filter(item => item.artifactType === 'backtest_engine' || item.artifactType === 'factor_study' || item.artifactType === 'sensitivity_grid').map(item => ({
      artifactCandidateId: item.artifactCandidateId,
      title: item.title,
      artifactType: item.artifactType,
      status: item.status,
      computePolicy: item.computePolicy,
      inputSnapshotIds: item.inputSnapshotIds,
    })), fundScreenEngine, industryEngine, threeBucketEngine, fundNavEngine, customExpressionEngine, legacyDcaEngine],
    configReadiness,
    runRequests: requests.items,
    notes: [
      '该接口只做执行前检查和交接规划，不启动旧脚本、不跑回测。',
      '后续Skill或回测器必须读取同一个configId，并生成新的result artifact后才可进入结果复核。',
    ],
  });
}

async function readWorkflowStore(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(data.items)) throw new Error('invalid_store');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, module: 'factors', items: [] };
    throw Object.assign(new Error('workflow_store_unreadable'), { status: 503 });
  }
}

async function backtestPreflight(config, researchMode, snapshotStore) {
  const policy = workflowPolicy(config, researchMode), selected = backtestSpecs[config.strategyTemplateId];
  const result = { version: workflowVersion, configId: config.configId, configRevision: config.revision, snapshotId: config.snapshotId,
    ...policy, ready: false, preflightSha256: null, preflightScope: 'parameters_and_frozen_inputs_no_simulation_no_write' };
  if (policy.blockers.length) return result;
  try {
    const assetIds = freezeBindings[selected.baseSnapshotId], inputs = [];
    for (const assetId of assetIds) inputs.push(await factorInput(config.snapshotId, assetId, selected.baseSnapshotId, snapshotStore));
    const modules = [...selected.modules, selected.python].map(name => ({ name, path: path.join(projectRoot, `modules/factors/src/${name}.py`) }));
    const validated = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/backtest_preflight.py'), [JSON.stringify(config), JSON.stringify(inputs)], { modules, timeout: 30000, maxBuffer: 1024*1024 });
    const validation = JSON.parse(validated.stdout);
    if (validation.error) throw Object.assign(new Error(validation.error), { status: 422 });
    // The handoff fingerprints include protocol code, not just the interpreter's inputs.
    const orchestrationSources = [];
    for (const name of ['apps/api/server.js', 'modules/factors/src/backtest-tools.js', 'modules/factors/src/pinned-python.js', 'packages/contracts/factors.js']) orchestrationSources.push({ path: name, sha256: bytesHash(await readFile(path.join(projectRoot, name))) });
    const hashes = new Map(validated.sourceHashes.map(row => [row.moduleName, row.sha256]));
    const calculationSources = [{ moduleName: '__main__', sha256: hashes.get(selected.python) }, ...selected.modules.map(name => ({ moduleName: name, sha256: hashes.get(name) }))];
    const receipt = { version: workflowVersion, config, policy, frozenSnapshot: inputs[0].snapshot, validation,
      validatorSources: validated.sourceHashes, orchestrationSources, calculationSources };
    return { ...result, ready: true, validation, frozenSnapshot: inputs[0].snapshot, calculationSources,
      preflightSha256: fingerprint(receipt) };
  } catch (error) { return { ...result, blockers: [error.status ? error.message : 'backtest_preflight_unavailable'], errorStatus: error.status || 503 }; }
}

async function factorBacktestTools(url, { method, body, json, snapshotStore }) {
  const base = '/api/modules/factors/v1/backtest-tools', mode = url.pathname.slice(base.length);
  try {
    if (mode === '' && ['GET', 'HEAD'].includes(method)) return json(200, { version: workflowVersion, mode: 'native_backtest_tools',
      strategies: Object.entries(backtestSpecs).map(([strategyTemplateId, value]) => ({ strategyTemplateId, ...value })),
      skill: { name: 'factor-backtest', path: '.agents/skills/factor-backtest/SKILL.md', contentEndpoint: base + '/skill' },
      commands: ['catalog', 'preflight', 'run', 'audit'], policy: 'frozen_inputs_explicit_assumptions_manual_run_no_fetch_no_auto_retry' });
    if (mode === '/skill' && ['GET', 'HEAD'].includes(method)) return json(200, { name: 'factor-backtest', content: await readFile(path.join(projectRoot, '.agents/skills/factor-backtest/SKILL.md'), 'utf8') });
    if (mode === '/audit' && ['GET', 'HEAD'].includes(method)) {
      const id = url.searchParams.get('artifactId');
      if (!validResultArtifactId(id)) return json(400, { error: 'invalid_artifact_id' });
      const [results, requests] = await Promise.all([readWorkflowStore(factorResultArtifactFile), readWorkflowStore(factorRunRequestFile)]);
      const item = results.items.find(row => row.artifactId === id);
      if (!item) return json(404, { error: 'result_artifact_not_found' });
      return json(200, workflowResultAudit(item, requests.items.find(row => row.requestId === item.requestId)));
    }
    if (!['/preflight', '/run'].includes(mode)) return json(404, { error: 'backtest_tool_not_found' });
    if (mode === '/preflight' && !['GET', 'HEAD'].includes(method) || mode === '/run' && method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const parsed = mode === '/run' ? parseJsonBody(body) : { value: { configId: url.searchParams.get('configId'), researchMode: url.searchParams.get('researchMode') || 'assumption_simulation' } };
    if (parsed.error) return json(400, parsed);
    const input = parsed.value;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !validConfigId(input.configId)) return json(400, { error: 'invalid_config_id' });
    if (mode === '/run' && (Object.keys(input).some(key => !['configId', 'researchMode', 'preflightSha256', 'acknowledgements'].includes(key)) || !/^[a-f0-9]{64}$/.test(input.preflightSha256 || ''))) return json(422, { error: 'valid_preflight_receipt_required' });
    const configs = await readWorkflowStore(factorExperimentConfigFile), config = configs.items.find(row => row.configId === input.configId);
    if (!config) return json(404, { error: 'experiment_config_not_found' });
    const researchMode = input.researchMode || 'assumption_simulation';
    const required = workflowPolicy(config, researchMode).requiredAcknowledgements;
    if (mode === '/run' && !acknowledgementsValid(input.acknowledgements, required)) return json(422, { error: 'explicit_limitations_acknowledgement_required', requiredAcknowledgements: required });
    const preflight = await backtestPreflight(config, researchMode, snapshotStore);
    if (mode === '/preflight') return json(200, preflight);
    if (!preflight.ready) return json(preflight.errorStatus || 422, { error: 'backtest_preflight_blocked', preflight });
    if (preflight.preflightSha256 !== input.preflightSha256) return json(409, { error: 'backtest_preflight_changed_repeat_review' });
    const [requests, results] = await Promise.all([readWorkflowStore(factorRunRequestFile), readWorkflowStore(factorResultArtifactFile)]);
    const previous = results.items.find(row => row.experimentId === config.configId && row.dataScope?.workflowReceipt?.preflightSha256 === input.preflightSha256);
    if (previous) {
      const request = requests.items.find(row => row.requestId === previous.requestId && row.resultArtifactId === previous.artifactId);
      if (!request) return json(409, { error: 'workflow_partial_write_review_required', artifactId: previous.artifactId });
      return json(200, { reused: true, item: request, resultArtifact: previous, audit: workflowResultAudit(previous, request) });
    }
    const normalized = normalizeRunRequest({ configId: config.configId }, { configs: configs.items, existing: requests.items });
    if (normalized.error) return json(422, normalized);
    const request = { ...normalized.item, createdAt: new Date().toISOString(), requestedMode: 'guarded_backtest' };
    const artifact = await buildLocalFactorResultArtifact({ request, config, existing: results.items, snapshotStore });
    const actualSources = artifact.dataScope.calculationSources || [{ moduleName: '__main__', sha256: artifact.dataScope.calculationSourceSha256 }];
    if (fingerprint(actualSources) !== fingerprint(preflight.calculationSources)) return json(409, { error: 'backtest_calculation_source_changed' });
    const freshConfig = (await readWorkflowStore(factorExperimentConfigFile)).items.find(row => row.configId === config.configId);
    const fresh = freshConfig ? await backtestPreflight(freshConfig, researchMode, snapshotStore) : null;
    if (!fresh?.ready || fresh.preflightSha256 !== input.preflightSha256) return json(409, { error: 'backtest_preflight_changed_during_execution' });
    artifact.dataScope.workflowReceipt = { version: workflowVersion, preflightSha256: input.preflightSha256, configRevision: config.revision,
      snapshotId: config.snapshotId, researchMode, temporalEligibility: preflight.temporalEligibility, acknowledgements: input.acknowledgements };
    const now = new Date().toISOString();
    const completed = { ...request, status: 'completed_local_result_artifact', approvalState: 'explicit_assumptions_acknowledged', resultArtifactId: artifact.artifactId, executedAt: now, updatedAt: now, preflightSha256: input.preflightSha256 };
    results.items.push(artifact); requests.items.push(completed);
    // Separate stores are not a transaction. A partial commit is reported and never blindly rerun.
    await writeFactorResultArtifacts(results); await writeFactorRunRequests(requests);
    return json(200, { reused: false, item: completed, resultArtifact: artifact, audit: workflowResultAudit(artifact, completed) });
  } catch (error) { return json(error.status || 503, { error: error.status ? error.message : 'backtest_tool_unavailable_review_before_retry' }); }
}

async function factorBacktestEngine(json) {
  const [panel, assets, results] = await Promise.all([
    readOldFactorJson('out/panel.json'),
    listFactorAssets(),
    readFactorResultArtifacts(),
  ]);
  const assetById = new Map(assets.map(item => [item.assetId, item]));
  const panelAsset = assetById.get('factors.etf_smartbeta.panel');
  const broadAsset = assetById.get('factors.etf_smartbeta.broad');
  const fundWide = assetById.get('factors.fund_warehouse.wide_today');
  const factorCategoryCoverage = panel.lib.map(item => ({
    key: item.key,
    title: item.cat,
    kind: item.kind === 'sb' ? 'smart_beta' : 'alpha',
    slotCount: item.items.length,
    fields: item.items.map(slot => ({ slot: slot.slot, field: slot.k, name: slot.n, weight: slot.w, sign: slot.sign })),
  }));
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'backtest_engine_status',
    activeEngine: {
      engineId: 'engine.factor.panel_json_monthly_topn_v1',
      title: 'panel.json 月度横截面 TopN 执行器',
      status: 'active_for_industry_panel_configs',
      computePolicy: 'reads_exported_panel_json_recomputes_monthly_scores_no_fetch_no_old_script',
      supportedSnapshotIds: ['snapshot.etf_smartbeta.industry_panel.current'],
      supportedArtifactCandidateIds: ['artifact.factor.backtest.monthly_dca_engine', 'artifact.factor.study.decomposition'],
      outputArtifactVersion: 'panel-json-engine-v1',
      calculations: ['monthly_factor_score', 'topn_equal_weight_portfolio', 'turnover_cost_fee', 'benchmark_compare', 'factor_diagnostics', 'sensitivity_grid'],
    },
    fallbackEngine: {
      engineId: 'engine.factor.exported_curve_fallback_v0',
      title: '旧导出曲线结果封装',
      status: 'historical_only_disabled_for_new_execution',
      computePolicy: 'reuses_exported_curves_no_recompute',
      reason: '旧结果封装保留为历史资产；新请求遇到不支持的配置返回422，不复用旧曲线生成结果。',
    },
    nextEngines: [
      {engineId:'engine.factor.legacy_510300_pe_dca_v1',title:legacyDcaEngine.title,status:'active_for_guarded_frozen_archive',supportedSnapshotIds:['matching_frozen_510300_archive'],
        calculations:['prior_pe_percentile','monthly_ladder_cashflows','pre_flow_vwap_unitization','dated_xirr'],blockers:['historical_information_availability','real_vwap_execution']},
      { engineId: 'engine.factor.custom_industry_expression_v1', title: customExpressionEngine.title, status: 'active_for_registered_bounded_industry_formulas',
        supportedSnapshotIds: customExpressionEngine.inputSnapshotIds, calculations: ['explicit_field_bindings', 'safe_ast_dependency_order', 'backward_full_windows', 'complete_case_zscore', 'immutable_revision_sha', 'prior_signal_monthly_topn'],
        blockers: ['fund_historical_factor_selection', 'point_in_time_disclosures', 'full_attribution'] },
      { engineId: 'engine.factor.fund_nav_fixed_dca_v1', title: fundNavEngine.title, status: 'active_for_manual_daily_same_adjustment_baskets',
        supportedSnapshotIds: [...fundNavEngine.inputSnapshotIds, 'matching_frozen_selected_nav_bundle'], calculations: ['sqlite_selected_import_sha_read_transaction', 'selected_immutable_snapshot_verified_bytes', 'adjustment_frequency_checks', 'common_observed_calendar', 'fixed_weight_new_contributions', 'dated_twr_xirr'],
        blockers: ['historical_point_in_time_factor_selection', 'actual_settlement_and_redemption_rules'] },
      {
        engineId: 'engine.factor.three_bucket_monthly_v1', title: threeBucketEngine.title,
        status: 'active_for_explicit_eight_file_three_bucket_configs',
        supportedSnapshotIds: [...threeBucketEngine.inputSnapshotIds, 'matching_frozen_eight_file_bundle'],
        calculations: ['monthly_dated_flows', 'pe_trend_gate', 'industry_rotation_holding_limit', 'lagged_macro_basis_timing', 'sleeve_twr_xirr', 'once_only_calendar_interest_fees'],
        blockers: ['macro_revision_vintages_actual_release_dates', 'real_etf_and_bond_nav', 'full_performance_attribution'],
      },
      {
        engineId: 'engine.factor.parquet_panel_monthly_topn_v2',
        title: '直接读取panel.parquet的行业回测引擎',
        status: panelAsset?.exists ? 'active_for_explicit_parquet_industry_configs' : 'source_missing',
        sourceAssetId: 'factors.etf_smartbeta.panel',
        supportedSnapshotIds: ['snapshot.etf_smartbeta.industry_execution.current', 'matching_frozen_industry_execution_bundle'],
        calculations: ['raw_timeseries_factors', 'lagged_cross_section_zscore', 'investable_date_filter', 'monthly_equal_weight', 'daily_nav', 'once_only_fee', 'aligned_hs300_benchmark', 'cost_sensitivity'],
        blockers: ['historical_disclosure_dates', 'constituent_survivorship_audit', 'real_etf_execution'],
      },
      {
        engineId: 'engine.factor.fund_wide_cross_section_v1',
        title: '基金宽表横截面筛选与诊断引擎',
        status: fundWide?.exists ? 'active_for_single_group_cross_section' : 'source_missing',
        sourceAssetId: 'factors.fund_warehouse.wide_today',
        calculations: ['explicit_field_bindings', 'primary_share_filter', 'fund_or_share_deduplication', 'single_comparison_group', 'weighted_percentile_rank', 'missing_value_audit'],
        blockers: ['historical_factor_selection_nav_linkage', 'historical_point_in_time_snapshot'],
      },
      {
        engineId: 'engine.factor.broad_panel_dca_v1',
        title: 'Parquet宽基定投与固定宽基/现金分档执行器',
        status: broadAsset?.exists ? 'active_for_fixed_broad_dca_configs' : 'source_missing',
        sourceAssetId: 'factors.etf_smartbeta.broad',
        supportedPolicies: ['broad_only', 'broad_split_cash'],
        supportedFrequencies: ['monthly', 'weekly', 'biweekly'],
        calculations: ['actual_dated_cash_flows', 'close_price_purchase', 'buy_costs', 'calendar_day_annual_fee', 'unit_nav_twr', 'dated_xirr', 'same_flow_benchmark'],
        blockers: ['real_etf_execution_calendar_audit'],
      },
    ],
    panelInput: {
      sourceFile: path.join(oldFactorRoot, 'out/panel.json'),
      monthCount: panel.months.length,
      industryCount: panel.inds.length,
      factorFieldCount: panel.fkeys.length,
      firstMonth: panel.months[0],
      lastMonth: panel.months.at(-1),
      minInvestableIndustries: panel.cfg?.min_inv,
      topNDefault: panel.cfg?.top_n,
      costDefault: panel.cfg?.cost,
      feeSectorDefault: panel.cfg?.fee_sector,
      factorCategoryCoverage,
    },
    resultStore: {
      count: results.items.length,
      panelEngineCount: results.items.filter(item => item.computePolicy === 'panel_json_monthly_cross_section_engine_v1_no_fetch_no_old_script').length,
      broadDcaEngineCount: results.items.filter(item => item.executionMode === 'native_workbench_parquet_broad_dca_v1').length,
      fallbackCount: results.items.filter(item => item.computePolicy === 'exported_curve_fallback_v0_reuses_old_results_no_fetch_no_old_script').length,
    },
    auditChecklist: [
      { checkId: 'lag_policy', title: '滞后与可见日期', status: 'needs_parquet_level_audit', notes: 'panel.json已是导出结果，下一步需在parquet/宽表层校验每个字段的可见日期。' },
      { checkId: 'survivorship', title: '样本与幸存者偏差', status: 'needs_source_universe_audit', notes: '需要确认行业/基金样本是否包含退市、清盘或不可投资阶段。' },
      { checkId: 'cost_model', title: '成本、费率和换手', status: 'implemented_v1_estimate', notes: '当前执行器按换手成本和行业年费估算，后续要接真实ETF费率和成交约束。' },
      { checkId: 'benchmark_alignment', title: '基准与收益对齐', status: 'implemented_v1_needs_review', notes: '当前基准使用沪深300和中证1000等权月收益，后续要按配置选择基准。' },
      { checkId: 'attribution', title: '归因计算', status: 'implemented_v1_approximation', notes: '当前归因用单因子/留一重跑估计，需要进一步拆时间因素和非时间因素。' },
    ],
  });
}

async function factorRunRequests({ method, body, json }) {
  if (method === 'GET' || method === 'HEAD') {
    const requests = await readFactorRunRequests();
    return json(200, {
      schemaVersion: 1,
      module: 'factors',
      apiVersion: 'v1',
      mode: 'local_run_request_queue_no_execution',
      count: requests.items.length,
      items: requests.items,
    });
  }
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST' });
  const parsed = parseJsonBody(body);
  if (parsed.error) return json(400, parsed);
  const configs = await readFactorExperimentConfigs();
  const requests = await readFactorRunRequests();
  const normalized = normalizeRunRequest(parsed.value, { configs: configs.items, existing: requests.items });
  if (normalized.error) return json(422, normalized);
  const now = new Date().toISOString();
  const item = { ...normalized.item, status: 'prepared_no_execution', createdAt: now, updatedAt: now };
  requests.items.push(item);
  await writeFactorRunRequests(requests);
  return json(201, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item });
}

async function factorRunRequestExecute(url, { method, json, snapshotStore }) {
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const parts = url.pathname.split('/');
  const requestId = decodeURIComponent(parts.at(-2) || '');
  if (!validRunRequestId(requestId)) return json(400, { error: 'invalid_request_id' });
  const [requests, configs, results] = await Promise.all([
    readFactorRunRequests(),
    readFactorExperimentConfigs(),
    readFactorResultArtifacts(),
  ]);
  const index = requests.items.findIndex(item => item.requestId === requestId);
  if (index < 0) return json(404, { error: 'run_request_not_found' });
  const request = requests.items[index];
  if (request.requestedMode === 'guarded_backtest' || request.preflightSha256) return json(409, { error: 'guarded_request_requires_backtest_tool', resultArtifactId: request.resultArtifactId || null });
  const config = configs.items.find(item => item.configId === request.configId);
  if (!config) return json(422, { error: 'config_not_found_for_request' });
  let artifact;
  try {
    artifact = await buildLocalFactorResultArtifact({ request, config, existing: results.items, snapshotStore });
  } catch (error) {
    return json(error.status || 503, { error: error.status ? error.message : 'factor_execution_unavailable' });
  }
  const now = new Date().toISOString();
  const existingIndex = results.items.findIndex(item => item.artifactId === artifact.artifactId);
  if (existingIndex >= 0) results.items[existingIndex] = artifact;
  else results.items.push(artifact);
  requests.items[index] = {
    ...request,
    status: 'completed_local_result_artifact',
    approvalState: 'local_execution',
    resultArtifactId: artifact.artifactId,
    executedAt: now,
    updatedAt: now,
    computePolicy: artifact.computePolicy,
  };
  await Promise.all([writeFactorRunRequests(requests), writeFactorResultArtifacts(results)]);
  return json(200, { schemaVersion: 1, module: 'factors', apiVersion: 'v1', item: requests.items[index], resultArtifact: artifact });
}

async function factorResultArtifacts(json) {
  const results = await readFactorResultArtifacts();
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'local_factor_result_artifacts',
    count: results.items.length,
    items: results.items,
    note: '原始行业策略读取panel/bench/investable.parquet；旧行业配置仍用panel.json；定投读取broad.parquet，基金筛选读取wide_today.csv。不支持的配置返回422。',
  });
}

async function factorResultArtifact(url, json) {
  const artifactId = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!validResultArtifactId(artifactId)) return json(400, { error: 'invalid_artifact_id' });
  const results = await readFactorResultArtifacts();
  const item = results.items.find(result => result.artifactId === artifactId);
  if (!item) return json(404, { error: 'result_artifact_not_found' });
  return json(200, {
    schemaVersion: 1,
    module: 'factors',
    apiVersion: 'v1',
    mode: 'local_factor_result_artifact_detail',
    item,
    reviewChecklist: resultReviewChecklist(item),
  });
}

function resultReviewChecklist(item) {
  if (item.artifactType === 'fund_cross_section_screen') return [
    { checkId: 'config_snapshot_bound', title: '配置与源版本绑定', status: item.configSnapshot?.snapshotId && item.dataScope?.sourceVersion?.sha256 ? 'ready' : 'missing', notes: item.dataScope?.sourceVersion?.sha256 || '缺少源文件版本。' },
    { checkId: 'field_bindings', title: '字段定义与得分明细', status: item.screening?.factorDefinitions?.length && item.screening?.candidates?.every(row => row.factorDetails?.length === item.screening.factorDefinitions.length) ? 'ready' : 'missing', notes: `${item.screening?.factorDefinitions?.length || 0} 个排序字段；保留源字段、方向、权重与原值。` },
    { checkId: 'filter_audit', title: '筛选与缺失审计', status: item.screening?.filterAudit?.length ? 'ready' : 'missing', notes: `缺失策略：${item.screening?.missingValuePolicy || '-'}` },
    { checkId: 'historical_returns', title: '历史回测与归因', status: 'not_applicable', notes: '最新横截面筛选不产生组合历史收益、Alpha或IRR。' },
    { checkId: 'warning_review', title: '数据日期与口径复核', status: 'review_required', notes: '各基金指标历史区间可能不同，需复核候选的数据起止日期。' },
  ];
  return [
    {
      checkId: 'config_snapshot_bound',
      title: '配置快照绑定',
      status: item.configSnapshot?.snapshotId ? 'ready' : 'missing',
      notes: item.configSnapshot?.snapshotId || '缺少snapshotId，不能进入横向对比。',
    },
    {
      checkId: 'benchmark_bound',
      title: '基准绑定',
      status: item.configSnapshot?.benchmarkId ? 'ready' : 'missing',
      notes: item.configSnapshot?.benchmarkId || '缺少benchmarkId。',
    },
    {
      checkId: 'factor_diagnostics',
      title: '因子诊断',
      status: item.executionMode === 'native_workbench_parquet_broad_dca_v1' ? 'not_applicable' : item.attribution?.factorDiagnostics?.length ? 'ready' : 'missing',
      notes: item.executionMode === 'native_workbench_parquet_broad_dca_v1' ? '当前为固定宽基/现金配置，不计算Alpha因子诊断。' : `${item.attribution?.factorDiagnostics?.length || 0} 个因子诊断项。`,
    },
    {
      checkId: 'sensitivity_grid',
      title: '敏感度网格',
      status: item.sensitivity?.length ? 'ready' : 'pending',
      notes: `${item.sensitivity?.length || 0} 个敏感度案例。`,
    },
    {
      checkId: 'warning_review',
      title: '警示复核',
      status: item.warnings?.length ? 'review_required' : 'ready',
      notes: (item.warnings || []).join(' / ') || '暂无警示。',
    },
  ];
}

async function readFactorResultArtifacts() {
  try {
    const data = JSON.parse(await readFile(factorResultArtifactFile, 'utf8'));
    return { schemaVersion: 1, module: 'factors', items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { schemaVersion: 1, module: 'factors', items: [] };
  }
}

async function writeFactorResultArtifacts(data) {
  await mkdir(path.dirname(factorResultArtifactFile), { recursive: true });
  const payload = {
    schemaVersion: 1,
    module: 'factors',
    updatedAt: new Date().toISOString(),
    items: data.items,
  };
  await writeFile(factorResultArtifactFile, `${JSON.stringify(payload, null, 2)}\n`);
}

async function buildLocalFactorResultArtifact({ request, config, existing, snapshotStore }) {
  const artifactId = makeResultArtifactId(request.requestId, existing);
  if (config.strategyTemplateId === 'strategy.legacy_510300_pe_dca') return buildLegacyDcaResultArtifact({request, config, artifactId, snapshotStore});
  if (config.strategyTemplateId === 'strategy.custom_industry_expression') return buildIndustryResultArtifact({ request, config, artifactId, snapshotStore, custom:true });
  if (config.strategyTemplateId === 'strategy.fund_nav_fixed_dca') return buildFundNavResultArtifact({ request, config, artifactId, snapshotStore });
  if (config.strategyTemplateId === 'strategy.legacy_three_bucket_monthly') return buildThreeBucketResultArtifact({ request, config, artifactId, snapshotStore });
  if (config.strategyTemplateId === 'strategy.industry_parquet_monthly_topn') return buildIndustryResultArtifact({ request, config, artifactId, snapshotStore });
  if (config.strategyTemplateId === 'strategy.fund_cross_section_screen') return buildFundScreenResultArtifact({ request, config, artifactId, snapshotStore });
  if (config.strategyTemplateId === 'strategy.monthly_dca_three_bucket' || Object.keys(config.transactionSettings || {}).length) {
    return buildBroadDcaResultArtifact({ request, config, artifactId, snapshotStore });
  }
  if (canRunPanelJsonBacktest(config, request)) {
    return buildPanelJsonFactorResultArtifact({ request, config, artifactId });
  }
  throw Object.assign(new Error('unsupported_factor_execution_config'), { status: 422 });
}

async function buildLegacyDcaResultArtifact({request, config, artifactId, snapshotStore}) {
  if (request.requestedMode !== 'guarded_backtest' || request.artifactCandidateId !== legacyDcaEngine.artifactCandidateId) throw Object.assign(new Error('legacy_dca_requires_guarded_backtest_tool'), {status:422});
  const input = await factorInput(config.snapshotId, 'factors.legacy.510300', legacyDcaEngine.inputSnapshotIds[0], snapshotStore);
  const directory = path.join(projectRoot, 'modules/factors/src');
  const {stdout, sourceHashes} = await executePinnedPython(path.join(directory, 'legacy_dca_engine.py'),
    [input.storageRef, input.expectedSha256, 'execute', JSON.stringify(config), JSON.stringify(input.snapshot.selection)],
    {timeout:30000, modules:['legacy_html_literals','dca_engine'].map(name=>({name,path:path.join(directory,`${name}.py`)}))});
  const run = JSON.parse(stdout);
  if (run.error) throw Object.assign(new Error(run.error), {status:/integrity|binding_mismatch/.test(run.error)?409:422});
  await snapshotStore.verify(config.snapshotId);
  const series = Object.fromEntries(['accountValue','benchmarkValue','unitNav','benchmarkNav','contributed'].map(key=>[key,run.accountLedger.map(row=>({date:row.date,value:row[key]}))]));
  return {artifactId, module:'factors', experimentId:config.configId, requestId:request.requestId, title:config.title,
    version:run.version, createdAt:new Date().toISOString(), status:'review_required', sourceIds:['factors.legacy.510300'],
    storageRef:`var/factors/result-artifacts.json#${artifactId}`, executionMode:'native_workbench_legacy_510300_pe_dca_v1', computePolicy:legacyDcaEngine.computePolicy,
    configSnapshot:{...resultConfigSnapshot(config), configRevision:config.revision}, period:run.period, metrics:run.metrics, series,
    accountLedger:run.accountLedger, cashFlows:run.cashFlows, benchmarkCashFlows:run.benchmarkCashFlows, trades:run.trades, comparisonPolicy:run.comparisonPolicy,
    holdings:[], sensitivity:[], warnings:run.warnings,
    dataScope:{snapshotId:config.snapshotId, frozenSnapshot:input.snapshot, sourceVersion:{assetId:'factors.legacy.510300',sha256:input.expectedSha256,archiveId:input.snapshot.selection.archiveId},
      calculationSources:sourceHashes, temporalEligibility:{status:'not_point_in_time_verified',reason:'归档估值观测滞后不证明披露可得时间；VWAP/复权价格为假设模拟。'},
      limitation:'归档只冻结输入，不证明PIT/可交易性；无约束模式不同现金流不按期末财富排名；不计算因果Alpha。'} };
}

async function buildFundNavResultArtifact({ request, config, artifactId, snapshotStore }) {
  if (request.artifactCandidateId !== fundNavEngine.artifactCandidateId) throw Object.assign(new Error('unsupported_fund_nav_engine_candidate'), { status: 422 });
  const input = await factorInput(config.snapshotId, 'factors.fund_warehouse.nav_db', fundNavEngine.inputSnapshotIds[0], snapshotStore);
  const { run, sourceHashes } = await fundNavPython('execute', config, input);
  const series = Object.fromEntries(['accountValue', 'benchmarkValue', 'unitNav', 'benchmarkNav', 'contributed'].map(key => [key, sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row[key]), 180)]));
  return {
    artifactId, module: 'factors', experimentId: config.configId, requestId: request.requestId, title: request.title || `${config.title} 净值回测`,
    version: run.version, createdAt: new Date().toISOString(), status: 'review_required', sourceIds: ['factors.fund_warehouse.nav_db'],
    storageRef: `var/factors/result-artifacts.json#${artifactId}`, executionMode: 'native_workbench_fund_nav_fixed_dca_v1', computePolicy: fundNavEngine.computePolicy,
    configSnapshot: { ...resultConfigSnapshot(config), configRevision: config.revision }, period: run.period, metrics: run.metrics, series, accountLedger: run.rows, cashFlows: run.cashFlows, pendingContributions: run.pendingContributions,
    fundNavProfile: run.profile, holdings: [], sensitivity: [], attribution: run.attribution, warnings: run.warnings,
    dataScope: { snapshotId: config.snapshotId, frozenSnapshot: input.snapshot, sourceVersions: run.profile.sourceVersions, calculationSources: sourceHashes, calendarAudit: run.calendarAudit, allocationWeights: run.allocationWeights,
      calculationLogic: ['仅从新工作台SQLite读取选定份额的adj_nav及导入SHA，读事务保证源一致；CSV更新须显式重新导入。日频与复权方式同组，不用最新宽表做历史择优或最新持仓反推复合基准。',
        '基准显式单指数，全收益或价格口径保存。执行日历为所有份额与基准实际日期交集，不填充；计划投入在计划日之后首个共同数据日执行。超出共同覆盖或超过配置日期缺口上限拒绝。',
        '新投入按固定比例，净买入预算=金额×权重/(1+申购费+滑点)。持仓不卖出或再平衡；复权净值模拟份额不等于实际申购确认份额。',
        '基金净值已体现日常管理等费用，不再扣年费。基准接受同现金流毛指数，不扣模拟申购费；TWR排除外部投入，XIRR使用实际日期。',
        '波动年化系数=(共同观测数-1)/实际区间年数，不固定为252或244；Sharpe无风险利率为0。'],
      temporalEligibility: { status: 'not_point_in_time_verified', historicalFactorSelectionAllowed: false, reason: '手动固定篮子；日期是净值观测日，不是净值/持仓/名录披露可得时间。冻结只保证输入可复现，不消除幸存者偏差或证明无超前数据。' },
      limitation: '手动选取存续基金有幸存者偏差；旧自复权与hfq口径保留，未重新核验每次分红拆分。共同日历可能排除部分净值日期。没有实际申赎/确认滞后、历史因子轮动、赎回规则或完整归因。冻结选定源不等于PIT数据。' },
  };
}

async function buildThreeBucketResultArtifact({ request, config, artifactId, snapshotStore }) {
  if (request.artifactCandidateId !== threeBucketEngine.artifactCandidateId) throw Object.assign(new Error('unsupported_three_bucket_engine_candidate'), { status: 422 });
  const assetIds = ['broad', 'bench', 'panel', 'investable', 'basis', 'macro_pmi', 'macro_m2', 'macro_shibor'].map(name => `factors.etf_smartbeta.${name}`);
  const inputs = [];
  for (const assetId of assetIds) inputs.push(await factorInput(config.snapshotId, assetId, threeBucketEngine.inputSnapshotIds[0], snapshotStore));
  const { stdout, sha256, sourceHashes } = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/three_bucket_engine.py'), [JSON.stringify(inputs.map(item => item.storageRef)), JSON.stringify(config)], threeBucketPythonOptions());
  const run = JSON.parse(stdout);
  if (run.error) throw Object.assign(new Error(run.error), { status: 422 });
  inputs.forEach((input, i) => {
    if (input.expectedSha256 && input.expectedSha256 !== run.sourceVersions[i].sha256) throw Object.assign(new Error('frozen_snapshot_integrity_failed'), { status: 409 });
  });
  const series = Object.fromEntries(['accountValue', 'benchmarkValue', 'unitNav', 'benchmarkNav', 'contributed'].map(key => [key, sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row[key]), 180)]));
  for (const bucket of ['A', 'B', 'C']) series[`bucket${bucket}Nav`] = sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row.sleeveNavs[bucket]), 180);
  return {
    artifactId, module: 'factors', experimentId: config.configId, requestId: request.requestId, title: request.title || `${config.title} 三档结果`,
    version: run.calculationVersion, createdAt: new Date().toISOString(), status: 'review_required', sourceIds: assetIds,
    storageRef: `var/factors/result-artifacts.json#${artifactId}`, executionMode: 'native_workbench_three_bucket_monthly_v1', computePolicy: threeBucketEngine.computePolicy,
    configSnapshot: { ...resultConfigSnapshot(config), configRevision: config.revision }, period: run.period,
    metrics: run.metrics, series, cashFlows: run.cashFlows, sleeveMetrics: run.sleeveMetrics, accountLedger: run.rows,
    scoreHistory: run.decisions, holdings: run.decisions.map(({ scores, ...row }) => ({ ...row, codes: row.holdingCodes, names: row.holdingNames })), timingHistory: run.decisions.map(({ scores, fieldCoverage, ...row }) => row),
    sensitivity: [], attribution: run.attribution,
    warnings: ['review_required_before_research_use', ...run.warnings],
    dataScope: { snapshotId: config.snapshotId, frozenSnapshot: inputs[0].snapshot,
      sourceVersions: run.sourceVersions.map((version, i) => ({ assetId: assetIds[i], ...version })), calculationSourceSha256: sha256, calculationSources: sourceHashes,
      calculationPolicy: run.calculationPolicy, calendarAudit: run.calendarAudit, allocationWeights: run.allocationWeights,
      calculationLogic: ['月度首个共同数据日收盘投入；B比例大于0时日历取宽基与行业日期交集，排除日期随结果记录；若整月无共同日则拒绝。单个持仓缺报价仍拒绝，不填充。',
        'A/B/C配置权重合计1。B合格行业不足时仅新投入转A，旧B持仓继续持有。',
        'A可用现金在买入前固定预算，分别按宽基权重判断前日PE分位和趋势闸门；停投部分留现金，之后重新按A比例分配。',
        'B沿用行业因子代理打分，前日信号、可投资日期过滤、月度等权；期限可选旧版30.44天/月或日历月，激活月份检查到期强制卖出且当月不再买入，先卖后买并求解扣交易费后的目标资本。',
        'C股票比例为可用基差信号与宏观平均分的均值；三项宏观只使用建模可用日不晚于信号日的值；全部缺失时采用配置中性比例。',
        'PMI/M2按日历月滞后，Shibor月末值最早下月可用，不能月初看到当月末数据；滞后是模型假设，不证明真实发布日期或历史修订版本。',
        '现金按自然日复利计息一次，C现金仅使用模拟债券年收益率；新收盘投入不计当日利息。年费仅从实际持仓扣一次。',
        '总账户和分档均扣除投入影响计算TWR；IRR使用各自实际投入日期和终值。买入费用=预算×单边费率、卖出费用=卖出市值×单边费率；基准不扣费。'],
      limitation: '宽基、行业指数代理而非真实ETF成交；C现金是固定收益率模型而非债券净值。宏观修订历史、真实发布日期、财务披露与历史成分未核验。旧脚本同月Shibor及重复计息已纠正，曲线不承诺与旧结果一致；未计算Alpha/Smart Beta/残差归因。' },
  };
}

async function buildIndustryResultArtifact({ request, config, artifactId, snapshotStore, custom=false }) {
  if (request.artifactCandidateId !== (custom ? customExpressionEngine : industryEngine).artifactCandidateId) throw Object.assign(new Error('unsupported_industry_engine_candidate'), { status: 422 });
  const assetIds = ['factors.etf_smartbeta.panel', 'factors.etf_smartbeta.bench', 'factors.etf_smartbeta.investable'];
  const inputs = [];
  for (const assetId of assetIds) inputs.push(await factorInput(config.snapshotId, assetId, 'snapshot.etf_smartbeta.industry_execution.current', snapshotStore));
  const { stdout, sha256: calculationSourceSha256, sourceHashes } = custom
    ? await expressionPython('execute', config, inputs.map(item => item.storageRef))
    : await executePinnedPython(path.join(projectRoot, 'modules/factors/src/industry_engine.py'), [...inputs.map(item => item.storageRef), JSON.stringify(config)]);
  const run = JSON.parse(stdout);
  if (run.error) throw Object.assign(new Error(run.error), { status: 422 });
  inputs.forEach((input, i) => {
    if (input.expectedSha256 && input.expectedSha256 !== run.sourceVersions[i].sha256) throw Object.assign(new Error('frozen_snapshot_integrity_failed'), { status: 409 });
  });
  const series = Object.fromEntries(['accountValue', 'benchmarkValue', 'unitNav', 'benchmarkNav', 'contributed'].map(key => [key, sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row[key]), 180)]));
  return {
    artifactId, module: 'factors', experimentId: config.configId, requestId: request.requestId, title: request.title || `${config.title} 行业结果`,
    version: run.calculationVersion, createdAt: new Date().toISOString(), status: 'review_required', sourceIds: assetIds,
    storageRef: `var/factors/result-artifacts.json#${artifactId}`, executionMode: custom ? 'native_workbench_custom_industry_expression_v1' : 'native_workbench_parquet_industry_topn_v1',
    computePolicy: custom ? customExpressionEngine.computePolicy : industryEngine.computePolicy,
    ...(custom ? {factorProgram:run.factorProgram,formulaAudit:run.formulaAudit} : {}),
    configSnapshot: { ...resultConfigSnapshot(config), configRevision: config.revision }, period: run.period, metrics: run.metrics, series,
    accountLedger: run.rows, holdings: run.decisions.map(({ scores, ...row }) => row), scoreHistory: run.decisions, factorDefinitions: run.factorDefinitions, sensitivity: run.sensitivity,
    attribution: run.attribution, riskModel: run.riskModel,
    warnings: ['review_required_before_research_use', ...run.warnings],
    dataScope: { snapshotId: config.snapshotId, frozenSnapshot: inputs[0].snapshot, sourceVersions: run.sourceVersions.map((version, i) => ({ assetId: assetIds[i], ...version })),
      sourceFiles: ['data/panel.parquet', 'data/bench.parquet', 'data/investable.parquet'], calculationVersion: run.calculationVersion,
      calculationSourceSha256,
      ...(custom ? {calculationSources:sourceHashes,factorProgram:run.factorProgram,formulaAudit:run.formulaAudit} : {}),
      signalLagDays: run.signalLagDays, costRates: run.costRates, sourceAudit: run.sourceAudit,
      calculationLogic: ['每个行业按自身过去观测计算时序因子，使用调仓日前指定个全局面板日期的横截面打分，买入后才计收益。',
        custom ? '用户公式采用字段白名单和有界AST，按行业后向观测计算；正权重子因子必须全部有效，同日至少3个有效值、总体标准差z-score缩尾±3，方向和归一化权重应用一次。依赖与原值/贡献可查，不执行用户代码。' : '横截面z-score使用同日至少3个有效值、总体标准差，缩尾至±3；缺失槽位贡献0，有效加权覆盖为0的行业排除；其余保留固定子权重，不按缺失重分配。',
        '可投资日期不晚于调仓日才进入TopN；不足最小合格数时转现金，现金收益0。行业收益=价格日收益+前一观测股息率/100/244，属于全收益近似。',
        '先计旧持仓收益及日间费，再于月度首个数据日收盘按漂移后权重调仓；单边交易额比例为各资产目标与漂移权重绝对差之和，初次买入1、全部切换2。',
        '交易成本=调仓前价值×单边交易额比例×(佣金+滑点)；年费仅对持仓按自然日间隔扣一次，现金不扣费。',
        '单位资本期初1，没有定投现金流；金额加权IRR为空。基准按相同起止数据日取沪深300全收益指数，不扣交易费用；明确净策略/毛基准差异。'],
      limitation: '原始行业数据实际重算，不使用旧导出曲线。可投资名单和历史行业成分仍可能有幸存者偏差；前日信号不证明财务披露时点可见。规模族这里只执行成交占比流动性代理，未计算市值规模。择时、真实ETF交易和完整归因尚未实现。' },
  };
}

async function buildFundScreenResultArtifact({ request, config, artifactId, snapshotStore }) {
  const input = await factorInput(config.snapshotId, 'factors.fund_warehouse.wide_today', 'snapshot.fund_warehouse.wide_today.current', snapshotStore);
  if (request.artifactCandidateId !== 'artifact.factor.fund_cross_section_screen') throw Object.assign(new Error('unsupported_fund_screen_engine_candidate'), { status: 422 });
  const definitions = await fundScreenDefinitions(input.storageRef);
  const settings = config.strategySettings || {};
  if (!Array.isArray(settings.rankFields) || !settings.rankFields.every(item => item && typeof item === 'object' && typeof item.factorFamilyId === 'string')) throw Object.assign(new Error('fund_rank_fields_required'), { status: 422 });
  if (!/^[a-f0-9]{64}$/.test(settings.sourceSha256 || '')) throw Object.assign(new Error('fund_source_profile_required'), { status: 422 });
  const selectedFamilies = [...new Set((settings.rankFields || []).map(item => item.factorFamilyId))].sort();
  if (JSON.stringify(selectedFamilies) !== JSON.stringify([...new Set(config.factorFamilyIds || [])].sort())) throw Object.assign(new Error('fund_factor_family_binding_mismatch'), { status: 422 });
  if (input.expectedSha256 && input.expectedSha256 !== settings.sourceSha256) throw Object.assign(new Error('fund_source_version_changed_reload_profile'), { status: 422 });
  const result = await readFundScreen('screen', { settings, definitions, expectedSha256: settings.sourceSha256 }, input.storageRef);
  return {
    artifactId, module: 'factors', experimentId: config.configId, requestId: request.requestId, title: request.title || `${config.title} 筛选结果`,
    version: 'fund-wide-screen-v1', createdAt: new Date().toISOString(), status: 'review_required',
    storageRef: `var/factors/result-artifacts.json#${artifactId}`, sourceIds: ['factors.fund_warehouse.wide_today'],
    artifactType: 'fund_cross_section_screen', executionMode: 'native_workbench_fund_wide_screen_v1', computePolicy: 'fund_csv_single_group_factor_rank_no_fetch_no_history_backtest',
    configSnapshot: { ...resultConfigSnapshot(config), configRevision: config.revision }, metrics: result.metrics,
    screening: result, series: {}, cashFlows: [], holdings: [], sensitivity: [],
    attribution: { alphaReturn: null, smartBetaReturn: null, residualReturn: null, factorDiagnostics: [], explanation: '本结果仅对现成宽表横截面做同组指标排序，不计算历史组合收益或Alpha归因。' },
    warnings: ['latest_cross_section_not_point_in_time_history', 'unequal_fund_history_periods_require_review', ...result.warnings],
    dataScope: { snapshotId: config.snapshotId, frozenSnapshot: input.snapshot, sourceFiles: ['wide_today.csv'], sourceVersion: result.sourceVersion, comparisonGroup: result.comparisonGroup,
      limitation: '策略类型、实际净值频率、基准及基准口径严格同组。使用宽表已有指标，不重算净值指标；最新横截面不能用于历史时点回测。费用字段别名不改变源数值单位。',
      calculationLogic: ['主份额模式仅保留is_primary=1，按fund_key去重；份额模式按share_code去重，代码保留前导零。', '高优先指标按原值升序排名，低优先指标按原值降序排名；同值取平均名次，归一化为(名次-1)/(有效样本数-1)，单样本记0.5。', '综合得分=各字段归一化得分×归一化权重之和，降序选择TopN；同分按份额代码稳定排序。', '缺失策略为排除不完整样本，或对缺失字段赋中性分0.5；完全无指标样本剔除，整个字段无有效数值时拒绝计算。', '原值、字段定义及版本、权重、贡献分、每步排除数量和文件SHA均随结果保存。'] },
  };
}

async function buildBroadDcaResultArtifact({ request, config, artifactId, snapshotStore }) {
  const input = await factorInput(config.snapshotId, 'factors.etf_smartbeta.broad', 'snapshot.etf_smartbeta.broad_panel.current', snapshotStore);
  if (request.artifactCandidateId !== 'artifact.factor.backtest.monthly_dca_engine') throw Object.assign(new Error('unsupported_dca_engine_candidate'), { status: 422 });
  const asset = factorDataAssets.find(item => item.assetId === 'factors.etf_smartbeta.broad');
  const { stdout, sha256, sourceHashes } = await executePinnedPython(path.join(projectRoot, 'modules/factors/src/dca_engine.py'), [input.storageRef, JSON.stringify(config)], { timeout: 30000, maxBuffer: 12 * 1024 * 1024 });
  const run = JSON.parse(stdout);
  if (run.error) throw Object.assign(new Error(run.error), { status: 422 });
  if (input.expectedSha256 && input.expectedSha256 !== run.sourceVersion.sha256) throw Object.assign(new Error('frozen_snapshot_integrity_failed'), { status: 409 });
  const series = Object.fromEntries(['accountValue', 'benchmarkValue', 'unitNav', 'benchmarkNav', 'contributed'].map(key => [key, sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row[key]), 180)]));
  return {
    artifactId, module: 'factors', experimentId: config.configId, requestId: request.requestId,
    title: request.title || `${config.title} 定投结果`, version: 'parquet-broad-dca-v1', createdAt: new Date().toISOString(),
    status: 'review_required', sourceIds: [asset.assetId], storageRef: `var/factors/result-artifacts.json#${artifactId}`,
    computePolicy: 'parquet_broad_dca_cash_flow_recompute_no_fetch_no_old_script', executionMode: 'native_workbench_parquet_broad_dca_v1',
    configSnapshot: { ...resultConfigSnapshot(config), configRevision: config.revision },
    period: run.period, metrics: run.metrics, series, cashFlows: run.cashFlows, pendingContributions: run.pendingContributions, accountLedger: run.rows,
    attribution: run.attribution,
    holdings: [], sensitivity: [],
    warnings: ['review_required_before_research_use', 'broad_total_return_index_proxy_not_real_etf_execution', 'alpha_smart_beta_attribution_not_computed', ...run.warnings],
    dataScope: { snapshotId: config.snapshotId, frozenSnapshot: input.snapshot, sourceProject: asset.ownerProject, sourceFiles: ['data/broad.parquet'], sourceVersion: run.sourceVersion, calculationSourceSha256: sha256, calculationSources: sourceHashes, allocationWeights: run.weights, costRates: run.costRates, calculationNotes: run.calculationNotes,
      calculationLogic: [
        '计划日按开始日期锚定月度、每7日或每14日；使用计划日及之后区间内第一个数据日期的收盘值买入，不独立验证交易日历。',
        '买入净额=分配金额÷(1+佣金+滑点)；持有份额按(1-宽基年费率)^(间隔天数÷365.25)扣费；现金收益为0。',
        '时间加权净值逐日连接：买入前价值÷前日价值，再乘买入后价值÷(买入前价值+当日投入)；第一天以前置净值1计入买入成本。',
        'TWR年化=期末时间加权净值^(365.25÷首末数据日期间隔天数)-1；IRR使用实际现金流日期，求投入现值与终值现值之和为0。',
        'IRR沿用旧报告求解范围-95%至300%；区间内无解或现金流无时间跨度时显示缺失，不填0。',
        '基准与账户使用相同投入金额、执行日期、佣金、滑点和年费率；超额IRR为二者IRR之差。波动按244个数据日年化，Sharpe无风险利率为0。',
      ],
      limitation: '沪深300/中证1000全收益指数作为宽基代理；宽基/现金分档按固定比例投入，现金收益为0，不卖出或再平衡。行业轮动、宏观基差分档和自然语言交易规则尚未执行，需选择支持的结构化规则。' },
  };
}

function canRunPanelJsonBacktest(config, request) {
  return config.snapshotId === 'snapshot.etf_smartbeta.industry_panel.current'
    && (request.artifactCandidateId === 'artifact.factor.backtest.monthly_dca_engine' || request.artifactCandidateId === 'artifact.factor.study.decomposition')
    && (config.factorFamilyIds || []).some(id => id.startsWith('library.industry.'));
}

async function buildPanelJsonFactorResultArtifact({ request, config, artifactId }) {
  const [panel, app] = await Promise.all([
    readOldFactorJson('out/panel.json'),
    readOldFactorJson('out/app_data.json'),
  ]);
  const now = new Date().toISOString();
  const categoryWeights = normalizePanelCategoryWeights(config);
  const run = runPanelStrategy(panel, categoryWeights, config.strategySettings || {});
  const bench = runPanelBenchmark(panel);
  const excessAnnualized = run.metrics.annualizedReturn - bench.metrics.annualizedReturn;
  const diagnostics = panelFactorDiagnostics(panel, categoryWeights, run, bench, config.strategySettings || {});
  return {
    artifactId,
    module: 'factors',
    experimentId: config.configId,
    requestId: request.requestId,
    title: request.title || `${config.title} panel回测结果`,
    version: 'panel-json-engine-v1',
    createdAt: now,
    sourceIds: [],
    status: 'review_required',
    storageRef: `var/factors/result-artifacts.json#${artifactId}`,
    computePolicy: 'panel_json_monthly_cross_section_engine_v1_no_fetch_no_old_script',
    executionMode: 'native_workbench_panel_json_monthly_topn_v1',
    configSnapshot: resultConfigSnapshot(config),
    period: [panel.months[0], panel.months.at(-1)],
    metrics: {
      annualizedReturn: run.metrics.annualizedReturn,
      moneyWeightedIrr: run.metrics.annualizedReturn,
      benchmarkIrr: bench.metrics.annualizedReturn,
      excessIrr: excessAnnualized,
      maxDrawdown: run.metrics.maxDrawdown,
      volatility: run.metrics.volatility,
      sharpe: run.metrics.sharpe,
      turnover: run.metrics.turnover,
      finalValue: run.metrics.finalValue,
      benchmarkFinalValue: bench.metrics.finalValue,
      totalCost: run.metrics.totalCost,
      months: run.rows.length,
      hitRate: run.metrics.hitRate,
      informationCoefficient: run.metrics.informationCoefficient,
    },
    attribution: {
      betaReturn: bench.metrics.annualizedReturn,
      smartBetaReturn: diagnostics.smartBetaReturn,
      alphaReturn: diagnostics.alphaReturn,
      residualReturn: excessAnnualized - diagnostics.smartBetaReturn - diagnostics.alphaReturn,
      timeEffect: null,
      selectionEffect: excessAnnualized,
      buckets: diagnostics.buckets,
      factorDiagnostics: diagnostics.factorDiagnostics,
      explanation: '该结果由panel.json按配置实时重算：每月用已导出的因子z-score排序，选择TopN等权持有，扣除换手成本和行业ETF费率；归因按因子类别单独/留一重跑估计。',
    },
    series: {
      accountValue: sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row.nav), 120),
      benchmarkValue: sampleSeries(bench.rows.map(row => row.date), bench.rows.map(row => row.nav), 120),
      unitNav: sampleSeries(run.rows.map(row => row.date), run.rows.map(row => row.nav), 120),
      benchmarkNav: sampleSeries(bench.rows.map(row => row.date), bench.rows.map(row => row.nav), 120),
      contributed: sampleSeries(run.rows.map(row => row.date), run.rows.map(() => 1), 120),
      exportedStrategySeries: sampleSeries(app.dates, app.series.spec, 120),
    },
    holdings: run.rows.slice(-12).map(row => ({
      date: row.date,
      names: row.holdings.map(code => panel.ind_names[code] || code),
      grossReturn: row.grossReturn,
      turnover: row.turnover,
      netReturn: row.netReturn,
    })),
    sensitivity: panelSensitivityGrid(panel, categoryWeights, config.strategySettings || {}),
    warnings: [
      'review_required_before_research_use',
      'panel_json_export_used_not_raw_parquet',
      'monthly_panel_return_alignment_requires_audit',
      'survivorship_and_investability_need_engine_level_audit',
      'do_not_convert_to_trade_instruction',
    ],
    dataScope: {
      snapshotId: config.snapshotId,
      sourceProject: oldFactorRoot,
      sourceFiles: ['out/panel.json'],
      limitation: '该V1执行器读取旧项目导出的panel.json进行本地重算，已经按配置重新排序和生成曲线；下一步仍需直接读取parquet/宽表并做滞后、成分、费用和可投资性审计。',
    },
  };
}

async function buildExportedCurveFallbackResultArtifact({ request, config, artifactId }) {
  const [app, report, study, loo] = await Promise.all([
    readOldFactorJson('out/app_data.json'),
    readOldFactorJson('out/report.json'),
    readOldFactorJson('out/factor_study.json'),
    readOldFactorJson('out/factor_loo.json'),
  ]);
  const base = report.base;
  const now = new Date().toISOString();
  const selectedWeights = normalizeResultWeights(config.factorWeights, config.factorFamilyIds);
  const smartBeta = study.decomp.find(item => item.name.includes('Smart Beta'));
  const alpha = study.decomp.find(item => item.name.includes('Alpha'));
  const total = study.decomp[0];
  const residualReturn = (total?.excess ?? 0) - (smartBeta?.excess ?? 0) - (alpha?.excess ?? 0);
  const factorDiagnostics = loo.cats.map(item => ({
    factorKey: item.key,
    label: item.cat,
    kind: item.kind === 'sb' ? 'smart_beta' : 'alpha',
    configuredWeight: selectedWeights[item.key] ?? item.weight,
    sourceWeight: item.weight,
    soloIrr: item.solo_irr,
    soloExcess: item.solo_excess,
    marginalContribution: item.marginal,
    turnover: loo.turnover[item.key],
    position: item.marginal >= 0 && item.solo_excess >= 0 ? 'preferred' : item.marginal >= 0 ? 'diversifier' : 'watch',
  }));
  return {
    artifactId,
    module: 'factors',
    experimentId: config.configId,
    requestId: request.requestId,
    title: request.title || `${config.title} 结果资产`,
    version: 'local-executor-v0',
    createdAt: now,
    sourceIds: [],
    status: 'review_required',
    storageRef: `var/factors/result-artifacts.json#${artifactId}`,
    computePolicy: 'exported_curve_fallback_v0_reuses_old_results_no_fetch_no_old_script',
    executionMode: 'native_workbench_exported_curve_fallback_v0',
    configSnapshot: resultConfigSnapshot(config),
    period: base.period,
    metrics: {
      annualizedReturn: base.twr_strategy.cagr,
      moneyWeightedIrr: base.irr_strategy,
      benchmarkIrr: base.irr_bench,
      excessIrr: base.irr_strategy - base.irr_bench,
      maxDrawdown: base.twr_strategy.mdd,
      volatility: base.twr_strategy.vol,
      sharpe: base.twr_strategy.sharpe,
      turnover: averageTurnover(loo.turnover),
      finalValue: base.final_strategy,
      benchmarkFinalValue: base.final_bench_dca,
      totalCost: base.total_cost,
      months: base.n_months,
    },
    attribution: {
      betaReturn: base.irr_bench,
      smartBetaReturn: smartBeta?.excess ?? null,
      alphaReturn: alpha?.excess ?? null,
      residualReturn,
      timeEffect: deriveTimeEffect(report),
      selectionEffect: total?.excess ?? null,
      buckets: study.decomp.map(item => ({ name: item.name, tag: item.tag, irr: item.irr, excess: item.excess, weights: item.weights })),
      factorDiagnostics,
      explanation: '超额收益拆为基准Beta、Smart Beta暴露、Alpha配置和残差；时间因素使用旧报告闸门诊断估计，非时间因素以横截面选择和权重贡献为主。',
    },
    series: {
      accountValue: sampleSeries(base.curve.date, base.curve.strategy, 120),
      benchmarkValue: sampleSeries(base.curve.date, base.curve.bench_dca, 120),
      unitNav: sampleSeries(base.curve.date, base.curve.nav_strategy, 120),
      benchmarkNav: sampleSeries(base.curve.date, base.curve.nav_bench, 120),
      contributed: sampleSeries(base.curve.date, base.curve.contributed, 120),
      exportedStrategySeries: sampleSeries(app.dates, app.series.spec, 120),
    },
    sensitivity: app.sensitivity.map(item => ({ case: item.case, irr: item.irr, excess: item.excess, twr: item.twr, mdd: item.mdd, final: item.final })),
    warnings: [
      'review_required_before_research_use',
      'exported_curve_reuse_not_full_wide_table_recompute',
      'lookahead_and_survivorship_need_engine_level_audit',
      'do_not_convert_to_trade_instruction',
    ],
    dataScope: {
      snapshotId: config.snapshotId,
      sourceProject: oldFactorRoot,
      sourceFiles: ['out/app_data.json', 'out/report.json', 'out/factor_study.json', 'out/factor_loo.json'],
      limitation: '当前V0执行器复用旧导出数据来完成新工作台结果资产闭环；后续宽表级回测引擎接入后替换series和metrics计算源。',
    },
  };
}

function resultConfigSnapshot(config) {
  return {
    configId: config.configId,
    strategyTemplateId: config.strategyTemplateId,
    universe: config.universe,
    title: config.title,
    snapshotId: config.snapshotId,
    factorFamilyIds: config.factorFamilyIds,
    benchmarkId: config.benchmarkId,
    portfolioRule: config.portfolioRule,
    rebalanceCalendar: config.rebalanceCalendar,
    costModel: config.costModel,
    strategySettings: config.strategySettings || {},
    transactionSettings: config.transactionSettings || {},
  };
}

async function readFactorRunRequests() {
  try {
    const data = JSON.parse(await readFile(factorRunRequestFile, 'utf8'));
    return { schemaVersion: 1, module: 'factors', items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { schemaVersion: 1, module: 'factors', items: [] };
  }
}

async function writeFactorRunRequests(data) {
  await mkdir(path.dirname(factorRunRequestFile), { recursive: true });
  const payload = {
    schemaVersion: 1,
    module: 'factors',
    updatedAt: new Date().toISOString(),
    items: data.items,
  };
  await writeFile(factorRunRequestFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeRunRequest(input, { configs, existing } = {}) {
  const errors = [];
  const configId = clean(input.configId);
  const selectedConfig = configs?.find(item => item.configId === configId);
  const artifactCandidateId = clean(input.artifactCandidateId || (selectedConfig?.strategyTemplateId === 'strategy.legacy_510300_pe_dca' ? legacyDcaEngine.artifactCandidateId : selectedConfig?.strategyTemplateId === 'strategy.custom_industry_expression' ? customExpressionEngine.artifactCandidateId : selectedConfig?.strategyTemplateId === 'strategy.fund_nav_fixed_dca' ? fundNavEngine.artifactCandidateId : selectedConfig?.strategyTemplateId === 'strategy.legacy_three_bucket_monthly' ? threeBucketEngine.artifactCandidateId : selectedConfig?.strategyTemplateId === 'strategy.industry_parquet_monthly_topn' ? industryEngine.artifactCandidateId : selectedConfig?.strategyTemplateId === 'strategy.fund_cross_section_screen' ? fundScreenEngine.artifactCandidateId : 'artifact.factor.backtest.monthly_dca_engine'));
  const requestId = clean(input.requestId || makeRunRequestId(configId, existing));
  if (!validRunRequestId(requestId)) errors.push('requestId must look like run.factor_request');
  if (!selectedConfig) errors.push('configId must reference an existing experiment config');
  if (!factorArtifactCandidates.some(item => item.artifactCandidateId === artifactCandidateId) && ![legacyDcaEngine.artifactCandidateId, fundScreenEngine.artifactCandidateId, industryEngine.artifactCandidateId, threeBucketEngine.artifactCandidateId, fundNavEngine.artifactCandidateId, customExpressionEngine.artifactCandidateId].includes(artifactCandidateId)) errors.push('artifactCandidateId must reference a mapped factor artifact candidate');
  if (existing?.some(item => item.requestId === requestId)) errors.push('requestId already exists');
  if (errors.length) return { error: 'validation_failed', errors };
  return {
    item: {
      requestId,
      configId,
      title: clean(input.title) || `执行准备：${selectedConfig.title}`,
      artifactCandidateId,
      requestedMode: clean(input.requestedMode) || 'preflight_only',
      approvalState: 'not_requested',
      computePolicy: 'prepare_request_only_no_backtest',
      preflightChecklist: [
        'config_exists',
        selectedConfig.snapshotId ? 'snapshot_bound' : 'snapshot_missing',
        selectedConfig.benchmarkId ? 'benchmark_bound' : 'benchmark_missing',
        selectedConfig.factorFamilyIds?.length ? 'factors_bound' : ['strategy.monthly_dca_three_bucket', 'strategy.fund_nav_fixed_dca'].includes(selectedConfig.strategyTemplateId) ? 'factors_not_applicable_fixed_dca' : 'factors_missing',
        selectedConfig.costModel ? 'cost_model_bound' : 'cost_model_missing',
      ],
      notes: clean(input.notes),
    },
  };
}

function validRunRequestId(value) {
  return /^run\.[a-z0-9_.-]+$/.test(String(value || ''));
}

function makeRunRequestId(configId, existing = []) {
  const base = String(configId || 'factor_request').replace(/^config\./, '').replace(/[^a-z0-9_.-]+/g, '_') || 'factor_request';
  let candidate = `run.${base}`;
  let i = 2;
  while (existing.some(item => item.requestId === candidate)) {
    candidate = `run.${base}_${i}`;
    i += 1;
  }
  return candidate;
}

function makeResultArtifactId(requestId, existing = []) {
  const base = String(requestId || 'factor_result').replace(/^run\./, '').replace(/[^a-z0-9_.-]+/g, '_') || 'factor_result';
  let candidate = `result.${base}`;
  let i = 2;
  while (existing.some(item => item.artifactId === candidate)) {
    candidate = `result.${base}_${i}`;
    i += 1;
  }
  return candidate;
}

function validResultArtifactId(value) {
  return /^result\.[a-z0-9_.-]+$/.test(String(value || ''));
}

function normalizeResultWeights(factorWeights = [], factorFamilyIds = []) {
  const map = new Map([
    ['value', 'value'],
    ['momentum', 'mom'],
    ['growth_quality', 'prosper'],
    ['crowding', 'crowd'],
    ['low_volatility', 'low_volatility'],
    ['dividend', 'dividend'],
    ['size_liquidity', 'size'],
  ]);
  const rows = Array.isArray(factorWeights) && factorWeights.length
    ? factorWeights
    : factorFamilyIds.map(id => ({ factorFamilyId: id, weight: 1 / Math.max(1, factorFamilyIds.length) }));
  const output = {};
  for (const row of rows) {
    const id = String(row.factorFamilyId || '');
    const last = id.split('.').pop();
    const key = map.get(last) || last;
    output[key] = Number(row.weight || 0);
  }
  return output;
}

function normalizePanelCategoryWeights(config) {
  const familyToCategory = new Map([
    ['library.industry.value', 'value'],
    ['library.industry.momentum', 'mom'],
    ['library.industry.growth_quality', 'prosper'],
    ['library.industry.crowding_risk', 'crowd'],
    ['library.industry.low_volatility', 'risk'],
    ['library.industry.dividend', 'dividend'],
    ['library.industry.size_liquidity', 'liquidity'],
  ]);
  const rows = Array.isArray(config.factorWeights) && config.factorWeights.length
    ? config.factorWeights.map(row => ({ key: familyToCategory.get(row.factorFamilyId) || row.factorFamilyId?.split('.').pop(), weight: Number(row.weight || 0) }))
    : (config.factorFamilyIds || []).map(id => ({ key: familyToCategory.get(id) || id.split('.').pop(), weight: 1 }));
  const known = rows.filter(row => ['value', 'mom', 'prosper', 'crowd'].includes(row.key) && Number.isFinite(row.weight) && row.weight > 0);
  const total = known.reduce((sum, row) => sum + row.weight, 0) || known.length || 1;
  return Object.fromEntries(known.map(row => [row.key, row.weight / total]));
}

function runPanelStrategy(panel, categoryWeights, settings = {}) {
  const topN = Math.max(1, Math.min(10, Number(settings.topN || panel.cfg?.top_n || 3)));
  const fee = Number(panel.cfg?.fee_sector || 0) / 12;
  const tradeCost = Number(panel.cfg?.cost || 0);
  const minInv = Number(panel.cfg?.min_inv || 0);
  const rows = [];
  let nav = 1;
  let totalCost = 0;
  let previous = new Set();
  const monthlyReturns = [];
  const monthlyScores = [];
  for (let t = 0; t < panel.months.length; t += 1) {
    const scored = scorePanelMonth(panel, t, categoryWeights)
      .filter(row => panel.inv[t]?.[row.index] && Number.isFinite(Number(panel.ret[t]?.[row.index])));
    if (scored.length < minInv) continue;
    scored.sort((a, b) => b.score - a.score);
    const holdings = scored.slice(0, topN).map(row => row.code);
    const holdingIndexes = scored.slice(0, topN).map(row => row.index);
    const current = new Set(holdings);
    const overlap = holdings.filter(code => previous.has(code)).length;
    const turnover = previous.size ? 1 - overlap / Math.max(topN, previous.size) : 1;
    const cost = turnover * tradeCost + fee;
    const grossReturn = holdingIndexes.reduce((sum, index) => sum + Number(panel.ret[t][index]), 0) / holdingIndexes.length;
    const netReturn = grossReturn - cost;
    nav *= (1 + netReturn);
    totalCost += cost;
    rows.push({ date: panel.months[t], nav, grossReturn, netReturn, turnover, holdings, scoreCutoff: scored[topN - 1]?.score ?? null });
    monthlyReturns.push(netReturn);
    monthlyScores.push(scored.map(row => ({ score: row.score, ret: Number(panel.ret[t][row.index]) })));
    previous = current;
  }
  return {
    rows,
    metrics: metricsFromMonthlyRows(rows, monthlyReturns, totalCost, monthlyScores),
  };
}

function runPanelBenchmark(panel) {
  const rows = [];
  const monthlyReturns = [];
  let nav = 1;
  for (let t = 0; t < panel.months.length; t += 1) {
    const r1 = Number(panel.bench?.hs300?.[t]);
    const r2 = Number(panel.bench?.zz1000?.[t]);
    const value = Number.isFinite(r1) && Number.isFinite(r2) ? (r1 + r2) / 2 : Number.isFinite(r1) ? r1 : Number.isFinite(r2) ? r2 : null;
    if (value == null) continue;
    nav *= (1 + value);
    rows.push({ date: panel.months[t], nav, netReturn: value });
    monthlyReturns.push(value);
  }
  return { rows, metrics: metricsFromMonthlyRows(rows, monthlyReturns, 0, []) };
}

function scorePanelMonth(panel, monthIndex, categoryWeights) {
  const libByKey = new Map(panel.lib.map(item => [item.key, item]));
  const rows = [];
  for (let i = 0; i < panel.inds.length; i += 1) {
    let score = 0;
    let weightSum = 0;
    for (const [category, categoryWeight] of Object.entries(categoryWeights)) {
      const def = libByKey.get(category);
      if (!def) continue;
      let categoryScore = 0;
      let slotWeight = 0;
      for (const slot of def.items || []) {
        const raw = Number(panel.z[monthIndex]?.[slot.k]?.[i]);
        if (!Number.isFinite(raw)) continue;
        const w = Number(slot.w || 0);
        categoryScore += raw * Number(slot.sign || 1) * w;
        slotWeight += w;
      }
      if (!slotWeight) continue;
      score += (categoryScore / slotWeight) * categoryWeight;
      weightSum += categoryWeight;
    }
    if (!weightSum) continue;
    rows.push({ index: i, code: panel.inds[i], score: score / weightSum });
  }
  return rows;
}

function metricsFromMonthlyRows(rows, returns, totalCost, monthlyScores) {
  const n = returns.length;
  const finalValue = rows.at(-1)?.nav ?? 1;
  const annualizedReturn = n ? Math.pow(finalValue, 12 / n) - 1 : 0;
  const avg = n ? returns.reduce((sum, value) => sum + value, 0) / n : 0;
  const variance = n > 1 ? returns.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (n - 1) : 0;
  const volatility = Math.sqrt(variance) * Math.sqrt(12);
  const sharpe = volatility ? annualizedReturn / volatility : null;
  const hitRate = n ? returns.filter(value => value > 0).length / n : null;
  const turnoverValues = rows.map(row => Number(row.turnover)).filter(value => Number.isFinite(value));
  const turnover = turnoverValues.length ? turnoverValues.reduce((sum, value) => sum + value, 0) / turnoverValues.length : null;
  return {
    annualizedReturn,
    maxDrawdown: maxDrawdown(rows.map(row => row.nav)),
    volatility,
    sharpe,
    turnover,
    hitRate,
    informationCoefficient: averageInformationCoefficient(monthlyScores),
    finalValue,
    totalCost,
  };
}

function maxDrawdown(values) {
  let peak = values[0] || 1;
  let mdd = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak) mdd = Math.min(mdd, value / peak - 1);
  }
  return mdd;
}

function averageInformationCoefficient(monthlyScores) {
  const values = monthlyScores.map(rows => correlation(rows.map(row => row.score), rows.map(row => row.ret))).filter(value => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const xAvg = xs.reduce((sum, value) => sum + value, 0) / n;
  const yAvg = ys.reduce((sum, value) => sum + value, 0) / n;
  let num = 0;
  let xDen = 0;
  let yDen = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xAvg;
    const dy = ys[i] - yAvg;
    num += dx * dy;
    xDen += dx * dx;
    yDen += dy * dy;
  }
  return xDen && yDen ? num / Math.sqrt(xDen * yDen) : null;
}

function panelFactorDiagnostics(panel, categoryWeights, run, bench, settings) {
  const categoryLabels = { value: '价值', mom: '动量', prosper: '景气度', crowd: '拥挤度' };
  const fullExcess = run.metrics.annualizedReturn - bench.metrics.annualizedReturn;
  const factorDiagnostics = [];
  let smartBetaReturn = 0;
  let alphaReturn = 0;
  const buckets = [];
  for (const key of Object.keys(categoryWeights)) {
    const soloWeights = { [key]: 1 };
    const solo = runPanelStrategy(panel, soloWeights, settings);
    const withoutWeights = normalizeCategoryWeights(Object.fromEntries(Object.entries(categoryWeights).filter(([candidate]) => candidate !== key)));
    const without = Object.keys(withoutWeights).length ? runPanelStrategy(panel, withoutWeights, settings) : null;
    const soloExcess = solo.metrics.annualizedReturn - bench.metrics.annualizedReturn;
    const withoutExcess = without ? without.metrics.annualizedReturn - bench.metrics.annualizedReturn : 0;
    const marginal = fullExcess - withoutExcess;
    const kind = ['value', 'mom'].includes(key) ? 'smart_beta' : 'alpha';
    if (kind === 'smart_beta') smartBetaReturn += soloExcess * categoryWeights[key];
    else alphaReturn += soloExcess * categoryWeights[key];
    factorDiagnostics.push({
      factorKey: key,
      label: categoryLabels[key] || key,
      kind,
      configuredWeight: categoryWeights[key],
      sourceWeight: categoryWeights[key],
      soloIrr: solo.metrics.annualizedReturn,
      soloExcess,
      marginalContribution: marginal,
      turnover: solo.metrics.turnover,
      position: marginal >= 0 && soloExcess >= 0 ? 'preferred' : marginal >= 0 ? 'diversifier' : 'watch',
    });
    buckets.push({ name: categoryLabels[key] || key, tag: kind, irr: solo.metrics.annualizedReturn, excess: soloExcess, weights: { [key]: 1 } });
  }
  return { smartBetaReturn, alphaReturn, buckets, factorDiagnostics };
}

function normalizeCategoryWeights(weights) {
  const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  return Object.fromEntries(entries.map(([key, value]) => [key, Number(value) / total]));
}

function panelSensitivityGrid(panel, categoryWeights, settings) {
  const cases = [
    { case: '当前配置', weights: categoryWeights, topN: settings.topN },
    { case: 'Top5', weights: categoryWeights, topN: 5 },
    { case: '等权因子', weights: normalizeCategoryWeights(Object.fromEntries(Object.keys(categoryWeights).map(key => [key, 1]))), topN: settings.topN },
    { case: '仅Smart Beta', weights: normalizeCategoryWeights({ value: categoryWeights.value || 1, mom: categoryWeights.mom || 1 }), topN: settings.topN },
    { case: '仅Alpha', weights: normalizeCategoryWeights({ prosper: categoryWeights.prosper || 1, crowd: categoryWeights.crowd || 1 }), topN: settings.topN },
  ];
  const bench = runPanelBenchmark(panel);
  return cases.map(item => {
    const run = runPanelStrategy(panel, item.weights, { ...settings, topN: item.topN });
    return {
      case: item.case,
      irr: run.metrics.annualizedReturn,
      excess: run.metrics.annualizedReturn - bench.metrics.annualizedReturn,
      twr: run.metrics.annualizedReturn,
      mdd: run.metrics.maxDrawdown,
      final: run.metrics.finalValue,
    };
  });
}

function averageTurnover(turnover = {}) {
  const values = Object.values(turnover).map(Number).filter(value => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deriveTimeEffect(report) {
  const gate = report.gate_diag || {};
  for (const key of ['excess', 'irr_excess', 'gate_excess', 'timing_excess']) {
    if (Number.isFinite(Number(gate[key]))) return Number(gate[key]);
  }
  return null;
}

async function listOldFactorExportFiles() {
  const outDir = path.join(oldFactorRoot, 'out');
  try {
    const names = await readdir(outDir);
    const items = [];
    for (const name of names.sort()) {
      const full = path.join(outDir, name);
      const info = await stat(full);
      if (!info.isFile()) continue;
      items.push({
        exportId: `legacy.etf_smartbeta.out.${name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
        title: name,
        storageRef: full,
        artifactType: name.endsWith('.json') ? 'json_export' : name.endsWith('.parquet') ? 'parquet_export' : 'log_or_auxiliary',
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        migrationStatus: ['app_data.json', 'report.json', 'factor_study.json', 'factor_loo.json', 'lab_comps.json'].includes(name) ? 'used_by_native_factor_lab' : 'indexed_for_future_migration',
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function readFactorExperimentConfigs() {
  try {
    const data = JSON.parse(await readFile(factorExperimentConfigFile, 'utf8'));
    return { schemaVersion: 1, module: 'factors', items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { schemaVersion: 1, module: 'factors', items: [] };
  }
}

async function writeFactorExperimentConfigs(data) {
  await mkdir(path.dirname(factorExperimentConfigFile), { recursive: true });
  const payload = {
    schemaVersion: 1,
    module: 'factors',
    updatedAt: new Date().toISOString(),
    items: data.items,
  };
  await writeFile(factorExperimentConfigFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function experimentConfigTemplates() {
  return [
    { templateId:'template.custom_industry_expression', title:'自建公式行业月度TopN', strategyTemplateId:'strategy.custom_industry_expression',snapshotId:industryEngine.inputSnapshotIds[0],
      universe:'sw_industry_and_etf_proxy',factorFamilyIds:[],factorWeights:[],benchmarkId:'hs300_total_return',portfolioRule:'monthly_topn_custom_complete_case',rebalanceCalendar:'monthly',
      costModel:'commission=0.00025;slippage=0.0005;annual_fee=0.006',strategySettings:{startDate:'2025-01-02',endDate:'2026-07-30',topN:3,minInvestable:8,signalLagDays:1,weightingMethod:'equal_weight',missingValuePolicy:'complete_case'},
      constraints:['immutable_formula_copy','complete_case','lag_before_rebalance','no_user_code'] },
    { templateId: 'template.fund_nav_fixed_dca', title: '手动基金篮子历史定投', strategyTemplateId: 'strategy.fund_nav_fixed_dca', snapshotId: fundNavEngine.inputSnapshotIds[0],
      universe: 'manual_fund_share_basket', factorFamilyIds: [], factorWeights: [], benchmarkId: 'CSI300', portfolioRule: 'fixed_contribution_hold_adjusted_nav', rebalanceCalendar: 'monthly',
      costModel: 'subscription=0;slippage=0', strategySettings: { ...fundNavSettings }, constraints: ['selected_history_sha_binding', 'no_latest_factor_historical_selection', 'no_extra_management_fee'] },
    {
      templateId: 'template.legacy_three_bucket_monthly', title: 'A/B/C三档月度定投',
      strategyTemplateId: 'strategy.legacy_three_bucket_monthly', snapshotId: threeBucketEngine.inputSnapshotIds[0],
      factorFamilyIds: ['library.industry.growth_quality', 'library.industry.momentum', 'library.industry.value', 'library.industry.crowding_risk'],
      factorWeights: [['growth_quality', .4], ['momentum', .25], ['value', .2], ['crowding_risk', .15]].map(([name, weight]) => ({ factorFamilyId: `library.industry.${name}`, weight })),
      benchmarkId: 'hs300_total_return', universe: 'broad_index_or_industry_proxy', portfolioRule: 'monthly_three_bucket_lagged_signals', rebalanceCalendar: 'monthly',
      costModel: 'commission=0.00025; slippage=0.0005; annual_fee=0', strategySettings: { ...threeBucketSettings },
      constraints: ['eight_source_bundle_required', 'calendar_availability_model', 'index_and_bond_rate_proxies'],
    },
    {
      templateId: 'template.industry_parquet_monthly_topn', title: '原始行业Parquet月度TopN',
      strategyTemplateId: 'strategy.industry_parquet_monthly_topn', snapshotId: 'snapshot.etf_smartbeta.industry_execution.current',
      factorFamilyIds: ['library.industry.value'], factorWeights: [{ factorFamilyId: 'library.industry.value', weight: 1 }],
      benchmarkId: 'hs300_total_return', universe: 'sw_industry_and_etf_proxy', portfolioRule: 'monthly_topn_equal_weight_prior_signal', rebalanceCalendar: 'monthly',
      costModel: 'commission=0.00025; slippage=0.0005; annual_fee=0.006',
      strategySettings: { startDate: '2016-01-04', endDate: '2026-07-30', topN: 3, minInvestable: 8, signalLagDays: 1, weightingMethod: 'equal_weight', missingValuePolicy: 'neutral_with_coverage' },
      constraints: ['lag_before_rebalance', 'investable_date_required', 'no_implicit_fetch'],
    },
    {
      templateId: 'template.industry_monthly_topn',
      title: '行业月度 TopN 因子轮动',
      strategyTemplateId: 'strategy.factor_rotation_topn',
      snapshotId: 'snapshot.etf_smartbeta.industry_panel.current',
      factorFamilyIds: ['library.industry.value', 'library.industry.momentum', 'library.industry.growth_quality', 'library.industry.crowding_risk'],
      benchmarkId: 'factors.etf_smartbeta.bench',
      portfolioRule: 'monthly top_n equal_weight; unavailable industries excluded',
      rebalanceCalendar: 'month_first_trading_day',
      costModel: 'commission=0.00025; slippage=0.0005; annual_fee=0.006',
      constraints: ['same_snapshot_only', 'top_n_required', 'benchmark_required'],
    },
    {
      templateId: 'template.fund_cross_section_screen',
      title: '基金横截面筛选实验',
      strategyTemplateId: 'strategy.fund_cross_section_screen',
      snapshotId: 'snapshot.fund_warehouse.wide_today.current',
      factorFamilyIds: ['library.fund.absolute_performance', 'library.fund.benchmark_relative', 'library.fund.fees_cost', 'library.fund.manager_product_structure'],
      benchmarkId: 'fund_mapped_benchmark',
      portfolioRule: 'rank by selected factors; filter primary share; compare within strategy type',
      rebalanceCalendar: 'manual_monthly_refresh',
      costModel: 'no_backtest_cost_until_nav_series_bound',
      constraints: ['do_not_mix_daily_weekly_frequency', 'strategy_type_group_required', 'no_implicit_history_fetch'],
    },
  ];
}

function normalizeExperimentConfig(input, { existing, currentId } = {}) {
  const errors = [];
  const title = clean(input.title);
  const configId = clean(input.configId || makeConfigId(title));
  const snapshotId = clean(input.snapshotId);
  const benchmarkId = clean(input.benchmarkId);
  const portfolioRule = clean(input.portfolioRule);
  const rebalanceCalendar = clean(input.rebalanceCalendar);
  const costModel = clean(input.costModel);
  const factorFamilyIds = normalizeList(input.factorFamilyIds);
  if (!validConfigId(configId)) errors.push('configId must look like config.my_experiment');
  if (!title) errors.push('title is required');
  if (!snapshotId) errors.push('snapshotId is required');
  if (!factorFamilyIds.length && !['strategy.monthly_dca_three_bucket', 'strategy.fund_nav_fixed_dca', 'strategy.legacy_510300_pe_dca'].includes(input.strategyTemplateId)) errors.push('at least one factorFamilyId is required');
  if (!benchmarkId) errors.push('benchmarkId is required');
  if (!portfolioRule) errors.push('portfolioRule is required');
  if (!rebalanceCalendar) errors.push('rebalanceCalendar is required');
  if (!costModel) errors.push('costModel is required');
  if (existing?.some(item => item.configId === configId && item.configId !== currentId)) errors.push('configId already exists');
  if (errors.length) return { error: 'validation_failed', errors };
  return {
    item: {
      configId,
      module: 'factors',
      title,
      status: clean(input.status) || 'draft',
      strategyTemplateId: clean(input.strategyTemplateId),
      snapshotId,
      factorFamilyIds,
      benchmarkId,
      universe: clean(input.universe),
      portfolioRule,
      rebalanceCalendar,
      costModel,
      constraints: normalizeList(input.constraints),
      comparisonLimits: normalizeList(input.comparisonLimits),
      factorWeights: normalizeStructured(input.factorWeights, []),
      strategySettings: normalizeStructured(input.strategySettings, {}),
      transactionSettings: normalizeStructured(input.transactionSettings, {}),
      notes: clean(input.notes),
      runPolicy: 'save_config_only_no_backtest',
    },
  };
}

function normalizeStructured(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value;
  return fallback;
}

function validConfigId(value) {
  return /^config\.[a-z0-9_.-]+$/.test(String(value || ''));
}

function makeConfigId(title) {
  const base = String(title || 'experiment')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `config.${base || 'experiment'}`;
}

async function listFactorArtifacts() {
  return Promise.all(factorArtifactCandidates.map(async item => {
    try {
      const info = await stat(item.sourceScript);
      return { ...item, exists: true, bytes: info.size, updatedAt: info.mtime.toISOString() };
    } catch {
      return { ...item, exists: false, bytes: null, updatedAt: null };
    }
  }));
}

async function registrySnapshot(reply, json) {
  try {
    const body = await readFile(path.join(projectRoot, 'var/registry/latest.json'));
    return reply(200, body, { 'Content-Type': 'application/json; charset=utf-8' });
  } catch {
    return json(404, { error: 'snapshot_not_found', hint: 'run npm run registry:snapshot' });
  }
}

function researchSkills(json) {
  const grouped = new Map();
  for (const skill of seedSkills) {
    if (!grouped.has(skill.stage)) grouped.set(skill.stage, []);
    grouped.get(skill.stage).push(skill);
  }
  return json(200, { schemaVersion: 1, module: 'research', apiVersion: 'v1', mode: 'readonly_index', sourceRoot: oldResearchRoot, supportedNow: ['skill_registry', 'workflow_entry', 'artifact_query'], stages: [...grouped].map(([stage, items]) => ({ stage, items })) });
}

async function researchArtifacts(url, json) {
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)));
  const items = await listResearchArtifacts(limit);
  return json(200, { schemaVersion: 1, module: 'research', apiVersion: 'v1', mode: 'readonly_index', count: items.length, items });
}

async function listResearchArtifacts(limit = 50) {
  const dir = path.join(oldResearchRoot, 'reports');
  const names = await readdir(dir);
  const items = [];
  for (const name of names.filter(name => name.endsWith('.md'))) {
    const info = await stat(path.join(dir, name));
    items.push({ file: name, title: name.replace(/\.md$/, ''), bytes: info.size, updatedAt: info.mtime.toISOString() });
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, limit);
}

async function researchArtifact(url, method, reply, json) {
  const file = decodeURIComponent(url.pathname.split('/').pop());
  if (!file || file.includes('..') || /[\\/]/.test(file) || !file.endsWith('.md')) {
    return json(400, { error: 'invalid_artifact' });
  }
  try {
    const body = await readFile(path.join(oldResearchRoot, 'reports', file), 'utf8');
    return reply(200, body, { 'Content-Type': 'text/markdown; charset=utf-8' });
  } catch {
    return json(404, { error: 'artifact_not_found' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4311);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  // Authentication is not implemented: bind only to the local loopback interface.
  server.listen(port, '127.0.0.1', () => console.log(`投研工作台01 http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
