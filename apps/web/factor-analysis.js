const dateValid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function compareCurves(series, keys, baselineKey, startDate, endDate) {
  const requested = [...new Set(keys)];
  if (!requested.length || !baselineKey) return { status: 'empty_selection', items: [], series: {} };
  const included = [...new Set([...requested, baselineKey])], maps = new Map();
  let start = startDate || '0000-01-01', end = endDate || '9999-12-31';
  for (const key of included) {
    const rows = series[key];
    if (!Array.isArray(rows)) return { status: 'series_unavailable', items: [], series: {} };
    if (rows.some(p => !p || !dateValid(p.date))) return { status: 'invalid_series', items: [], series: {} };
    const valid = rows.filter(p => Number.isFinite(p.value) && p.value > 0).sort((a,b) => a.date.localeCompare(b.date));
    if (!valid.length || new Set(rows.map(p => p.date)).size !== rows.length) return { status: 'invalid_series', items: [], series: {} };
    start = [start, valid[0].date].sort().at(-1); end = [end, valid.at(-1).date].sort()[0];
    maps.set(key, new Map(rows.map(p => [p.date, p.value])));
  }
  const dates = [...maps.get(baselineKey).keys()].filter(d => dateValid(d) && d >= start && d <= end).sort();
  if (dates.length < 2 || start >= end) return { status: 'insufficient_common_period', items: [], series: {} };
  for (const key of included) {
    const rows = [...maps.get(key).keys()].filter(d => d >= start && d <= end).sort();
    if (JSON.stringify(rows) !== JSON.stringify(dates) || dates.some(d => !Number.isFinite(maps.get(key).get(d)) || maps.get(key).get(d) <= 0)) return { status: 'calendar_or_value_mismatch', items: [], series: {} };
  }
  const normalized = {}, metrics = new Map(), years = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / (86400000 * 365.25);
  for (const key of included) {
    const first = maps.get(key).get(dates[0]);
    normalized[key] = dates.map(date => ({ date, value: maps.get(key).get(date) / first }));
    let peak = 1, mdd = 0;
    for (const row of normalized[key]) { peak = Math.max(peak, row.value); mdd = Math.min(mdd, row.value / peak - 1); }
    const final = normalized[key].at(-1).value, annualizedReturn = Math.expm1(Math.log(final) / years);
    if (!Number.isFinite(annualizedReturn)) return { status: 'nonfinite_metrics', items: [], series: {} };
    metrics.set(key, { finalValue: final, annualizedReturn, maxDrawdown: mdd });
  }
  return { status: 'common_period_normalized_nav_only', period: [dates[0], dates.at(-1)], observationCount: dates.length,
    series: Object.fromEntries(requested.map(key => [key, normalized[key]])),
    items: requested.map(key => ({ key, ...metrics.get(key), excessAnnualizedReturn: metrics.get(key).annualizedReturn - metrics.get(baselineKey).annualizedReturn })),
    policy: 'same_dates_start_at_one_actual_calendar_years_no_irr_no_selection_recalculation' };
}

export function accountModeSeries(ledger, mode) {
  const output = { strategy: [], benchmark: [] }; let peakS = 1, peakB = 1;
  for (const row of ledger) {
    let strategy = null, benchmark = null;
    if (mode === 'profit') {
      if (Number.isFinite(row.contributed) && row.contributed > 0) {
        strategy = Number.isFinite(row.accountValue) ? row.accountValue / row.contributed - 1 : null;
      }
      const baselineContributed = row.benchmarkContributed ?? row.contributed;
      benchmark = Number.isFinite(row.benchmarkValue) && Number.isFinite(baselineContributed) && baselineContributed > 0 ? row.benchmarkValue / baselineContributed - 1 : null;
    } else if (mode === 'drawdown') {
      if (Number.isFinite(row.unitNav) && row.unitNav > 0) { peakS = Math.max(peakS, row.unitNav); strategy = row.unitNav / peakS - 1; }
      if (Number.isFinite(row.benchmarkNav) && row.benchmarkNav > 0) { peakB = Math.max(peakB, row.benchmarkNav); benchmark = row.benchmarkNav / peakB - 1; }
    } else throw new Error('unsupported_account_mode');
    output.strategy.push({date:row.date,value:strategy}); output.benchmark.push({date:row.date,value:benchmark});
  }
  return output;
}

export function effectiveCosts(config) {
  if (config?.strategyTemplateId !== 'strategy.legacy_three_bucket_monthly') return { costModel: config?.costModel };
  const settings = config.strategySettings;
  if (!settings || !['broadAnnualFee','sectorAnnualFee'].every(key => Number.isFinite(settings[key]) && settings[key] >= 0 && settings[key] <= .2)) return null;
  return { costModel: config.costModel, broadAnnualFee: settings.broadAnnualFee, sectorAnnualFee: settings.sectorAnnualFee };
}

export function resultComparisonKey(item) {
  const config = item.configSnapshot, scope = item.dataScope;
  if (!config || !scope || !item.accountLedger?.length || item.artifactType === 'fund_cross_section_screen') return null;
  const sources = scope.sourceVersions || (scope.sourceVersion ? [scope.sourceVersion] : []);
  if (!sources.length || sources.some(row => !/^[a-f0-9]{64}$/.test(row.sha256 || ''))) return null;
  const costs = effectiveCosts(config); if (!costs) return null;
  return JSON.stringify({ snapshotId: config.snapshotId, benchmarkId: config.benchmarkId, costs,
    rebalanceCalendar: config.rebalanceCalendar, universe: config.universe,
    transactionSettings: config.transactionSettings || null,
    cashFlows: (item.cashFlows || []).map(row => [row.date,row.amount]),
    sources: sources.map(row => [row.assetId || row.sourceId || '', row.sha256]).sort((a,b)=>a[0].localeCompare(b[0])) });
}

export function csvText(rows, columns) {
  const cell = value => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (typeof value !== 'number' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
