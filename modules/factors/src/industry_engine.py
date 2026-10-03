"""Read-only monthly industry executor. Legacy formulas are documented in README."""

import hashlib
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

VERSION = "industry-parquet-topn-v1"
# Slot weights/signs migrate factor_registry.py; low-vol/dividend/liquidity are explicit extensions.
FAMILIES = {
    "library.industry.value": [("bm", .45, 1), ("ep", .20, 1), ("pbpct", .25, 1), ("pepct", .10, 1)],
    "library.industry.momentum": [("mom12", .65, 1), ("mom6", .35, 1)],
    "library.industry.growth_quality": [("eg", .40, 1), ("egq", .25, 1), ("eacc", .20, 1), ("bps", .15, 1)],
    "library.industry.crowding_risk": [("turn", .35, -1), ("amt", .25, -1), ("expand", .25, -1), ("accel", .15, -1)],
    "library.industry.low_volatility": [("vol60", 1., -1)],
    "library.industry.dividend": [("dividend", 1., 1)],
    "library.industry.size_liquidity": [("amountShare", 1., 1)],
}
FORMULAS = {
    "bm": "1/PB where PB>0", "ep": "1/PE where PE>0",
    "pbpct": "1-rank(PB vs preceding observations in trailing 756 rows; min 189)",
    "pepct": "1-rank(PE vs preceding observations in trailing 756 rows; min 189)",
    "mom12": "close.shift(21)/close.shift(252)-1",
    "mom6": "close.shift(21)/close.shift(126)-1",
    "eg": "EPS/EPS.shift(244)-1; EPS=close/positive PE",
    "egq": "EPS/EPS.shift(61)-1", "eacc": "earn_growth-earn_growth.shift(61)",
    "bps": "BPS/BPS.shift(244)-1; BPS=close/positive PB",
    "turn": "rank(turnover in trailing 756 rows; min 189)",
    "amt": "rank(amount share in trailing 504 rows; min 126)",
    "expand": "PB/PB.shift(252)-1", "accel": "(close/close.shift(63)-1)-mom12*63/231",
    "vol60": "std(close.pct_change, trailing 60 rows, min 40, ddof=1)*sqrt(244)",
    "dividend": "positive dividend yield in percent points",
    "amountShare": "positive traded-amount share; liquidity proxy only, not market capitalization",
}


def rolling_pct(series, window):
    return series.rolling(window, min_periods=max(60, window // 4)).apply(
        lambda x: (x[:-1] < x[-1]).mean() if len(x) > 1 else np.nan, raw=True)


def features(panel):
    result = []
    for _, group in panel.groupby("ind", sort=True):
        g = group.sort_values("date").copy()
        c, pb, pe = g["close"], g["pb"].where(g["pb"] > 0), g["pe"].where(g["pe"] > 0)
        eps, bps = c / pe, c / pb
        g["bm"], g["ep"] = 1 / pb, 1 / pe
        g["pbpct"], g["pepct"] = 1 - rolling_pct(pb, 756), 1 - rolling_pct(pe, 756)
        g["mom12"], g["mom6"] = c.shift(21) / c.shift(252) - 1, c.shift(21) / c.shift(126) - 1
        g["eg"], g["egq"] = eps / eps.shift(244) - 1, eps / eps.shift(61) - 1
        g["eacc"], g["bps"] = g["eg"] - g["eg"].shift(61), bps / bps.shift(244) - 1
        g["turn"], g["amt"] = rolling_pct(g["turnover"], 756), rolling_pct(g["amt_share"], 504)
        g["expand"], g["accel"] = pb / pb.shift(252) - 1, (c / c.shift(63) - 1) - g["mom12"] * 63 / 231
        g["vol60"] = c.pct_change(fill_method=None).rolling(60, min_periods=40).std() * np.sqrt(244)
        g["dividend"], g["amountShare"] = g["div_yield"].where(g["div_yield"] > 0), g["amt_share"].where(g["amt_share"] > 0)
        # Dividend input precedes each earned daily return, never a future yield.
        dy = g["div_yield"].ffill().fillna(0).shift(1).fillna(0) / 100
        g["totalReturn"] = c.pct_change(fill_method=None) + dy / 244
        result.append(g)
    return pd.concat(result, ignore_index=True)


def number(value, error, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(error)
    if not low <= value <= high or (integer and int(value) != value):
        raise ValueError(error)
    return int(value) if integer else float(value)


def validate(config):
    s = config.get("strategySettings", {})
    if not isinstance(s, dict):
        raise ValueError("industry_settings_required")
    allowed = {"startDate", "endDate", "topN", "signalLagDays", "minInvestable", "weightingMethod", "missingValuePolicy"}
    if set(s) - allowed or config.get("transactionSettings"):
        raise ValueError("unsupported_industry_strategy_settings")
    if config.get("strategyTemplateId") != "strategy.industry_parquet_monthly_topn" or config.get("universe") != "sw_industry_and_etf_proxy":
        raise ValueError("unsupported_industry_strategy")
    if config.get("benchmarkId") != "hs300_total_return":
        raise ValueError("unsupported_industry_benchmark")
    if config.get("rebalanceCalendar") != "monthly" or config.get("portfolioRule") != "monthly_topn_equal_weight_prior_signal" or s.get("weightingMethod") != "equal_weight" or s.get("missingValuePolicy") != "neutral_with_coverage":
        raise ValueError("unsupported_industry_portfolio_rule")
    if any(not isinstance(s.get(key), str) or len(s[key]) != 10 for key in ("startDate", "endDate")):
        raise ValueError("invalid_industry_period")
    start, end = pd.Timestamp(s["startDate"]), pd.Timestamp(s["endDate"])
    if pd.isna(start) or pd.isna(end) or start != start.normalize() or end != end.normalize() or end <= start:
        raise ValueError("invalid_industry_period")
    top = number(s.get("topN"), "invalid_industry_top_n", 1, 20, True)
    lag = number(s.get("signalLagDays"), "invalid_industry_signal_lag", 1, 20, True)
    minimum = number(s.get("minInvestable"), "invalid_industry_min_investable", top, 31, True)
    families = config.get("factorFamilyIds", [])
    if not isinstance(families, list) or not families or len(set(families)) != len(families) or any(x not in FAMILIES for x in families):
        raise ValueError("unsupported_industry_factor_family")
    weights = config.get("factorWeights", [])
    if not isinstance(weights, list) or len(weights) != len(families) or any(not isinstance(x, dict) for x in weights):
        raise ValueError("industry_factor_weights_required")
    if len({x.get("factorFamilyId") for x in weights}) != len(families) or {x.get("factorFamilyId") for x in weights} != set(families):
        raise ValueError("industry_factor_weight_binding_mismatch")
    w = {x["factorFamilyId"]: number(x.get("weight"), "invalid_industry_factor_weight", 0.000001, 100) for x in weights}
    w = {key: value / sum(w.values()) for key, value in w.items()}
    rates = {"commission": 0., "slippage": 0., "annual_fee": 0.}
    seen = set()
    for part in str(config.get("costModel", "")).split(";"):
        if not part.strip():
            continue
        pair = part.strip().split("=")
        if len(pair) != 2 or pair[0].strip() not in rates or pair[0].strip() in seen:
            raise ValueError("unsupported_industry_cost_model")
        key = pair[0].strip()
        rates[key] = number(float(pair[1]), "invalid_industry_cost_rate", 0, .1)
        seen.add(key)
    if rates["commission"] + rates["slippage"] > .1:
        raise ValueError("invalid_industry_cost_rate")
    return {"start": start, "end": end, "top": top, "lag": lag, "minimum": minimum, "weights": w, "rates": rates}


def score(day, weights):
    day = day.set_index("ind").sort_index()
    totals = pd.Series(0., index=day.index)
    coverage = pd.Series(0., index=day.index)
    details, field_coverage = {}, {}
    for family, family_weight in weights.items():
        for field, slot_weight, sign in FAMILIES[family]:
            raw = day[field].replace([np.inf, -np.inf], np.nan)
            count = int(raw.notna().sum())
            field_coverage[field] = count
            sd = raw.std(ddof=0)
            z = ((raw - raw.mean()) / sd).clip(-3, 3) if count >= 3 and sd > 0 else pd.Series(0. if count >= 3 else np.nan, index=day.index).where(raw.notna())
            contribution = z.fillna(0) * slot_weight * sign * family_weight
            totals += contribution
            coverage += z.notna().astype(float) * slot_weight * family_weight
            for code in day.index:
                details.setdefault(code, []).append({"familyId": family, "field": field, "rawValue": float(raw[code]) if pd.notna(raw[code]) else None,
                    "zScore": float(z[code]) if pd.notna(z[code]) else None, "sign": sign, "slotWeight": slot_weight, "familyWeight": family_weight, "contribution": float(contribution[code])})
    rows = [{"code": code, "name": str(day.loc[code, "ind_name"]), "score": float(totals[code]), "coverage": float(coverage[code]), "factorDetails": details[code]} for code in day.index if coverage[code] > 0]
    rows.sort(key=lambda x: (-x["score"], x["code"]))
    return rows, field_coverage


def prepare(panel, bench, investable):
    panel, bench, investable = panel.copy(), bench.copy(), investable.copy()
    required = {"date", "ind", "ind_name", "close", "pe", "pb", "turnover", "amt_share", "div_yield"}
    if not required <= set(panel) or not {"date", "hs300_tr"} <= set(bench) or not {"ind_name", "first_investable"} <= set(investable):
        raise ValueError("missing_industry_source_fields")
    for f in (panel, bench):
        f["date"] = pd.to_datetime(f["date"], errors="raise")
        if f["date"].isna().any() or not f["date"].eq(f["date"].dt.normalize()).all():
            raise ValueError("invalid_industry_dates")
    if panel["ind"].isna().any() or panel["ind_name"].isna().any() or investable["ind_name"].isna().any():
        raise ValueError("invalid_industry_identifiers")
    panel["ind"] = panel["ind"].astype(str)
    if panel.duplicated(["date", "ind"]).any() or bench["date"].duplicated().any() or investable["ind_name"].duplicated().any():
        raise ValueError("duplicate_industry_source_keys")
    if (panel.groupby("ind")["ind_name"].nunique() > 1).any() or (panel.groupby("ind_name")["ind"].nunique() > 1).any():
        raise ValueError("ambiguous_industry_name_mapping")
    for col in required - {"date", "ind", "ind_name"}:
        panel[col] = pd.to_numeric(panel[col], errors="raise")
    if panel.empty or bench.empty or not np.isfinite(panel["close"]).all() or (panel["close"] <= 0).any():
        raise ValueError("invalid_industry_price_data")
    if (panel["div_yield"].dropna() < 0).any():
        raise ValueError("invalid_industry_dividend_yield")
    for col in required - {"date", "ind", "ind_name", "close"}:
        panel[col] = panel[col].replace([np.inf, -np.inf], np.nan)
    investable["first_investable"] = pd.to_datetime(investable["first_investable"], errors="raise")
    return features(panel), bench.sort_values("date").set_index("date"), investable.set_index("ind_name")["first_investable"].to_dict()


def performance_attribution(rows):
    """Ex-post terminal-wealth attribution, not a trading signal or causal alpha."""
    if not rows:
        raise ValueError('industry_attribution_empty_ledger')
    keys = ['cashExposure', 'industrySelection', 'managementFee', 'tradingCost']
    daily, monthly = [], {}
    previous_nav, previous_benchmark = 1., 1.
    terminal_benchmark = rows[-1]['benchmarkNav']
    for row in rows:
        nav, benchmark = row['unitNav'], row['benchmarkNav']
        exposure = row['openingExposure']
        if not all(math.isfinite(v) for v in [nav,benchmark,exposure,row['grossReturn'],row['netReturn'],row['managementFee'],row['tradingCost']]) or min(nav,benchmark) <= 0 or not -1e-10 <= exposure <= 1+1e-10:
            raise ValueError('invalid_industry_attribution_ledger')
        rb = benchmark/previous_benchmark-1; rs = nav/previous_nav-1
        if not math.isclose(rs,row['netReturn'],rel_tol=1e-9,abs_tol=1e-10):
            raise ValueError('industry_attribution_return_mismatch')
        parts = {'cashExposure':(exposure-1)*rb, 'industrySelection':row['grossReturn']-exposure*rb,
                 'managementFee':-row['managementFee']/previous_nav, 'tradingCost':-row['tradingCost']/previous_nav}
        if not math.isclose(math.fsum(parts.values()),rs-rb,rel_tol=1e-9,abs_tol=1e-10):
            raise ValueError('industry_attribution_daily_not_closed')
        # This terminal linking uses future benchmark growth only after the backtest.
        link = previous_nav*terminal_benchmark/benchmark
        linked = {key:parts[key]*link for key in keys}
        day = {'date':row['date'],'strategyReturn':rs,'benchmarkReturn':rb,'openingExposure':exposure,
               'linkWeight':link,'arithmeticExcess':rs-rb,'components':parts,'linkedComponents':linked}
        daily.append(day); monthly.setdefault(row['date'][:7],[]).append(day)
        previous_nav, previous_benchmark = nav, benchmark
    totals = {key:math.fsum(day['linkedComponents'][key] for day in daily) for key in keys}
    actual = rows[-1]['unitNav']-terminal_benchmark
    error = math.fsum(totals.values())-actual
    if not math.isclose(error,0,abs_tol=1e-9*max(1,abs(actual),rows[-1]['unitNav'],terminal_benchmark)):
        raise ValueError('industry_attribution_terminal_not_closed')
    x = np.array([day['benchmarkReturn'] for day in daily]); y = np.array([day['strategyReturn'] for day in daily])
    dx = x-x.mean(); scale = float(np.max(np.abs(dx)))
    regression = {'status':'insufficient_observations_or_constant_benchmark','observations':len(daily),
                  'benchmarkBeta':None,'interceptPerObservation':None,'rSquared':None,'buckets':[],
                  'interpretation':'sample_single_benchmark_ols_rf_zero_not_causal_alpha_not_smart_beta'}
    if len(daily) >= 3 and scale > 1e-14:
        centered = dx/scale
        beta = float(np.dot(centered,y-y.mean())/np.dot(centered,centered)/scale)
        intercept = float(y.mean()-beta*x.mean())
        residual = y-intercept-beta*x
        regression_parts = {'marketBetaRelative':(beta-1)*x,'sampleIntercept':np.full(len(x),intercept),'regressionResidual':residual}
        fitted_total = {key:math.fsum(float(value)*day['linkWeight'] for value,day in zip(values,daily)) for key,values in regression_parts.items()}
        ss = float(np.dot(y-y.mean(),y-y.mean()))
        regression.update({'status':'computed_sample_diagnostic','benchmarkBeta':beta,'interceptPerObservation':intercept,
                           'rSquared':float(1-np.dot(residual,residual)/ss) if ss>0 else None,
                           'buckets':[{'key':key,'value':value} for key,value in fitted_total.items()],
                           'reconciliationError':math.fsum(fitted_total.values())-actual})
        for i,day in enumerate(daily): day['regressionComponents'] = {key:float(values[i]) for key,values in regression_parts.items()}
    return {'status':'computed_industry_accounting_v1','version':'industry-terminal-link-v1',
            'unit':'terminal_return_difference_initial_capital_1_not_annualized',
            'buckets':[{'key':key,'value':totals[key]} for key in keys],
            'monthly':[{'month':month,**{key:math.fsum(d['linkedComponents'][key] for d in group) for key in keys},
                        'total':math.fsum(math.fsum(d['linkedComponents'].values()) for d in group)} for month,group in monthly.items()],
            'daily':daily,'reconciliation':{'actualTerminalExcess':actual,'componentsTotal':math.fsum(totals.values()),'error':error},
            'regression':regression,'smartBetaReturn':None,'alphaReturn':None,'residualReturn':None,
            'factorDiagnostics':[],
            'calculationLogic':['rb_t=B_t/B_(t-1)-1; rs_t=S_t/S_(t-1)-1; initial S=B=1',
                'cashExposure=(openingExposure-1)*rb; industrySelection=grossReturn-openingExposure*rb',
                'managementFee=-dailyFee/S_(t-1); tradingCost=-dailyTradingCost/S_(t-1)',
                'linkedContribution=component*S_(t-1)*B_T/B_t; sum=S_T-B_T',
                'OLS rs=intercept+beta*rb+residual; relative market term=(beta-1)*rb; rf=0'],
            'explanation':'单位资本终值超额的事后账本拆解，不是年化超额或IRR归因。现金暴露为持仓比例的市场机会成本，不是因果择时；行业选择是行业指数相对基准的代理，不证明因子Alpha。OLS含初次买入成本日，截距为样本每观测值，未年化、未进行显著性或样本外检验；无风险利率假设0。未提供多因子收益序列，Smart Beta不可识别。月度项使用全期链接权重，只能相加到全期终值差，不是该月收益率。'}


def simulation_context(data, bench, p):
    days = pd.DatetimeIndex(sorted(data["date"].unique()))
    if p["start"] < days[0] or p["end"] > days[-1]:
        raise ValueError("industry_period_outside_data_coverage")
    dates = days[(days >= p["start"]) & (days <= p["end"])]
    if len(dates) < 2:
        raise ValueError("insufficient_industry_observations")
    bp = bench.reindex(dates)["hs300_tr"].to_numpy(dtype=float)
    if not np.isfinite(bp).all() or (bp <= 0).any():
        raise ValueError("industry_benchmark_calendar_gap")
    by_day = {date: day.set_index("ind", drop=False) for date, day in data.groupby("date", sort=True)}
    monthly = set(pd.Series(dates).groupby([dates.year, dates.month]).min())
    return {'days':days,'dates':dates,'bp':bp,'by_day':by_day,'monthly':monthly,'scoreCache':{}}


def simulate(data, bench, inv, parameters, score_fn=score, context=None, audit=True):
    p = parameters
    context = context if context is not None else simulation_context(data,bench,p)
    days, dates, bp, by_day, monthly = (context[k] for k in ['days','dates','bp','by_day','monthly'])
    holdings, cash, cost, fee_total = {}, 1., 0., 0.
    rows, decisions = [], []
    previous_date = dates[0]
    for index, date in enumerate(dates):
        current = by_day[date]
        before = cash + sum(holdings.values())
        opening_exposure, fee_before = sum(holdings.values())/before, fee_total
        market_value = cash
        for code, value in list(holdings.items()):
            if code not in current.index:
                raise ValueError("industry_held_quote_missing")
            # Reject stale per-industry returns spanning an absent panel observation.
            code_dates = current.loc[code, "previousDate"]
            if code_dates != previous_date:
                raise ValueError("industry_held_quote_gap")
            r = current.loc[code, "totalReturn"]
            if not np.isfinite(r) or r <= -1:
                raise ValueError("invalid_industry_held_return")
            gross = value * (1 + r)
            market_value += gross
            fee = gross * (1 - (1 - p["rates"]["annual_fee"]) ** ((date - previous_date).days / 365.25))
            holdings[code] = gross - fee
            fee_total += fee
        after_market = cash + sum(holdings.values())
        turnover, trading_cost = 0., 0.
        if date in monthly:
            day_index = int(days.get_loc(date)) - p["lag"]
            signal_date = days[day_index] if day_index >= 0 else None
            key = (score_fn, signal_date, tuple(sorted(p['weights'].items())))
            if key not in context['scoreCache']:
                context['scoreCache'][key] = score_fn(by_day[signal_date].reset_index(drop=True), p['weights']) if signal_date is not None else ([], {})
            ranked, field_coverage = context['scoreCache'][key]
            eligible = [r for r in ranked if r["code"] in current.index and pd.notna(inv.get(r["name"])) and inv[r["name"]] <= date]
            selected = eligible[:p["top"]] if len(eligible) >= p["minimum"] else []
            target = {r["code"]: 1 / len(selected) for r in selected}
            current_weights = {code: value / after_market for code, value in holdings.items()}
            turnover = math.fsum(abs(target.get(code, 0) - current_weights.get(code, 0)) for code in sorted(set(target) | set(current_weights)))
            trading_cost = after_market * turnover * (p["rates"]["commission"] + p["rates"]["slippage"])
            net = after_market - trading_cost
            holdings, cash = {code: net * weight for code, weight in target.items()}, net if not target else 0.
            cost += trading_cost
            decisions.append({"date": date.date().isoformat(), "signalDate": signal_date.date().isoformat() if signal_date is not None else None,
                "eligibleCount": len(eligible), "names": [r["name"] for r in selected], "codes": [r["code"] for r in selected],
                "turnover": turnover, "tradingCost": trading_cost, "fieldCoverage": field_coverage,
                "reason": "top_n_equal_weight" if selected else "insufficient_scored_investable_cash", "scores": eligible if audit else []})
        nav = cash + sum(holdings.values())
        rows.append({"date": date.date().isoformat(), "unitNav": nav, "accountValue": nav, "benchmarkNav": float(bp[index] / bp[0]),
            "benchmarkValue": float(bp[index] / bp[0]), "contributed": 1., "cash": cash, "grossReturn": market_value / before - 1,
            "netReturn": nav / before - 1, "turnover": turnover, "tradingCost": trading_cost,
            "openingExposure": opening_exposure, "managementFee": fee_total-fee_before})
        previous_date = date
    years = (dates[-1] - dates[0]).days / 365.25
    navs = np.array([1.] + [r["unitNav"] for r in rows])
    returns = np.array([r["netReturn"] for r in rows])
    vol = float(returns.std(ddof=1) * np.sqrt(244))
    annual = float(navs[-1] ** (1 / years) - 1)
    benchmark_annual = float((bp[-1] / bp[0]) ** (1 / years) - 1)
    metrics = {"annualizedReturn": annual, "benchmarkAnnualizedReturn": benchmark_annual, "excessAnnualizedReturn": annual - benchmark_annual,
        "moneyWeightedIrr": None, "benchmarkIrr": None, "excessIrr": None,
        "maxDrawdown": float(np.min(navs / np.maximum.accumulate(navs) - 1)), "volatility": vol, "sharpe": annual / vol if vol else None,
        "finalValue": float(navs[-1]), "benchmarkFinalValue": float(bp[-1] / bp[0]), "totalCost": cost + fee_total,
        "tradingCost": cost, "managementFee": fee_total, "turnover": float(np.mean([r["turnover"] for r in decisions])) if decisions else 0,
        "observations": len(rows), "months": len(decisions), "cashMonths": sum(not r["codes"] for r in decisions)}
    for d in decisions:
        ledger = next(r for r in rows if r["date"] == d["date"])
        d.update({key: ledger[key] for key in ("grossReturn", "netReturn")})
    return {"rows": rows, "decisions": decisions, "metrics": metrics, "period": [rows[0]["date"], rows[-1]["date"]], "attribution": performance_attribution(rows) if audit else None}


def sensitivity_runs(data, benchmark, inv, p, baseline, score_fn=score, context=None):
    cases = [('zero_cost', {'rates': {key: 0. for key in p['rates']}}),
             ('double_trade_cost', {'rates': {**p['rates'], 'commission': p['rates']['commission']*2, 'slippage': p['rates']['slippage']*2}})]
    if p['top'] > 1: cases.append(('top_n_minus_one', {'top': p['top']-1}))
    if p['top'] < min(20, p['minimum']): cases.append(('top_n_plus_one', {'top': p['top']+1}))
    if p['lag'] < 20: cases.append(('signal_lag_plus_one', {'lag': p['lag']+1}))
    results = []
    for title, change in cases:
        try:
            variant = simulate(data, benchmark, inv, {**p, **change}, score_fn, context=context, audit=False)
            results.append({'case': title, 'status': 'recomputed_same_captured_inputs', 'parameterChanges': change,
                            **variant['metrics'], 'finalValueDelta': variant['metrics']['finalValue']-baseline['metrics']['finalValue']})
        except ValueError as error:
            results.append({'case':title,'status':'unavailable','parameterChanges':change,'error':str(error)})
    return results


def proxy_risk_model(rows, proxies):
    """Ex-post endogenous proxy regression, not a causal alpha or trading signal."""
    result = {'version': 'proxy-multifactor-v1', 'status': 'not_identifiable', 'observations': len(rows), 'basis': list(proxies),
              'policy': 'in_sample_endogenous_strategy_proxies_rf_zero', 'alphaReturn': None, 'smartBetaReturn': None,
              'warning': '代理由同一行业数据及策略规则生成，含内生性；仅样本内诊断，不证明独立因子溢价、因果Alpha或样本外有效性。'}
    days = performance_attribution(rows)['daily']
    for values in proxies.values():
        if [r['date'] for r in values] != [d['date'] for d in days]: raise ValueError('proxy_risk_calendar_mismatch')
    x = np.array([[d['benchmarkReturn'] for d in days]] +
                 [[r['netReturn']-d['benchmarkReturn'] for r,d in zip(values,days)] for values in proxies.values()]).T
    y = np.array([d['arithmeticExcess'] for d in days]); names = ['market_relative'] + [f'proxy:{key}' for key in proxies]
    if not np.isfinite(x).all() or not np.isfinite(y).all(): raise ValueError('proxy_risk_nonfinite_input')
    if len(rows) < max(20, 2*(len(names)+1)): return {**result, 'reason': 'insufficient_observations'}
    centered = x-x.mean(axis=0); scales = centered.std(axis=0, ddof=0)
    if (scales <= 1e-14).any(): return {**result, 'reason': 'constant_proxy', 'constantColumns': [name for name,s in zip(names,scales) if s<=1e-14]}
    design = np.column_stack([np.ones(len(rows)), centered/scales])
    coefficients, _, rank, singular = np.linalg.lstsq(design, y, rcond=None)
    condition = float(singular[0]/singular[-1]) if singular[-1]>0 else None
    result.update({'rank': int(rank), 'columns': len(names)+1, 'conditionNumber': condition})
    if rank < design.shape[1] or condition is None or condition > 1e6: return {**result, 'reason': 'collinear_or_ill_conditioned_proxies'}
    beta = coefficients[1:]/scales; intercept = float(coefficients[0]-np.dot(beta,x.mean(axis=0)))
    residual = y-intercept-x@beta
    parts = {name: beta[i]*x[:,i] for i,name in enumerate(names)}
    parts.update({'sample_intercept': np.full(len(y),intercept), 'model_residual': residual})
    linked = {name: math.fsum(float(v)*d['linkWeight'] for v,d in zip(values,days)) for name,values in parts.items()}
    yc = y-y.mean(); variance = float(np.dot(yc,yc)/(len(y)-1)*244)
    risks = {name: float(np.dot(values-values.mean(),yc)/(len(y)-1)*244) for name,values in parts.items() if name != 'sample_intercept'}
    error = math.fsum(linked.values())-(rows[-1]['unitNav']-rows[-1]['benchmarkNav']); variance_error = math.fsum(risks.values())-variance
    if not math.isclose(error,0,abs_tol=1e-9*max(1,rows[-1]['unitNav'],rows[-1]['benchmarkNav'])) or not math.isclose(variance_error,0,abs_tol=1e-10*max(1,variance)):
        raise ValueError('proxy_risk_reconciliation_failed')
    return {**result, 'status': 'computed_proxy_multifactor_diagnostic', 'loadings': [{'key':name,'coefficient':float(v)} for name,v in zip(names,beta)],
            'interceptPerObservation':intercept, 'linkedContributions':[{'key':k,'value':v} for k,v in linked.items()],
            'annualizedTrackingVariance':variance, 'riskContributions':[{'key':k,'varianceContribution':v,'share':v/variance if variance>0 else None} for k,v in risks.items()],
            'reconciliation':{'terminalExcessError':error,'varianceError':variance_error},
            'daily':[{'date':d['date'],'excessReturn':float(y[i]),'proxyReturns':{name:float(x[i,j]) for j,name in enumerate(names)},
                      'components':{name:float(values[i]) for name,values in parts.items()}} for i,d in enumerate(days)],
            'calculationLogic':['y=net strategy return-gross benchmark return; X=benchmark and solo proxy excess returns; rf=0',
                'OLS with intercept; scaled centered design; rank deficiency or condition > 1e6 refuses loadings',
                '244*Cov(component,y), ddof=1; signed contributions sum to annualized tracking variance',
                'terminal contribution=sum(component*S_(t-1)*B_T/B_t); intercept and residual are sample diagnostics only']}


def run(panel, bench, investable, config):
    parameters = validate(config)
    data, benchmark, inv = prepare(panel, bench, investable)
    data["previousDate"] = data.groupby("ind")["date"].shift(1)
    context = simulation_context(data,benchmark,parameters)
    result = simulate(data, benchmark, inv, parameters, context=context)
    result["factorDefinitions"] = [{"familyId": family, "weight": weight, "slots": [{"field": f, "formula": FORMULAS[f], "weight": w, "sign": sign} for f, w, sign in FAMILIES[family]]} for family, weight in parameters["weights"].items()]
    result["costRates"] = parameters["rates"]
    result["signalLagDays"] = parameters["lag"]
    result['sensitivity'] = sensitivity_runs(data, benchmark, inv, parameters, result, context=context)
    proxies, failures = {}, []
    for family in parameters['weights']:
        try:
            proxies[family] = result['rows'] if len(parameters['weights'])==1 else simulate(data,benchmark,inv,{**parameters,'weights':{family:1.}},context=context,audit=False)['rows']
        except ValueError as error: failures.append({'proxy':family,'error':str(error)})
    result['riskModel'] = {'status':'not_identifiable','reason':'proxy_unavailable','basis':list(parameters['weights']),
                           'observations':len(result['rows']),'failures':failures,'warning':'代理重跑失败，未使用部分列拟合。'} if failures else proxy_risk_model(result['rows'], proxies)
    result["warnings"] = ["industry_index_proxy_not_real_etf_execution", "historical_constituents_and_disclosure_dates_unverified",
        "lagged_signal_not_proof_of_point_in_time_fundamentals", "dividend_reconstruction_approximation", "cash_earns_zero_when_candidates_insufficient",
        "liquidity_proxy_is_not_size_factor", "benchmark_gross_index_vs_net_strategy", "alpha_smart_beta_attribution_not_computed"]
    result["sourceAudit"] = {"industryCount": int(data["ind"].nunique()), "missingInvestableNames": sorted(set(data["ind_name"]) - set(inv)),
        "missingDividendRows": int(data["div_yield"].isna().sum()), "missingPolicy": "neutral_zero_z_with_positive_weighted_coverage; >=3 finite values per slot",
        "turnoverPolicy": "sum_abs_target_minus_drifted_asset_weights; one_side_initial_buy=1; full_switch=2; cash_not_counted",
        "signalPolicy": "global_panel_observation_lag_before_rebalance_close", "annualFeePolicy": "invested_value*(1-(1-fee)^(calendar_days/365.25)); once only"}
    return result


def execute(paths, config):
    validate(config)
    frames, versions = [], []
    for file in paths:
        path = Path(file)
        before = path.stat()
        source_bytes = path.read_bytes()
        after = path.stat()
        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or len(source_bytes) != after.st_size:
            raise ValueError("industry_source_changed_retry")
        frames.append(pd.read_parquet(io.BytesIO(source_bytes)))
        versions.append({"sha256": hashlib.sha256(source_bytes).hexdigest(), "bytes": len(source_bytes), "mtimeNs": str(after.st_mtime_ns), "hashPolicy": "full_file_sha256"})
    result = run(*frames, config)
    for file, version in zip(paths, versions):
        if hashlib.sha256(Path(file).read_bytes()).hexdigest() != version["sha256"]:
            raise ValueError("industry_source_changed_retry")
    result["sourceVersions"] = versions
    result["calculationVersion"] = VERSION
    return result


if __name__ == "__main__":
    try:
        result = {"version": VERSION, "families": [{"familyId": family, "slots": [{"field": f, "formula": FORMULAS[f], "weight": w, "sign": sign} for f, w, sign in slots]} for family, slots in FAMILIES.items()]} if sys.argv[1] == "--definitions" else execute(sys.argv[1:4], json.loads(sys.argv[4]))
    except (ValueError, KeyError, TypeError, OSError) as error:
        result = {"error": str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
