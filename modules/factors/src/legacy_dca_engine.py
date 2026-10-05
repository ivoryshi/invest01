"""Native replay of the archived 510300 page, without evaluating its scripts."""
import bisect
import datetime as dt
import hashlib
import json
import math
import re
import sys
from pathlib import Path

from legacy_html_literals import Scripts, code_mask
from dca_engine import xirr

VERSION = 'legacy-510300-pe-replay-v1'
DEFAULTS = {'amount': 10000, 'fee': .0001, 'slippage': .0005, 'nth': 1,
            'startMonth': '2012-06', 'endMonth': '2026-07', 'timingEnabled': True,
            'peKey': 'TTM', 'years': 5, 'mode': 'pool', 'cashRate': .02,
            'ladder': [{'hi': h, 'multiple': m} for h, m in [(10, 2), (20, 1.75), (40, 1.5), (60, 1), (80, .6), (90, .3), (100, 0)]]}


def load(raw):
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('legacy_dca_source_size_limit')
    parser = Scripts(); parser.feed(raw.decode('utf-8'))
    decoder = json.JSONDecoder(parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))
    literals = {}
    for script in parser.scripts:
        for match in re.finditer(r'\bconst\s+(BASE|PE)\s*=\s*(?=\{)', code_mask(script)):
            if match[1] in literals:
                raise ValueError('legacy_dca_duplicate_literal')
            value, end = decoder.raw_decode(script, match.end())
            if not script[end:].lstrip().startswith(';'):
                raise ValueError('legacy_dca_not_standalone_json')
            literals[match[1]] = value
    for name, fields in [('BASE', ['D', 'C', 'A', 'V']), ('PE', ['D', 'TTM', 'LYR', 'MED'])]:
        tape = literals.get(name)
        if not isinstance(tape, dict) or any(not isinstance(tape.get(key), list) for key in fields):
            raise ValueError('legacy_dca_tape_missing')
        n = len(tape['D'])
        if not 2 <= n <= 10000 or any(len(tape[key]) != n for key in fields):
            raise ValueError('legacy_dca_tape_shape')
        for date in tape['D']:
            if isinstance(date, bool) or not isinstance(date, int):
                raise ValueError('legacy_dca_invalid_date')
            as_date(date)
        if tape['D'] != sorted(set(tape['D'])):
            raise ValueError('legacy_dca_calendar_not_increasing')
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 for key in fields[1:] for v in tape[key]):
            raise ValueError('legacy_dca_invalid_price_or_pe')
    return literals['BASE'], literals['PE']


def as_date(number):
    if not re.fullmatch(r'\d{8}', str(number)):
        raise ValueError('legacy_dca_invalid_date')
    return dt.datetime.strptime(str(number), '%Y%m%d').date()


def bounded(value, lo, hi, message):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
        raise ValueError(message)
    return value


def validate(p):
    if not isinstance(p, dict) or set(p) != set(DEFAULTS):
        raise ValueError('legacy_dca_exact_parameters_required')
    for key, lo, hi in [('amount', 100, 1e8), ('fee', 0, .1), ('slippage', 0, .1), ('cashRate', 0, .2)]:
        bounded(p[key], lo, hi, 'legacy_dca_invalid_' + key)
    if isinstance(p['nth'], bool) or p['nth'] not in [1, 2, 3, 5, 10, 15, -1]:
        raise ValueError('legacy_dca_invalid_purchase_day')
    if isinstance(p['years'], bool) or not isinstance(p['years'], int) or not 1 <= p['years'] <= 20:
        raise ValueError('legacy_dca_invalid_lookback')
    if type(p['timingEnabled']) is not bool or p['peKey'] not in ['TTM', 'LYR', 'MED'] or p['mode'] not in ['pool', 'free']:
        raise ValueError('legacy_dca_invalid_timing_settings')
    for key in ['startMonth', 'endMonth']:
        if not isinstance(p[key], str) or not re.fullmatch(r'\d{4}-\d{2}', p[key]):
            raise ValueError('legacy_dca_invalid_month')
        dt.date.fromisoformat(p[key] + '-01')
    if p['startMonth'] > p['endMonth']:
        raise ValueError('legacy_dca_invalid_period')
    if not isinstance(p['ladder'], list) or not 1 <= len(p['ladder']) <= 12:
        raise ValueError('legacy_dca_invalid_ladder')
    previous = 0
    for bucket in p['ladder']:
        if not isinstance(bucket, dict) or set(bucket) != {'hi', 'multiple'}:
            raise ValueError('legacy_dca_invalid_ladder')
        bounded(bucket['hi'], 0, 100, 'legacy_dca_invalid_ladder')
        bounded(bucket['multiple'], 0, 10, 'legacy_dca_invalid_multiple')
        if bucket['hi'] <= previous:
            raise ValueError('legacy_dca_nonincreasing_ladder')
        previous = bucket['hi']
    if previous != 100:
        raise ValueError('legacy_dca_ladder_must_end_at_100')


def signal(pe, date, key, years):
    j = bisect.bisect_left(pe['D'], date) - 1
    if j < 0:
        return None
    cut = pe['D'][j] - years * 10000
    start = bisect.bisect_left(pe['D'], cut)
    values = pe[key][start:j+1]
    if len(values) < 120:
        return None
    current = pe[key][j]
    return {'signalDate': as_date(pe['D'][j]).isoformat(), 'pe': current,
            'percentile': sum(v <= current for v in values) / len(values), 'observations': len(values)}


def validate_config(config, expected_sha, selection):
    settings = config.get('strategySettings', {})
    if not isinstance(settings, dict) or set(settings) != {'archiveId', 'sourceSha256', 'parameters'}:
        raise ValueError('legacy_dca_bound_config_required')
    if settings['sourceSha256'] != expected_sha or selection != {k: settings[k] for k in ['archiveId', 'sourceSha256']}:
        raise ValueError('legacy_dca_frozen_source_binding_mismatch')
    p = settings['parameters']
    validate(p)
    cost = config.get('costModel', '')
    match = re.fullmatch(r'commission=([0-9.eE+-]+);slippage=([0-9.eE+-]+)', cost) if isinstance(cost, str) else None
    if not match or float(match[1]) != p['fee'] or float(match[2]) != p['slippage']:
        raise ValueError('legacy_dca_cost_binding_mismatch')
    if config.get('strategyTemplateId') != 'strategy.legacy_510300_pe_dca' or config.get('benchmarkId') != '510300_fixed_dca_vwap' \
            or config.get('universe') != 'archived_510300_adjusted_vwap' or config.get('rebalanceCalendar') != 'monthly' \
            or config.get('portfolioRule') != 'pe_ladder_monthly_dca' \
            or config.get('factorFamilyIds') or config.get('factorWeights') or config.get('transactionSettings'):
        raise ValueError('legacy_dca_unsupported_config_semantics')
    return p


def validate_period(base, p):
    months = sorted({str(date)[:6] for date in base['D']})
    if len(months) < 2 or p['startMonth'].replace('-', '') < months[1] or p['endMonth'].replace('-', '') > months[-1]:
        raise ValueError('legacy_dca_period_outside_full_month_start_coverage')


def replay(base, pe, p):
    validate(p)
    dates = base['D']; months = {}
    for i, date in enumerate(dates):
        months.setdefault(str(date)[:6], []).append(i)
    start, end = p['startMonth'].replace('-', ''), p['endMonth'].replace('-', '')
    if start < sorted(months)[1] or end > sorted(months)[-1]:
        raise ValueError('legacy_dca_period_outside_full_month_start_coverage')
    buys = {indices[-1] if p['nth'] == -1 else indices[min(p['nth']-1, len(indices)-1)] for month, indices in months.items() if start <= month <= end}
    if not buys:
        raise ValueError('legacy_dca_no_buy_month')
    first, last = min(buys), max(i for i, date in enumerate(dates) if str(date)[:6] <= end)
    units = baseline_units = cash = contributed = baseline_contributed = 0.
    nav = baseline_nav = 1.; fund_units = baseline_fund_units = 0.
    rows, trades, cashflows, baseline_flows = [], [], [], []
    lump_base = base['V'][first] * base['A'][first] / base['C'][first] * (1+p['slippage']) * (1+p['fee'])
    for i in range(first, last+1):
        date = as_date(dates[i]); sig = signal(pe, dates[i], p['peKey'], p['years']) if p['timingEnabled'] else None
        if cash > 0 and i > first:
            cash *= (1+p['cashRate']) ** ((date-as_date(dates[i-1])).days/365)
        deposit = baseline_deposit = spend = 0.; preflow_nav = baseline_preflow_nav = None
        if i in buys:
            multiplier = next((b['multiple'] for b in p['ladder'] if sig and sig['percentile']*100 < b['hi']), p['ladder'][-1]['multiple']) if sig else 1.
            budget = p['amount'] * multiplier
            deposit = p['amount'] if p['mode'] == 'pool' else budget
            # Unitize external flows at the un-slipped VWAP mark, before trading.
            # This separates old holdings' return from capital added intraday.
            flow_mark = base['V'][i] * base['A'][i] / base['C'][i]
            preflow_nav = (units*flow_mark+cash)/fund_units if fund_units else 1.
            baseline_preflow_nav = baseline_units*flow_mark/baseline_fund_units if baseline_fund_units else 1.
            if preflow_nav <= 0 or baseline_preflow_nav <= 0:
                raise ValueError('legacy_dca_invalid_preflow_nav')
            fund_units += deposit/preflow_nav
            baseline_fund_units += p['amount']/baseline_preflow_nav
            cash += deposit
            spend = min(budget, cash)
            exec_raw = base['V'][i] * (1+p['slippage'])
            exec_adj = exec_raw * base['A'][i] / base['C'][i]
            units += spend / (exec_adj * (1+p['fee'])); cash -= spend
            baseline_deposit = p['amount']; baseline_units += baseline_deposit / (exec_adj * (1+p['fee']))
            contributed += deposit; baseline_contributed += baseline_deposit
            if deposit: cashflows.append({'date':date.isoformat(),'amount':deposit})
            baseline_flows.append((date,-baseline_deposit))
            trades.append({'date':date.isoformat(),'vwap':base['V'][i],'executionPrice':exec_raw,
                           'signalDate':sig['signalDate'] if sig else None,'pe':sig['pe'] if sig else None,
                           'percentile':sig['percentile'] if sig else None,'multiple':multiplier,'deposit':deposit,'spend':spend,
                           'sharesBought':spend/(exec_raw*(1+p['fee'])), 'fee':spend*p['fee']/(1+p['fee']),
                           'slippageCost':spend*p['slippage']/((1+p['fee'])*(1+p['slippage'])),
                           'cash':cash,'status':'buy' if spend > 0 else 'pause'})
        value = units*base['A'][i]+cash; baseline = baseline_units*base['A'][i]
        nav = value/fund_units if fund_units else 1.
        baseline_nav = baseline/baseline_fund_units
        row = {'date':date.isoformat(),'accountValue':value,'benchmarkValue':baseline,'contributed':contributed,
               'benchmarkContributed':baseline_contributed,'unitNav':nav if contributed else None,'benchmarkNav':baseline_nav,
               'cash':cash,'holdingValue':units*base['A'][i],'rawClose':base['C'][i],'adjustedClose':base['A'][i],
               'accountUnits':fund_units,'benchmarkUnits':baseline_fund_units,'preFlowNav':preflow_nav,'benchmarkPreFlowNav':baseline_preflow_nav,
               'lumpBenchmarkNav':base['A'][i]/lump_base,'pePercentile':sig['percentile'] if sig else None,
               'signalDate':sig['signalDate'] if sig else None,'timingExcessNav':nav-baseline_nav if contributed else None}
        for window in [20, 60, 200]:
            row['ma'+str(window)] = math.fsum(base['A'][i-window+1:i+1])/window if i+1 >= window else None
        rows.append(row)
    flows = [(dt.date.fromisoformat(row['date']),-row['amount']) for row in cashflows]
    metrics = {'finalValue':rows[-1]['accountValue'],'benchmarkFinalValue':rows[-1]['benchmarkValue'],
               'totalContributed':contributed,'benchmarkContributed':baseline_contributed,
               'moneyWeightedIrr':xirr([*flows,(as_date(dates[last]),rows[-1]['accountValue'])]) if contributed else None,
               'benchmarkMoneyWeightedIrr':xirr([*baseline_flows,(as_date(dates[last]),rows[-1]['benchmarkValue'])]),
               'maxDrawdown':None,'unitNav':rows[-1]['unitNav']}
    peak=1.; drawdown=0.
    for row in rows:
        if row['unitNav'] is not None:
            peak=max(peak,row['unitNav']);drawdown=min(drawdown,row['unitNav']/peak-1)
    metrics['maxDrawdown'] = drawdown if contributed else None
    return {'version':VERSION,'parameters':p,'period':[rows[0]['date'],rows[-1]['date']], 'metrics':metrics,
            'accountLedger':rows,'cashFlows':cashflows,'benchmarkCashFlows':[{'date':date.isoformat(),'amount':-amount} for date,amount in baseline_flows],'trades':trades,
            'comparisonPolicy':'same_committed_cashflow_pool' if p['mode']=='pool' else 'different_cashflows_use_separate_xirr_no_wealth_ranking',
            'warnings':['archived_vwap_and_back_adjusted_units_not_real_execution','pe_observation_lag_not_point_in_time_verification',
                        'whole_month_tape_coverage_not_exchange_calendar_proof','xirr_reuses_existing_solver_bounds_minus_95pct_to_300pct',
                        'external_flows_unitized_at_un_slipped_adjusted_vwap_before_trade_not_previous_close_plus_deposit',
                        'free_mode_actual_multiplier_deposits_no_negative_cash_borrowing']}


if __name__ == '__main__':
    try:
        raw = Path(sys.argv[1]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != sys.argv[2]: raise ValueError('legacy_archive_integrity_failed')
        base, pe = load(raw)
        mode = sys.argv[3]
        if mode == 'options':
            result = {'version':VERSION,'defaults':DEFAULTS,'pricePeriod':[as_date(base['D'][0]).isoformat(),as_date(base['D'][-1]).isoformat()],
                      'priceObservations':len(base['D']),'peObservations':len(pe['D'])}
        elif mode == 'execute':
            config = json.loads(sys.argv[4])
            p = validate_config(config, sys.argv[2], json.loads(sys.argv[5]))
            result = replay(base, pe, p)
        elif mode == 'preview':
            result = replay(base, pe, json.loads(sys.argv[4]))
        else:
            raise ValueError('legacy_dca_unsupported_mode')
        if hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]: raise ValueError('legacy_archive_integrity_failed')
    except (ValueError, TypeError, KeyError, OSError, IndexError) as error:
        result = {'error':str(error)}
    print(json.dumps(result,ensure_ascii=False,allow_nan=False))
