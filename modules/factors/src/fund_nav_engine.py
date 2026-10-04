"""Database-backed fund histories; manual baskets, never latest-factor historical selection."""

import json
import math
import re
import sys
import sqlite3

import numpy as np
import pandas as pd

from dca_engine import cashflow_attribution, schedule, xirr
import fund_history_store as store

VERSION = 'fund-nav-sqlite-fixed-dca-v1'
BENCHMARKS = store.BENCHMARKS
DEFAULTS = {'startDate': '2025-01-02', 'endDate': '2026-07-30', 'amount': 10000, 'frequency': 'monthly', 'calendarPolicy': 'common_observed_dates', 'maxGapDays': 14, 'benchmarkPolicy': 'same_flow_gross_index'}


def codes_checked(codes):
    if not isinstance(codes, list) or not 1 <= len(codes) <= 10 or any(not isinstance(c, str) or not re.fullmatch(r'[0-9]{6}', c) for c in codes) or len(set(codes)) != len(codes):
        raise ValueError('fund_nav_codes_required_unique_six_digits_max_10')
    return codes


def finite_number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid_fund_nav_numeric_setting')
    return float(value)


def series_checked(frame, column):
    if not {'date', column} <= set(frame) or len(frame) < 2:
        raise ValueError('fund_nav_fields_or_observations_missing')
    dates = pd.to_datetime(frame['date'], errors='raise')
    values = pd.to_numeric(frame[column], errors='raise').to_numpy(dtype=float)
    if dates.isna().any() or dates.duplicated().any() or not dates.eq(dates.dt.normalize()).all() or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError('fund_nav_invalid_dates_or_positive_values')
    return pd.Series(values, index=pd.DatetimeIndex(dates)).sort_index()


def one_value(frame, field, allowed):
    if field not in frame or frame[field].isna().any() or len(frame[field].unique()) != 1 or frame[field].iloc[0] not in allowed:
        raise ValueError('fund_nav_inconsistent_or_unsupported_' + field)
    return frame[field].iloc[0]


def load(database, codes, benchmark, expected_sha256=None):
    codes_checked(codes)
    if benchmark not in BENCHMARKS:
        raise ValueError('unsupported_fund_nav_benchmark')
    db = store.open_reader(database, expected_sha256)
    try:
        return load_transaction(db, codes, benchmark)
    finally:
        db.close()


def load_transaction(db, codes, benchmark):
    captured = db.execute("SELECT value FROM store_meta WHERE key='snapshot_selection'").fetchone()
    if captured:
        selection = json.loads(captured[0])
        if sorted(codes) != selection['codes'] or benchmark != selection['benchmarkId']:
            raise ValueError('fund_snapshot_selection_mismatch')
    versions = []
    versions.append(store.version(store.source(db, 'universe_master')))
    series, funds, methods = {}, [], []
    for code in codes:
        share = db.execute('SELECT name FROM shares WHERE code=?', (code,)).fetchone()
        if share is None:
            raise ValueError('fund_nav_share_not_unique_in_universe')
        source = store.source(db, 'nav.' + code); versions.append(store.version(source))
        frame = pd.DataFrame([dict(row) for row in db.execute('SELECT date,value AS adj_nav FROM history WHERE kind=? AND code=? ORDER BY date', ('nav', code))])
        for field, value in json.loads(source['metadata']).items():
            frame[field] = value
        method = one_value(frame, 'adj_method', ['self_calc', 'hfq'])
        source = one_value(frame, 'source', ['offex_unit', 'onex_hfq'])
        if (method, source) not in [('self_calc', 'offex_unit'), ('hfq', 'onex_hfq')]:
            raise ValueError('fund_nav_adjustment_source_mismatch')
        one_value(frame, 'freq', ['日频'])
        values = series_checked(frame, 'adj_nav')
        median = float(values.index.to_series().diff().dt.days.dropna().median())
        if median > 5:
            raise ValueError('fund_nav_non_daily_actual_frequency')
        methods.append(method); series[code] = values
        funds.append({'shareCode': code, 'shareName': share['name'], 'adjustmentMethod': method, 'source': source, 'frequency': 'daily', 'observations': len(values), 'startDate': values.index[0].date().isoformat(), 'endDate': values.index[-1].date().isoformat(), 'medianGapDays': median})
    if len(set(methods)) != 1:
        raise ValueError('fund_nav_mixed_adjustment_methods')
    source = store.source(db, 'benchmark.' + benchmark); versions.append(store.version(source))
    frame = pd.DataFrame([dict(row) for row in db.execute('SELECT date,value AS close FROM history WHERE kind=? AND code=? ORDER BY date', ('benchmark', benchmark))])
    for field, value in json.loads(source['metadata']).items():
        frame[field] = value
    kind = one_value(frame, 'kind', ['全收益', '价格'])
    source_code = one_value(frame, 'source_code', frame.source_code.dropna().unique().tolist()) if 'source_code' in frame else None
    if not source_code:
        raise ValueError('fund_nav_benchmark_source_code_required')
    series['benchmark'] = series_checked(frame, 'close')
    aligned = pd.concat(series, axis=1, join='inner').sort_index()
    if len(aligned) < 2:
        raise ValueError('fund_nav_no_common_history')
    return aligned, {'version': VERSION, 'storage': 'workbench_sqlite', 'schemaVersion': store.SCHEMA_VERSION, 'funds': funds, 'benchmark': {'id': benchmark, 'kind': kind, 'sourceCode': source_code, 'startDate': series['benchmark'].index[0].date().isoformat(), 'endDate': series['benchmark'].index[-1].date().isoformat()},
        'commonStartDate': aligned.index[0].date().isoformat(), 'commonEndDate': aligned.index[-1].date().isoformat(), 'commonObservations': len(aligned), 'sourceVersions': versions, 'adjustmentMethod': methods[0],
        'temporalEligibility': {'status': 'not_point_in_time_verified', 'observationDateField': 'date', 'availableAtField': None,
            'historicalFactorSelectionAllowed': False, 'reason': 'observation_date_and_freeze_time_are_not_historical_information_availability'}}, series


def profile(database, codes, benchmark, expected_sha256=None):
    return load(database, codes, benchmark, expected_sha256)[1]


def catalog(database, query, expected_sha256=None):
    if not isinstance(query, str) or len(query) > 128:
        raise ValueError('invalid_fund_nav_catalog_query')
    db = store.open_reader(database, expected_sha256)
    try:
        matched = db.execute("SELECT code,name,EXISTS(SELECT 1 FROM sources WHERE source_id='nav.'||shares.code) AS available FROM shares WHERE instr(code,?)>0 OR instr(name,?)>0 ORDER BY code LIMIT 51", (query, query)).fetchall() if query else []
        items = [{'shareCode': row['code'], 'shareName': row['name'], 'historyAvailable': bool(row['available'])} for row in matched[:50]]
        benchmarks = [row[0] for row in db.execute("SELECT code FROM sources WHERE kind='benchmark' ORDER BY code") if row[0] in BENCHMARKS]
        return {'items': items, 'hasMore': len(matched)>50, 'defaults': DEFAULTS, 'benchmarks': benchmarks,
                'database': store.status(db), 'policy': 'sqlite_metadata_search_history_profile_explicit'}
    finally:
        db.close()


def validate(config):
    if (config.get('strategyTemplateId') != 'strategy.fund_nav_fixed_dca' or config.get('universe') != 'manual_fund_share_basket' or
            not (config.get('snapshotId') == 'snapshot.fund_warehouse.nav_db.current' or re.fullmatch(r'snapshot\.frozen\.[a-f0-9]{64}', config.get('snapshotId', '')))):
        raise ValueError('unsupported_fund_nav_strategy_or_snapshot')
    if config.get('factorFamilyIds') or config.get('factorWeights') or config.get('transactionSettings') or config.get('portfolioRule') != 'fixed_contribution_hold_adjusted_nav':
        raise ValueError('fund_nav_historical_factor_selection_not_supported')
    s = config.get('strategySettings', {})
    if not isinstance(s, dict) or set(s) != set(DEFAULTS) | {'shares', 'sourceVersions'}:
        raise ValueError('fund_nav_complete_settings_required')
    if s['frequency'] not in ['monthly', 'weekly', 'biweekly'] or config.get('rebalanceCalendar') != s['frequency'] or s['calendarPolicy'] != DEFAULTS['calendarPolicy'] or s['benchmarkPolicy'] != DEFAULTS['benchmarkPolicy']:
        raise ValueError('unsupported_fund_nav_execution_policy')
    if not isinstance(s['shares'], list) or any(not isinstance(row, dict) or set(row) != {'shareCode', 'weight'} for row in s['shares']):
        raise ValueError('fund_nav_shares_required')
    codes_checked([row['shareCode'] for row in s['shares']])
    if any(finite_number(row['weight'], .000001, 1) <= 0 for row in s['shares']) or abs(sum(row['weight'] for row in s['shares']) - 1) > 1e-8:
        raise ValueError('fund_nav_weights_must_sum_one')
    weight_sum = math.fsum(row['weight'] for row in s['shares'])
    s = {**s, 'shares': [{**row, 'weight': row['weight']/weight_sum} for row in s['shares']]}
    finite_number(s['amount'], 1, 1e9)
    gap = finite_number(s['maxGapDays'], 1, 90)
    if int(gap) != gap:
        raise ValueError('fund_nav_gap_integer_required')
    start, end = [pd.Timestamp(s[key]) if isinstance(s[key], str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', s[key]) else None for key in ['startDate', 'endDate']]
    if start is None or end is None or pd.isna(start) or pd.isna(end) or end <= start:
        raise ValueError('invalid_fund_nav_period')
    rates = {}
    for entry in config.get('costModel', '').split(';'):
        parts = entry.strip().split('=')
        if len(parts) != 2 or parts[0] not in ['subscription', 'slippage'] or parts[0] in rates:
            raise ValueError('unsupported_fund_nav_cost_model_no_extra_annual_fee')
        rates[parts[0]] = finite_number(float(parts[1]), 0, .1)
    if set(rates) != {'subscription', 'slippage'}:
        raise ValueError('fund_nav_explicit_costs_required')
    if config.get('benchmarkId') not in BENCHMARKS:
        raise ValueError('unsupported_fund_nav_benchmark')
    return s, start, end, sum(rates.values())


def run(aligned, metadata, originals, config):
    s, start, end, cost = validate(config)
    if s['sourceVersions'] != metadata['sourceVersions']:
        raise ValueError('fund_nav_source_version_changed_reload_profile')
    if start < aligned.index[0] or end > aligned.index[-1]:
        raise ValueError('fund_nav_period_outside_common_coverage')
    data = aligned.loc[start:end]
    if len(data) < 3:
        raise ValueError('fund_nav_insufficient_common_observations')
    gaps = data.index.to_series().diff().dt.days.dropna()
    leading_gap, trailing_gap = (data.index[0]-start).days, (end-data.index[-1]).days
    max_gap = max(int(gaps.max()), leading_gap, trailing_gap)
    if max_gap > s['maxGapDays']:
        raise ValueError('fund_nav_common_calendar_gap_exceeds_limit')
    dates = data.index
    plans = schedule(start.date(), end.date(), s['frequency'])
    inflows, pending = {}, []
    for plan in plans:
        index = dates.searchsorted(pd.Timestamp(plan))
        if index == len(dates):
            pending.append({'scheduledDate': plan.isoformat(), 'amount': s['amount'], 'reason': 'no_common_quote_in_period'})
        else:
            if (dates[index] - pd.Timestamp(plan)).days > s['maxGapDays']:
                raise ValueError('fund_nav_execution_delay_exceeds_limit')
            inflows.setdefault(dates[index], []).append(plan.isoformat())
    units = {row['shareCode']: 0. for row in s['shares']}
    weights = {row['shareCode']: row['weight'] for row in s['shares']}
    benchmark_units, previous, previous_bench, nav, benchmark_nav, contributed, costs = 0., 0., 0., 1., 1., 0., 0.
    rows, flows, investor_flows = [], [], []
    previous_prices = None
    for date, values in data.iterrows():
        opening_prices = previous_prices if previous_prices is not None else values
        attribution_inputs = {'openingValue': previous, 'openingBenchmarkValue': previous_bench,
            'openingCash': 0., 'cashIncome': 0., 'assets': {'fund:'+code: {
                'openingValue': float(units[code]*opening_prices[code]),
                'grossPnl': float(units[code]*(values[code]-opening_prices[code]))} for code in units},
            'benchmarkReturn': float(values['benchmark']/opening_prices['benchmark']-1),
            'managementFee': 0., 'benchmarkManagementFee': 0., 'benchmarkTradingCost': 0.}
        before = sum(units[code]*values[code] for code in units)
        bench_before = benchmark_units * values['benchmark']
        deposit = len(inflows.get(date, [])) * s['amount']
        fee = deposit - deposit/(1+cost)
        if deposit:
            for code in units:
                units[code] += deposit * weights[code] / (1+cost) / values[code]
            benchmark_units += deposit / values['benchmark']
            contributed += deposit; costs += fee
            investor_flows.append((date.date(), -deposit))
            flows.append({'date': date.date().isoformat(), 'scheduledDates': inflows[date], 'amount': deposit, 'buyCost': fee, 'benchmarkBuyCost': 0., 'cashAllocation': 0., 'allocations': {code: deposit*w for code, w in weights.items()}})
        total = sum(units[code]*values[code] for code in units)
        bench_value = benchmark_units * values['benchmark']
        nav *= (before/previous if previous else 1) * (total/(before+deposit) if before+deposit else 1)
        benchmark_nav *= (bench_before/previous_bench if previous_bench else 1)
        attribution_inputs.update({'deposit': deposit, 'tradingCost': fee})
        rows.append({'date': date.date().isoformat(), 'accountValue': float(total), 'benchmarkValue': float(bench_value), 'unitNav': float(nav), 'benchmarkNav': float(benchmark_nav), 'contributed': contributed, 'cash': 0., 'fundValues': {code: float(units[code]*values[code]) for code in units}, 'attributionInputs': attribution_inputs})
        previous, previous_bench = total, bench_value
        previous_prices = values
    years = (dates[-1]-dates[0]).days/365.25
    navs = np.array([1.] + [row['unitNav'] for row in rows])
    returns = navs[2:]/navs[1:-1]-1
    annualization = (len(data)-1)/years
    volatility = float(returns.std(ddof=1)*np.sqrt(annualization))
    annual = float(navs[-1]**(1/years)-1)
    irr = xirr(investor_flows + [(dates[-1].date(), rows[-1]['accountValue'])])
    bench_irr = xirr(investor_flows + [(dates[-1].date(), rows[-1]['benchmarkValue'])])
    return {'version': VERSION, 'metrics': {'finalValue': rows[-1]['accountValue'], 'benchmarkFinalValue': rows[-1]['benchmarkValue'], 'annualizedReturn': annual, 'moneyWeightedIrr': irr, 'benchmarkIrr': bench_irr,
        'excessIrr': irr-bench_irr if irr is not None and bench_irr is not None else None, 'maxDrawdown': float(np.min(navs/np.maximum.accumulate(navs)-1)), 'volatility': volatility, 'sharpe': annual/volatility if volatility else None,
        'totalContributed': contributed, 'totalCost': costs, 'contributionCount': sum(len(x) for x in inflows.values()), 'observations': len(rows), 'pendingContributionCount': len(pending)},
        'rows': rows, 'cashFlows': flows, 'pendingContributions': pending, 'period': [rows[0]['date'], rows[-1]['date']], 'profile': metadata, 'attribution': cashflow_attribution(rows), 'allocationWeights': weights,
        'calendarAudit': {'policy': s['calendarPolicy'], 'maxObservedGapDays': max_gap, 'leadingGapDays': leading_gap, 'trailingGapDays': trailing_gap, 'requestedPeriod': [s['startDate'], s['endDate']], 'observationsPerYear': annualization, 'sourceDateCounts': {key: int(len(value.loc[start:end])) for key, value in originals.items()}, 'commonDateCount': len(data)},
        'warnings': ['manual_selected_survivorship_not_historical_factor_rotation', 'not_point_in_time_verified', 'fund_nav_embeds_running_fees_no_extra_management_fee', 'adjusted_nav_units_not_actual_trade_settlement', 'net_strategy_vs_gross_benchmark', 'alpha_attribution_not_computed'] + (['price_benchmark_not_total_return'] if metadata['benchmark']['kind'] == '价格' else []) + (['exchange_hfq_price_proxy_not_offexchange_nav'] if metadata['adjustmentMethod'] == 'hfq' else [])}


def execute(database, config, expected_sha256=None):
    validate(config)
    if config['snapshotId'].startswith('snapshot.frozen.') and expected_sha256 is None:
        raise ValueError('fund_snapshot_verified_content_required')
    codes = [row['shareCode'] for row in config['strategySettings']['shares']]
    # One read transaction pins all selected sources even while offline imports commit.
    db = store.open_reader(database, expected_sha256)
    try:
        aligned, metadata, originals = load_transaction(db, codes, config['benchmarkId'])
        return run(aligned, metadata, originals, config)
    finally:
        db.close()


if __name__ == '__main__':
    try:
        database, mode, payload = sys.argv[1:4]
        payload = json.loads(payload)
        expected = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        result = profile(database, payload['codes'], payload['benchmarkId'], expected) if mode == 'profile' else catalog(database, payload.get('query', ''), expected) if mode == 'catalog' else execute(database, payload, expected) if mode == 'execute' else {'error': 'unsupported_fund_nav_mode'}
    except (ValueError, KeyError, TypeError, OSError, OverflowError, sqlite3.Error) as error:
        result = {'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
