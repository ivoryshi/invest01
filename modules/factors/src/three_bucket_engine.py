"""Monthly A/B/C migration with explicit lag, flows and model-rate boundaries."""

import hashlib
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import industry_engine as industry
from dca_engine import cashflow_attribution, xirr

VERSION = "three-bucket-parquet-v1"
INPUTS = ["broad", "bench", "panel", "investable", "basis", "pmi", "m2", "shibor"]
PMI_FIELD = "制造业-指数"
M2_FIELD = "货币和准货币(M2)-同比增长"
SHIBOR_FIELD = "3M-定价"
MONTH_FIELD = "月份"
SHIBOR_DATE = "日期"
DEFAULTS = {"startDate": "2016-01-04", "endDate": "2026-07-30", "amount": 10000,
    "bucketA": .6, "bucketB": .2, "bucketC": .2, "hs300Weight": .5,
    "topN": 3, "minInvestable": 8, "holdingLimitMonths": 12, "holdingLimitPolicy": "legacy_days_30_44", "signalLagDays": 1,
    "peGate": .8, "peLookback": 2440, "peMinObservations": 500, "trendGate": False,
    "missingPePolicy": "open_with_warning", "basisLookback": 500, "basisMinObservations": 120,
    "macroLookbackMonths": 60, "macroMinObservations": 18, "maxMacroAgeDays": 120,
    "maxBasisAgeDays": 30, "missingTimingPolicy": "available_mean_else_neutral", "neutralEquity": .5,
    "pmiLagMonths": 1, "m2LagMonths": 2, "shiborLagMonths": 1,
    "cashRate": .018, "bondRate": .03, "broadAnnualFee": .005, "sectorAnnualFee": .006}


def validate(config):
    if config.get("strategyTemplateId") != "strategy.legacy_three_bucket_monthly" or config.get("universe") != "broad_index_or_industry_proxy":
        raise ValueError("unsupported_three_bucket_strategy")
    if config.get("benchmarkId") != "hs300_total_return" or config.get("rebalanceCalendar") != "monthly" or config.get("portfolioRule") != "monthly_three_bucket_lagged_signals" or config.get("transactionSettings"):
        raise ValueError("unsupported_three_bucket_execution_rule")
    s = config.get("strategySettings", {})
    if not isinstance(s, dict) or set(s) != set(DEFAULTS):
        raise ValueError("three_bucket_settings_required")
    s = dict(s)
    for key in ("startDate", "endDate"):
        if not isinstance(s[key], str) or len(s[key]) != 10:
            raise ValueError("invalid_three_bucket_period")
        s[key] = pd.Timestamp(s[key])
        if pd.isna(s[key]) or s[key] != s[key].normalize():
            raise ValueError("invalid_three_bucket_period")
    if s["endDate"] <= s["startDate"]:
        raise ValueError("invalid_three_bucket_period")
    bounds = {"amount": (1, 1e9), "topN": (1, 20), "minInvestable": (1, 31), "holdingLimitMonths": (1, 36),
        "signalLagDays": (1, 20), "peLookback": (2, 5000), "peMinObservations": (2, 5000),
        "basisLookback": (2, 5000), "basisMinObservations": (2, 5000), "macroLookbackMonths": (2, 120),
        "macroMinObservations": (2, 120), "maxMacroAgeDays": (1, 366), "maxBasisAgeDays": (1, 90),
        "pmiLagMonths": (1, 12), "m2LagMonths": (2, 12), "shiborLagMonths": (1, 12)}
    for key, (lo, hi) in bounds.items():
        s[key] = industry.number(s[key], f"invalid_three_bucket_{key}", lo, hi, key != "amount")
    for key in ("bucketA", "bucketB", "bucketC", "hs300Weight", "peGate", "neutralEquity"):
        s[key] = industry.number(s[key], f"invalid_three_bucket_{key}", 0, 1)
    for key in ("cashRate", "bondRate", "broadAnnualFee", "sectorAnnualFee"):
        s[key] = industry.number(s[key], f"invalid_three_bucket_{key}", 0, .2)
    if abs(s["bucketA"] + s["bucketB"] + s["bucketC"] - 1) > 1e-8 or s["minInvestable"] < s["topN"]:
        raise ValueError("invalid_three_bucket_weights_or_top_n")
    weight_sum = math.fsum(s[key] for key in ('bucketA', 'bucketB', 'bucketC'))
    for key in ('bucketA', 'bucketB', 'bucketC'):
        s[key] /= weight_sum
    if any(s[lo] > s[hi] for lo, hi in [("peMinObservations", "peLookback"), ("basisMinObservations", "basisLookback"), ("macroMinObservations", "macroLookbackMonths")]):
        raise ValueError("invalid_three_bucket_signal_window")
    if not isinstance(s["trendGate"], bool) or s["missingPePolicy"] not in ("open_with_warning", "hold_cash") or s["missingTimingPolicy"] != "available_mean_else_neutral":
        raise ValueError("unsupported_three_bucket_missing_policy")
    if s["holdingLimitPolicy"] not in ("legacy_days_30_44", "calendar_months"):
        raise ValueError("unsupported_three_bucket_holding_limit_policy")
    # Reuse industry family/weight validation, not its date/cost execution policy.
    c = {"strategyTemplateId": "strategy.industry_parquet_monthly_topn", "universe": "sw_industry_and_etf_proxy", "benchmarkId": "hs300_total_return", "rebalanceCalendar": "monthly", "portfolioRule": "monthly_topn_equal_weight_prior_signal",
        "costModel": config.get("costModel", ""), "factorFamilyIds": config.get("factorFamilyIds"), "factorWeights": config.get("factorWeights"),
        "strategySettings": {"startDate": s["startDate"].date().isoformat(), "endDate": s["endDate"].date().isoformat(), "topN": s["topN"], "signalLagDays": s["signalLagDays"], "minInvestable": s["minInvestable"], "weightingMethod": "equal_weight", "missingValuePolicy": "neutral_with_coverage"}}
    parsed = industry.validate(c)
    if parsed["rates"]["annual_fee"] != 0:
        raise ValueError("three_bucket_annual_fee_use_sleeve_settings")
    s["factorWeights"] = parsed["weights"]
    s["tradeRate"] = parsed["rates"]["commission"] + parsed["rates"]["slippage"]
    return s


def percentile(series, window, minimum):
    def rank(values):
        if not np.isfinite(values[-1]):
            return np.nan
        history = values[:-1][np.isfinite(values[:-1])]
        return float(np.mean(history < values[-1])) if len(history) >= minimum - 1 else np.nan
    return series.rolling(window, min_periods=minimum).apply(rank, raw=True)


def daily(frame, date_field, columns):
    if not {date_field, *columns} <= set(frame):
        raise ValueError("three_bucket_source_fields_missing")
    result = frame[[date_field, *columns]].copy()
    result[date_field] = pd.to_datetime(result[date_field], errors="raise")
    if result[date_field].isna().any() or result[date_field].duplicated().any() or not result[date_field].eq(result[date_field].dt.normalize()).all():
        raise ValueError("three_bucket_duplicate_or_invalid_dates")
    for col in columns:
        result[col] = pd.to_numeric(result[col], errors="raise").replace([np.inf, -np.inf], np.nan)
    return result.sort_values(date_field).set_index(date_field)


def monthly(frame, value_field):
    if not {MONTH_FIELD, value_field} <= set(frame):
        raise ValueError("three_bucket_macro_fields_missing")
    fields = frame[MONTH_FIELD].astype(str).str.extract(r"^(\d{4})\D+(\d{1,2})\D*$")
    periods = pd.to_datetime({"year": fields[0], "month": fields[1], "day": 1}, errors="raise")
    if periods.isna().any() or periods.duplicated().any():
        raise ValueError("three_bucket_duplicate_or_invalid_months")
    values = pd.to_numeric(frame[value_field], errors="raise").replace([np.inf, -np.inf], np.nan)
    s = pd.Series(values.to_numpy(), index=pd.DatetimeIndex(periods)).sort_index()
    if s.empty:
        return s
    return s.reindex(pd.date_range(s.index[0], s.index[-1], freq="MS"))


def macro_signals(frames, settings):
    raw = {"pmi": monthly(frames["pmi"], PMI_FIELD), "m2": monthly(frames["m2"], M2_FIELD),
        "shibor": daily(frames["shibor"], SHIBOR_DATE, [SHIBOR_FIELD])[SHIBOR_FIELD].resample("MS").last()}
    result = []
    for key, values in raw.items():
        pct = percentile(values, settings["macroLookbackMonths"], settings["macroMinObservations"])
        signal = .6 * (((values - 50) / 2).clip(-1, 1) * .5 + .5) + .4 * pct if key == "pmi" else 1 - pct if key == "shibor" else pct
        lag = settings[f"{key}LagMonths"]
        for month, value in signal.dropna().items():
            result.append({"component": key, "sourceMonth": month, "availableAt": month + pd.DateOffset(months=lag), "score": float(value)})
    return result


def timing_on(records, basis, date, settings):
    components = []
    for key in ("pmi", "m2", "shibor"):
        matches = [row for row in records if row["component"] == key and row["availableAt"] <= date]
        row = max(matches, key=lambda x: x["availableAt"]) if matches else None
        usable = row is not None and (date - row["availableAt"]).days <= settings["maxMacroAgeDays"]
        components.append({"component": key, "sourceMonth": row["sourceMonth"].date().isoformat() if row else None,
            "availableAt": row["availableAt"].date().isoformat() if row else None,
            "score": row["score"] if usable else None, "status": "available" if usable else "stale" if row else "missing_or_warmup"})
    available = [row["score"] for row in components if row["score"] is not None]
    macro = float(np.mean(available)) if available else None
    b = basis.loc[basis.index <= date, "signal"].dropna()
    basis_date = b.index[-1] if len(b) else None
    basis_value = float(b.iloc[-1]) if len(b) and (date - basis_date).days <= settings["maxBasisAgeDays"] else None
    both = [value for value in (basis_value, macro) if value is not None]
    return {"components": components, "macroScore": macro, "basisScore": basis_value,
        "basisDate": basis_date.date().isoformat() if basis_date is not None else None,
        "basisStatus": "available" if basis_value is not None else "stale" if basis_date is not None else "missing_or_warmup",
        "equityRatio": float(np.mean(both)) if both else settings["neutralEquity"],
        "fallback": "mean_of_available" if both else "configured_neutral"}


class Sleeve:
    def __init__(self, trade_rate):
        self.cash, self.trading_cost, self.management_fee, self.nav, self.contributed = 0., 0., 0., 1., 0.
        self.holdings, self.entry, self.flows = {}, {}, []
        self.trade_rate = trade_rate

    def value(self):
        return self.cash + sum(self.holdings.values())

    def buy(self, code, budget, date):
        if budget <= 1e-12:
            return
        if budget > self.cash + 1e-6:
            raise ValueError("three_bucket_cash_deficit")
        budget = min(budget, self.cash)
        cost = budget * self.trade_rate
        self.cash -= budget
        self.holdings[code] = self.holdings.get(code, 0) + budget - cost
        self.entry.setdefault(code, date)
        self.trading_cost += cost

    def sell(self, code, gross):
        gross = min(gross, self.holdings.get(code, 0))
        if gross <= 0:
            return
        self.holdings[code] -= gross
        self.cash += gross * (1 - self.trade_rate)
        self.trading_cost += gross * self.trade_rate
        if self.holdings[code] < 1e-10:
            self.holdings.pop(code)
            self.entry.pop(code, None)

    def rebalance(self, weights, date):
        # Solve post-cost target capital, then sell before buying to conserve cash.
        total = self.value()
        def costs(net):
            values = []
            for code in sorted(set(self.holdings) | set(weights)):
                diff = net * weights.get(code, 0) - self.holdings.get(code, 0)
                values.append(diff * self.trade_rate / (1 - self.trade_rate) if diff > 0 else -diff * self.trade_rate)
            return math.fsum(values)
        low, high = 0., total
        for _ in range(60):
            middle = (low + high) / 2
            if middle + costs(middle) > total:
                high = middle
            else:
                low = middle
        net = (low + high) / 2
        for code in list(self.holdings):
            diff = self.holdings[code] - net * weights.get(code, 0)
            if diff > 0:
                self.sell(code, diff)
        for code, weight in weights.items():
            diff = net * weight - self.holdings.get(code, 0)
            if diff > 0:
                self.buy(code, diff / (1 - self.trade_rate), date)


def metrics(rows, flows, value_key="accountValue", nav_key="unitNav"):
    final = rows[-1][value_key]
    irr = xirr(flows + [(pd.Timestamp(rows[-1]["date"]).date(), final)]) if flows else None
    years = (pd.Timestamp(rows[-1]["date"]) - pd.Timestamp(rows[0]["date"])).days / 365.25
    navs = np.array([1.] + [r[nav_key] for r in rows])
    annual = float(navs[-1] ** (1 / years) - 1) if years > 0 else None
    returns = navs[1:] / navs[:-1] - 1
    vol = float(returns.std(ddof=1) * np.sqrt(244)) if len(returns) > 1 else None
    return {"finalValue": final, "moneyWeightedIrr": irr, "annualizedReturn": annual,
        "maxDrawdown": float(np.min(navs / np.maximum.accumulate(navs) - 1)), "volatility": vol, "sharpe": annual / vol if vol and annual is not None else None}


def run(frames, config):
    s = validate(config)
    broad = daily(frames["broad"], "date", ["hs300_tr", "zz1000_tr", "hs300_pe", "zz1000_pe", "hs300_px", "zz1000_px"])
    data, bench, inv = industry.prepare(frames["panel"], frames["bench"], frames["investable"])
    basis = daily(frames["basis"], "date", ["basis_pct"])
    basis["signal"] = 1 - percentile(basis["basis_pct"], s["basisLookback"], s["basisMinObservations"])
    macro = macro_signals(frames, s)
    broad_dates = broad.index[(broad.index >= s["startDate"]) & (broad.index <= s["endDate"])]
    dates = broad_dates.intersection(pd.DatetimeIndex(data.date.unique())).sort_values() if s["bucketB"] > 0 else broad_dates
    excluded_dates = broad_dates.difference(dates)
    if set(broad_dates.to_period("M")) != set(dates.to_period("M")):
        raise ValueError("three_bucket_month_missing_common_calendar")
    if len(dates) < 2 or s["startDate"] < broad.index[0] or s["endDate"] > broad.index[-1] or (s["bucketB"] > 0 and (s["startDate"] < data.date.min() or s["endDate"] > data.date.max())):
        raise ValueError("three_bucket_period_outside_data_coverage")
    prices = broad.loc[dates, ["hs300_tr", "zz1000_tr"]].to_numpy(dtype=float)
    bp = bench.reindex(dates)["hs300_tr"].to_numpy(dtype=float)
    if not np.isfinite(prices).all() or (prices <= 0).any() or not np.isfinite(bp).all() or (bp <= 0).any():
        raise ValueError("three_bucket_price_or_benchmark_gap")
    for key in ("hs300", "zz1000"):
        broad[f"{key}_pct"] = percentile(broad[f"{key}_pe"].where(broad[f"{key}_pe"] > 0), s["peLookback"], s["peMinObservations"])
        broad[f"{key}_ma"] = broad[f"{key}_px"].rolling(200, min_periods=120).mean()
    data["previousDate"] = data.groupby("ind")["date"].shift(1)
    by_day = {date: g.set_index("ind", drop=False) for date, g in data.groupby("date")}
    panel_days = pd.DatetimeIndex(sorted(by_day))
    months = set(pd.Series(dates).groupby([dates.year, dates.month]).min())
    sleeves = {key: Sleeve(s["tradeRate"]) for key in "ABC"}
    previous, previous_date, nav, benchmark_units, benchmark_nav, previous_bench = 0., dates[0], 1., 0., 1., 0.
    contributed, rows, decisions, flows, investor_flows = 0., [], [], [], []
    warnings = set()
    if len(excluded_dates):
        warnings.add("broad_dates_without_industry_panel_excluded_explicit_common_calendar")
    for i, date in enumerate(dates):
        days = (date - previous_date).days
        old_sleeve_values = {key: sleeve.value() for key, sleeve in sleeves.items()}
        attribution_inputs = {'openingValue': previous, 'openingBenchmarkValue': previous_bench,
            'openingCash': math.fsum(sleeve.cash for sleeve in sleeves.values()), 'cashIncome': 0.,
            'assets': {'sleeve:'+key: {'openingValue': math.fsum(sleeve.holdings.values()), 'grossPnl': 0.} for key, sleeve in sleeves.items()},
            'benchmarkReturn': float(bp[i]/bp[i-1]-1) if i else 0.,
            'managementFee': 0., 'benchmarkManagementFee': 0., 'benchmarkTradingCost': 0.}
        trading_cost_before = math.fsum(sleeve.trading_cost for sleeve in sleeves.values())
        for key, sleeve in sleeves.items():
            old_cash = sleeve.cash
            sleeve.cash *= (1 + (s["bondRate"] if key == "C" else s["cashRate"])) ** (days / 365.25)
            attribution_inputs['cashIncome'] += sleeve.cash-old_cash
            for code, value in list(sleeve.holdings.items()):
                if code in ("hs300", "zz1000"):
                    r = float(broad.at[date, f"{code}_tr"] / broad.at[previous_date, f"{code}_tr"] - 1)
                    fee_rate = s["broadAnnualFee"]
                else:
                    if date not in by_day or code not in by_day[date].index or by_day[date].loc[code, "previousDate"] != previous_date:
                        raise ValueError("three_bucket_held_industry_quote_gap")
                    r = by_day[date].loc[code, "totalReturn"]
                    fee_rate = s["sectorAnnualFee"]
                if not np.isfinite(r) or r <= -1:
                    raise ValueError("three_bucket_invalid_held_return")
                gross = value * (1 + r)
                attribution_inputs['assets']['sleeve:'+key]['grossPnl'] += value*r
                fee = gross * (1 - (1 - fee_rate) ** (days / 365.25))
                sleeve.holdings[code] = gross - fee
                sleeve.management_fee += fee
                attribution_inputs['managementFee'] += fee
        before_sleeves = {key: sleeve.value() for key, sleeve in sleeves.items()}
        before = sum(before_sleeves.values())
        benchmark_before = benchmark_units * bp[i]
        deposit, allocations = 0., {key: 0. for key in "ABC"}
        if date in months:
            day_index = broad.index.get_loc(date) - s["signalLagDays"]
            signal_date = broad.index[day_index] if day_index >= 0 else None
            signal_panel = panel_days[panel_days <= signal_date] if signal_date is not None else []
            panel_date = signal_panel[-1] if len(signal_panel) else None
            ranked, field_coverage = industry.score(by_day[panel_date].reset_index(drop=True), s["factorWeights"]) if panel_date is not None else ([], {})
            eligible = [r for r in ranked if date in by_day and r["code"] in by_day[date].index and pd.notna(inv.get(r["name"])) and inv[r["name"]] <= date]
            b_active = len(eligible) >= s["minInvestable"]
            deposit = s["amount"]
            allocations = {"A": deposit * (s["bucketA"] + (s["bucketB"] if not b_active else 0)), "B": deposit * s["bucketB"] if b_active else 0., "C": deposit * s["bucketC"]}
            for key, amount in allocations.items():
                sleeves[key].cash += amount
                sleeves[key].contributed += amount
                if amount:
                    sleeves[key].flows.append((date.date(), -amount))
            a = sleeves["A"]
            budget = a.cash
            gates = []
            for key, weight in (("hs300", s["hs300Weight"]), ("zz1000", 1 - s["hs300Weight"])):
                pct = broad.at[signal_date, f"{key}_pct"] if signal_date is not None else np.nan
                pe_missing = not np.isfinite(pct)
                closed = (pe_missing and s["missingPePolicy"] == "hold_cash") or (not pe_missing and pct > s["peGate"])
                trend_missing = False
                if s["trendGate"]:
                    px = broad.at[signal_date, f"{key}_px"] if signal_date is not None else np.nan
                    ma = broad.at[signal_date, f"{key}_ma"] if signal_date is not None else np.nan
                    trend_missing = not np.isfinite(px) or not np.isfinite(ma) or px <= 0
                    closed = closed or trend_missing or px < ma
                gates.append({"target": key, "percentile": float(pct) if not pe_missing else None, "closed": bool(closed), "peStatus": "missing_or_warmup" if pe_missing else "available", "trendStatus": "missing_or_warmup" if trend_missing else "available" if s["trendGate"] else "disabled"})
                if weight > 0 and pe_missing:
                    warnings.add("pe_missing_or_warmup_policy_applied")
                if not closed:
                    a.buy(key, budget * weight, date)
            b = sleeves["B"]
            forced = [code for code in b.holdings if (date >= b.entry[code] + pd.DateOffset(months=s["holdingLimitMonths"]) if s["holdingLimitPolicy"] == "calendar_months" else (date - b.entry[code]).days / 30.44 >= s["holdingLimitMonths"])] if b_active else []
            for code in forced:
                b.sell(code, b.holdings[code])
            selected = [r for r in eligible if r["code"] not in forced][:s["topN"]] if b_active else []
            if b_active:
                b.rebalance({r["code"]: 1 / len(selected) for r in selected}, date)
            timing = timing_on(macro, basis, signal_date, s) if signal_date is not None else {"components": [], "macroScore": None, "basisScore": None, "basisDate": None, "basisStatus": "missing_or_warmup", "equityRatio": s["neutralEquity"], "fallback": "configured_neutral"}
            if timing["macroScore"] is None or timing["basisScore"] is None:
                warnings.add("timing_missing_warmup_or_stale_policy_applied")
            sleeves["C"].rebalance({"hs300": timing["equityRatio"]}, date)
            benchmark_units += deposit / bp[i]
            contributed += deposit
            investor_flows.append((date.date(), -deposit))
            flows.append({"date": date.date().isoformat(), "scheduledDates": [date.date().isoformat()], "amount": deposit, "allocations": allocations})
            decisions.append({"date": date.date().isoformat(), "signalDate": signal_date.date().isoformat() if signal_date is not None else None,
                "industrySignalDate": panel_date.date().isoformat() if panel_date is not None else None, "eligibleCount": len(eligible), "bActive": b_active,
                "redirectBToA": allocations["A"] - deposit * s["bucketA"], "allocations": allocations, "gates": gates,
                "forcedCodes": forced, "codes": [r["code"] for r in selected], "names": [r["name"] for r in selected], "scores": eligible,
                "holdingCodes": list(b.holdings), "holdingNames": [str(by_day[date].loc[code, "ind_name"]) for code in b.holdings], "holdingValues": dict(b.holdings), "holdingCash": b.cash,
                "fieldCoverage": field_coverage, "timing": timing})
        values = {key: sleeve.value() for key, sleeve in sleeves.items()}
        total = sum(values.values())
        nav *= (before / previous if previous else 1) * (total / (before + deposit) if before + deposit else 1)
        benchmark_value = benchmark_units * bp[i]
        benchmark_nav *= (benchmark_before / previous_bench if previous_bench else 1) * (benchmark_value / (benchmark_before + deposit) if benchmark_before + deposit else 1)
        for key, sleeve in sleeves.items():
            sleeve.nav *= (before_sleeves[key] / old_sleeve_values[key] if old_sleeve_values[key] else 1) * (values[key] / (before_sleeves[key] + allocations[key]) if before_sleeves[key] + allocations[key] else 1)
        attribution_inputs.update({'deposit': deposit, 'tradingCost': math.fsum(sleeve.trading_cost for sleeve in sleeves.values())-trading_cost_before})
        rows.append({"date": date.date().isoformat(), "accountValue": total, "benchmarkValue": benchmark_value, "unitNav": nav, "benchmarkNav": benchmark_nav, "contributed": contributed,
            "cash": sum(x.cash for x in sleeves.values()), "sleeveValues": values, "sleeveNavs": {key: x.nav for key, x in sleeves.items()},
            "sleeveCash": {key: x.cash for key, x in sleeves.items()}, "tradingCost": sum(x.trading_cost for x in sleeves.values()), "managementFee": sum(x.management_fee for x in sleeves.values()), 'attributionInputs': attribution_inputs})
        previous, previous_date, previous_bench = total, date, benchmark_value
    result_metrics = metrics(rows, investor_flows)
    benchmark_metrics = metrics(rows, investor_flows, "benchmarkValue", "benchmarkNav")
    result_metrics.update({"benchmarkIrr": benchmark_metrics["moneyWeightedIrr"], "excessIrr": result_metrics["moneyWeightedIrr"] - benchmark_metrics["moneyWeightedIrr"] if result_metrics["moneyWeightedIrr"] is not None and benchmark_metrics["moneyWeightedIrr"] is not None else None,
        "benchmarkAnnualizedReturn": benchmark_metrics["annualizedReturn"], "benchmarkFinalValue": benchmark_metrics["finalValue"], "totalContributed": contributed,
        "contributionCount": len(flows), "observations": len(rows), "months": len(decisions), "totalCost": rows[-1]["tradingCost"] + rows[-1]["managementFee"]})
    sleeve_metrics = []
    for key, sleeve in sleeves.items():
        active_start = sleeve.flows[0][0].isoformat() if sleeve.flows else None
        subrows = [{"date": row["date"], "value": row["sleeveValues"][key], "nav": row["sleeveNavs"][key]} for row in rows if active_start and row["date"] >= active_start]
        summary = metrics(subrows, sleeve.flows, "value", "nav") if subrows else {"finalValue": 0., **dict.fromkeys(["moneyWeightedIrr", "annualizedReturn", "maxDrawdown", "volatility", "sharpe"])}
        sleeve_metrics.append({"bucket": key, **summary, "activeStartDate": active_start, "activeEndDate": rows[-1]["date"] if active_start else None,
            "totalContributed": sleeve.contributed, "tradingCost": sleeve.trading_cost, "managementFee": sleeve.management_fee})
    return {"calculationVersion": VERSION, "rows": rows, "cashFlows": flows, "decisions": decisions, "metrics": result_metrics, "sleeveMetrics": sleeve_metrics, 'attribution': cashflow_attribution(rows), 'allocationWeights': {key: s['bucket'+key] for key in 'ABC'},
        "calendarAudit": {"policy": "common_broad_industry_dates" if s["bucketB"] > 0 else "broad_data_dates_no_B_allocation", "broadDateCount": len(broad_dates), "executionDateCount": len(dates), "excludedBroadDates": [d.date().isoformat() for d in excluded_dates]},
        "period": [rows[0]["date"], rows[-1]["date"]], "warnings": sorted(warnings) + ["index_proxy_not_real_etf_execution", "macro_revision_vintages_and_actual_release_dates_unverified", "synthetic_bond_cash_rate_not_real_bond", "benchmark_gross_vs_strategy_net", "alpha_smart_beta_attribution_not_computed"],
        "calculationPolicy": {"macroAvailability": {key: s[f"{key}LagMonths"] for key in ("pmi", "m2", "shibor")}, "signalLagDays": s["signalLagDays"], "cashInterest": "single_calendar_day_compound_no_interest_on_new_close_deposits", "fees": "once_only_calendar_day_on_invested_value", "bMissing": "new_B_contribution_redirected_to_A_existing_B_holdings_unchanged", "holdingLimitPolicy": s["holdingLimitPolicy"], "holdingLimitCheck": "B_active_monthly_decisions_only", "equalWeight": "post_transaction_cost_targets_sells_before_buys", "basisAgeDays": s["maxBasisAgeDays"], "macroAgeDays": s["maxMacroAgeDays"]}}


def execute(paths, config):
    validate(config)
    if len(paths) != len(INPUTS):
        raise ValueError("three_bucket_complete_bundle_required")
    frames, versions = {}, []
    for key, file in zip(INPUTS, paths):
        data = Path(file).read_bytes()
        frames[key] = pd.read_parquet(io.BytesIO(data))
        versions.append({"input": key, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "hashPolicy": "full_file_sha256"})
    result = run(frames, config)
    if any(hashlib.sha256(Path(file).read_bytes()).hexdigest() != version["sha256"] for file, version in zip(paths, versions)):
        raise ValueError("three_bucket_source_changed_retry")
    result["sourceVersions"] = versions
    return result


if __name__ == "__main__":
    try:
        result = {"version": VERSION, "defaults": DEFAULTS, "families": list(industry.FAMILIES), "sourceBindings": {"pmi": {"dateField": MONTH_FIELD, "valueField": PMI_FIELD}, "m2": {"dateField": MONTH_FIELD, "valueField": M2_FIELD}, "shibor": {"dateField": SHIBOR_DATE, "valueField": SHIBOR_FIELD}}} if sys.argv[1] == "--definitions" else execute(json.loads(sys.argv[1]), json.loads(sys.argv[2]))
    except (ValueError, KeyError, TypeError, OSError) as error:
        result = {"error": str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
