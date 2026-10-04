import { createHash } from 'node:crypto';

export const workflowVersion = 'factor-backtest-workflow-v1';
const spec = (baseSnapshotId, python, modules, scope) => ({ baseSnapshotId, python, modules, scope });
export const backtestSpecs = {
  'strategy.fund_nav_fixed_dca': spec('snapshot.fund_warehouse.nav_db.current', 'fund_nav_engine', ['dca_engine', 'fund_history_store'], 'manual_fund_basket_simulation'),
  'strategy.industry_parquet_monthly_topn': spec('snapshot.etf_smartbeta.industry_execution.current', 'industry_engine', [], 'lagged_industry_proxy_simulation'),
  'strategy.custom_industry_expression': spec('snapshot.etf_smartbeta.industry_execution.current', 'custom_industry_engine', ['industry_engine', 'factor_expression'], 'custom_lagged_industry_proxy_simulation'),
  'strategy.legacy_three_bucket_monthly': spec('snapshot.etf_smartbeta.three_bucket_execution.current', 'three_bucket_engine', ['industry_engine', 'dca_engine'], 'three_bucket_availability_assumption_simulation'),
  'strategy.monthly_dca_three_bucket': spec('snapshot.etf_smartbeta.broad_panel.current', 'dca_engine', [], 'fixed_broad_index_proxy_simulation'),
};

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

export function workflowPolicy(config, researchMode = 'assumption_simulation') {
  const selected = backtestSpecs[config.strategyTemplateId];
  const blockers = [];
  if (!selected) blockers.push('strategy_not_supported_by_guarded_backtest');
  if (!/^snapshot\.frozen\.[a-f0-9]{64}$/.test(config.snapshotId || '')) blockers.push('frozen_snapshot_required');
  if (!['assumption_simulation', 'point_in_time_verified'].includes(researchMode)) blockers.push('invalid_research_mode');
  if (researchMode === 'point_in_time_verified') blockers.push('historical_information_availability_not_verified');
  return { researchMode, scope: selected?.scope || null, blockers,
    temporalEligibility: { status: 'not_point_in_time_verified', availableAtField: null, historicalFactorSelectionAllowed: false },
    requiredAcknowledgements: ['not_point_in_time_verified', 'proxy_or_adjusted_nav_not_real_execution'],
    limitations: ['冻结只保证输入版本与完整性，不证明历史可得时间或修订版本。',
      '这里只运行已有规则的假设性模拟；没有真实成交/申赎确认或因果Alpha证明。',
      '预检校验参数/冻结内容；数据日历、全部字段及计算有效性仍由真正执行器检查。'] };
}

export function acknowledgementsValid(actual, required) {
  return Array.isArray(actual) && actual.length === required.length && new Set(actual).size === actual.length && required.every(value => actual.includes(value));
}

export function workflowResultAudit(item, request) {
  const scope = item.dataScope || {}, frozen = scope.frozenSnapshot, receipt = scope.workflowReceipt;
  const checks = [];
  const check = (id, valid) => checks.push({ checkId: id, status: valid ? 'passed' : 'failed' });
  check('config_revision_bound', Number.isInteger(item.configSnapshot?.configRevision) && item.configSnapshot.configRevision > 0);
  check('frozen_input_bound', Boolean(frozen && frozen.snapshotId === item.configSnapshot?.snapshotId && frozen.verification === 'sha256_verified' && frozen.files?.length));
  check('source_fingerprints_present', Boolean(scope.sourceVersion?.sha256 || scope.sourceVersions?.length));
  check('calculation_fingerprint_present', Boolean(scope.calculationSources?.length || scope.calculationSourceSha256));
  check('workflow_receipt_bound', Boolean(receipt && receipt.version === workflowVersion && /^[a-f0-9]{64}$/.test(receipt.preflightSha256 || '')
    && receipt.configRevision === item.configSnapshot?.configRevision && receipt.snapshotId === frozen?.snapshotId
    && receipt.researchMode === 'assumption_simulation' && receipt.temporalEligibility?.status === 'not_point_in_time_verified'));
  check('request_result_link', Boolean(request && request.resultArtifactId === item.artifactId && item.requestId === request.requestId && item.experimentId === request.configId));
  check('finite_metrics_and_ledger', Boolean(item.metrics && Object.keys(item.metrics).length && Object.values(item.metrics).every(value => value === null || (typeof value === 'number' && Number.isFinite(value)))
    && item.accountLedger?.length && item.accountLedger.every(row => typeof row.date === 'string')));
  const reconciliation = item.attribution?.reconciliation;
  if (reconciliation) {
    const last = item.accountLedger?.at(-1);
    const bound = reconciliation.errorBound ?? (item.attribution.status === 'computed_industry_accounting_v1'
      ? 1e-9 * Math.max(1, Math.abs(reconciliation.actualTerminalExcess), last?.unitNav, last?.benchmarkNav) : NaN);
    check('stored_attribution_reconciliation', Number.isFinite(reconciliation.error) && Number.isFinite(bound) && bound >= 0 && Math.abs(reconciliation.error) <= bound);
  }
  return { artifactId: item.artifactId, status: checks.every(row => row.status === 'passed') ? 'review_required' : 'incomplete', checks,
    temporalEligibility: receipt?.temporalEligibility || { status: 'not_point_in_time_verified' }, warnings: item.warnings || [],
    verification: 'stored_result_structure_only_not_recalculation_or_pit',
    note: '通过结构审计仍须研究复核；没有重跑数据、核验供应商真实性、确认无前视或验证投资有效性。' };
}
