"""Read-only broad-index DCA executor; legacy metric provenance is in README."""

import calendar
import datetime as dt
import hashlib
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

TARGETS = {"hs300_total_return": "hs300_tr", "zz1000_total_return": "zz1000_tr"}


def cashflow_attribution(rows):
    """Additive currency attribution of same-flow terminal wealth, not IRR or alpha."""
    if not rows:
        raise ValueError("cashflow_attribution_empty_ledger")
    daily, monthly = [], {}
    previous_value = previous_benchmark = contributed = 0.
    keys = sorted({key for row in rows for key in row["attributionInputs"]["assets"]})
    error_bound = 1e-9
    cumulative_error_bound = 0.

    def closed(actual, expected):
        if not math.isfinite(actual) or not math.isfinite(expected) or abs(actual-expected) > error_bound:
            raise ValueError("cashflow_attribution_ledger_not_closed")

    for row in rows:
        inputs = row["attributionInputs"]
        scalars = [*inputs.values(), row["accountValue"], row["benchmarkValue"], row["contributed"]]
        values = [float(x) for x in scalars if not isinstance(x, dict)]
        values += [float(x) for asset in inputs["assets"].values() for x in asset.values()]
        if not all(math.isfinite(x) for x in values) or inputs["benchmarkReturn"] <= -1:
            raise ValueError("invalid_cashflow_attribution_input")
        # Cancellation error scales with the account operands, not near-zero excess.
        capital_scale = max(1., *(abs(x) for x in values))
        error_bound = max(1e-9, 32 * (len(inputs['assets'])+8) * math.ulp(capital_scale))
        cumulative_error_bound += error_bound
        if any(inputs[key] < 0 for key in ("deposit", "managementFee", "benchmarkManagementFee", "tradingCost", "benchmarkTradingCost")):
            raise ValueError("invalid_cashflow_attribution_cost_or_flow")
        dt.date.fromisoformat(row["date"])
        if daily and row["date"] <= daily[-1]["date"]:
            raise ValueError("cashflow_attribution_dates_not_increasing")
        closed(inputs["openingValue"], previous_value)
        closed(inputs["openingBenchmarkValue"], previous_benchmark)
        assets = inputs["assets"]
        closed(math.fsum(asset["openingValue"] for asset in assets.values()) + inputs["openingCash"], previous_value)
        contributed += inputs["deposit"]
        closed(row["contributed"], contributed)
        rb = inputs["benchmarkReturn"]
        gross_profit = math.fsum(asset["grossPnl"] for asset in assets.values()) + inputs["cashIncome"]
        strategy_profit = gross_profit - inputs["managementFee"] - inputs["tradingCost"]
        benchmark_profit = previous_benchmark * rb - inputs["benchmarkManagementFee"] - inputs["benchmarkTradingCost"]
        closed(row["accountValue"], previous_value + inputs["deposit"] + strategy_profit)
        closed(row["benchmarkValue"], previous_benchmark + inputs["deposit"] + benchmark_profit)
        parts = {key: assets.get(key, {}).get("grossPnl", 0.) - assets.get(key, {}).get("openingValue", 0.) * rb for key in keys}
        parts.update({"cashExposure": inputs["cashIncome"] - inputs["openingCash"] * rb,
            "wealthDifferenceCarry": (previous_value - previous_benchmark) * rb,
            "managementFee": inputs["benchmarkManagementFee"] - inputs["managementFee"],
            "tradingCost": inputs["benchmarkTradingCost"] - inputs["tradingCost"]})
        total = math.fsum(parts.values())
        excess_change = (row["accountValue"] - row["benchmarkValue"]) - (previous_value - previous_benchmark)
        closed(total, excess_change)
        day = {"date": row["date"], "deposit": inputs["deposit"], "strategyProfit": strategy_profit,
            "benchmarkProfit": benchmark_profit, "components": parts, "total": total, "actualExcessChange": excess_change,
            "error": total-excess_change, "errorBound": error_bound, "inputs": inputs}
        daily.append(day)
        monthly.setdefault(row["date"][:7], []).append(day)
        previous_value, previous_benchmark = row["accountValue"], row["benchmarkValue"]
    component_keys = list(daily[0]["components"])
    totals = {key: math.fsum(day["components"][key] for day in daily) for key in component_keys}
    actual = previous_value - previous_benchmark
    total = math.fsum(totals.values())
    error_bound = cumulative_error_bound
    closed(actual, total)
    strategy_profit = math.fsum(day["strategyProfit"] for day in daily)
    benchmark_profit = math.fsum(day["benchmarkProfit"] for day in daily)
    closed(strategy_profit, previous_value-contributed)
    closed(benchmark_profit, previous_benchmark-contributed)
    return {"status": "computed_cashflow_accounting_v1", "version": "same-flow-wealth-difference-v1", "unit": "account_currency",
        "alphaReturn": None, "smartBetaReturn": None, "residualReturn": None, "factorDiagnostics": [],
        "buckets": [{"key": key, "value": value} for key, value in totals.items()], "daily": daily,
        "monthly": [{"month": month, "deposit": math.fsum(day["deposit"] for day in days),
            "strategyProfit": math.fsum(day["strategyProfit"] for day in days), "benchmarkProfit": math.fsum(day["benchmarkProfit"] for day in days),
            "components": {key: math.fsum(day["components"][key] for day in days) for key in component_keys},
            "total": math.fsum(day["total"] for day in days), "error": math.fsum(day["error"] for day in days)} for month, days in monthly.items()],
        "reconciliation": {"actualTerminalExcessValue": actual, "componentsTotal": total, "error": total-actual, "errorBound": error_bound,
            "strategyProfit": strategy_profit, "benchmarkProfit": benchmark_profit, "totalContributed": contributed},
        "explanation": "同现金流账户终值差的金额归因，非收益率、IRR或投资Alpha。现金与持仓项是相对单基准的账本效果，不证明因果择时或因子贡献。",
        "calculationLogic": ["当日损益=收盘账户价值-期初账户价值-当日收盘投入；新投入不赚取投入前的市场收益。",
            "资产相对损益=期初持仓毛损益-期初持仓价值×基准毛收益；现金相对损益=实际现金利息-期初现金×基准毛收益。",
            "既有终值差延续=(期初策略价值-期初基准价值)×基准毛收益；保留此项，不把历史费用复利影响误算成今日选择。",
            "费用差=基准当日费用-策略当日费用；净值内含费用不再次扣除。逐日金额直接相加，月度合计不是月度收益率。",
            "所有贡献合计=策略终值-同现金流基准终值；XIRR、TWR和分档IRR不能按这些金额贡献相加。",
            "闭合容差按账户参与运算金额的浮点ULP与项目数计算并累加；实际误差与容差均保留，不把残差强行清零。",
            "基金净值中的管理费或复权误差无法仅靠净值拆出；现金/债券代理、幸存者与历史可见性限制仍保留。"]}


def xirr(cashflows):
    # Migrated from etf-smartbeta/src/report.py:xirr; keep its solver bounds.
    if not cashflows or cashflows[-1][0] == cashflows[0][0]:
        return None
    start = cashflows[0][0]
    years = [(date - start).days / 365.25 for date, _ in cashflows]
    amounts = [amount for _, amount in cashflows]

    def npv(rate):
        return sum(amount / (1 + rate) ** year for amount, year in zip(amounts, years))

    low, high = -0.95, 3.0
    if npv(low) * npv(high) > 0:
        return None
    for _ in range(200):
        middle = (low + high) / 2
        if npv(low) * npv(middle) <= 0:
            high = middle
        else:
            low = middle
    return (low + high) / 2


def schedule(start, end, frequency):
    if frequency not in ("monthly", "weekly", "biweekly"):
        raise ValueError("unsupported_dca_frequency")
    result = []
    date = start
    index = 0
    while date <= end:
        result.append(date)
        index += 1
        if frequency == "monthly":
            month_index = start.year * 12 + start.month - 1 + index
            year, month = divmod(month_index, 12)
            month += 1
            date = dt.date(year, month, min(start.day, calendar.monthrange(year, month)[1]))
        else:
            date = start + dt.timedelta(days=index * (7 if frequency == "weekly" else 14))
    return result


def costs(model):
    values = {"commission": 0.0, "slippage": 0.0, "broad_fee": 0.0}
    for part in str(model).split(";"):
        if not part.strip():
            continue
        pair = part.strip().split("=")
        if len(pair) != 2 or pair[0].strip() not in (*values, "annual_fee"):
            raise ValueError("unsupported_dca_cost_model")
        key = pair[0].strip()
        value = float(pair[1])
        if not math.isfinite(value) or value < 0 or value >= 1:
            raise ValueError("invalid_dca_cost_rate")
        normalized_key = "broad_fee" if key == "annual_fee" else key
        values[normalized_key] = value
    return values


def run(frame, config):
    if config.get("factorFamilyIds") or config.get("factorWeights"):
        raise ValueError("dca_factor_selection_not_supported")
    settings = config.get("transactionSettings", {})
    start = dt.date.fromisoformat(settings["startDate"])
    end = dt.date.fromisoformat(settings["endDate"])
    if end <= start:
        raise ValueError("invalid_dca_date_range")
    amount = float(settings.get("amount", 0))
    if not math.isfinite(amount) or amount <= 0:
        raise ValueError("invalid_dca_amount")
    if settings.get("executionRule", "fixed_contribution_hold") != "fixed_contribution_hold":
        raise ValueError("unsupported_dca_execution_rule")
    # Legacy prose may specify gates or sales; never silently ignore it.
    if any(settings.get(key) for key in ("buyRule", "pauseRule", "sellRule")) and not settings.get("executionRule"):
        raise ValueError("dca_structured_rule_required")
    benchmark = config.get("benchmarkId")
    if benchmark not in TARGETS:
        raise ValueError("unsupported_dca_benchmark")
    policy = settings.get("cashBucketPolicy")
    if policy == "broad_only":
        target = settings.get("targetId", benchmark)
        if target not in TARGETS:
            raise ValueError("unsupported_dca_target")
        weights = {TARGETS[target]: 1.0, "cash": 0.0}
    elif policy == "broad_split_cash":
        bucket = settings.get("bucket", {})
        weights = {"hs300_tr": float(bucket.get("A", 0)), "zz1000_tr": float(bucket.get("B", 0)), "cash": float(bucket.get("C", 0))}
        if any(not math.isfinite(value) or value < 0 for value in weights.values()) or abs(sum(weights.values()) - 1) > 1e-8:
            raise ValueError("invalid_dca_bucket_weights")
        weight_sum = math.fsum(weights.values())
        weights = {key: value/weight_sum for key, value in weights.items()}
    else:
        raise ValueError("unsupported_dca_bucket_policy")
    if config.get("rebalanceCalendar") != settings.get("frequency"):
        raise ValueError("dca_frequency_mismatch")
    rates = costs(config.get("costModel", ""))
    frame = frame.copy()
    if frame.empty:
        raise ValueError("insufficient_dca_observations")
    frame["date"] = pd.to_datetime(frame["date"], errors="raise").dt.date
    if frame["date"].duplicated().any():
        raise ValueError("duplicate_dca_dates")
    frame = frame.sort_values("date")
    if start < frame["date"].iloc[0] or end > frame["date"].iloc[-1]:
        raise ValueError("dca_period_outside_data_coverage")
    frame = frame[(frame["date"] >= start) & (frame["date"] <= end)]
    if len(frame) < 2:
        raise ValueError("insufficient_dca_observations")
    benchmark_column = TARGETS[benchmark]
    columns = list(dict.fromkeys([key for key, value in weights.items() if key != "cash" and value > 0] + [benchmark_column]))
    if any(column not in frame for column in columns):
        raise ValueError("missing_dca_price_field")
    prices = frame[columns].to_numpy(dtype=float)
    if not np.isfinite(prices).all() or (prices <= 0).any():
        raise ValueError("invalid_dca_price_data")
    calendar_dates = schedule(start, end, settings["frequency"])
    trading_dates = frame["date"].tolist()
    inflows = {}
    pending = []
    for date in calendar_dates:
        index = int(np.searchsorted(trading_dates, date))
        if index < len(trading_dates):
            actual = trading_dates[index]
            inflows.setdefault(actual, []).append(date)
        else:
            pending.append({"scheduledDate": date.isoformat(), "amount": amount, "reason": "no_quote_in_requested_period"})
    if not inflows:
        raise ValueError("no_dca_contributions")
    units = {column: 0.0 for column in columns}
    benchmark_units = 0.0
    cash = total = total_cost = benchmark_cost = 0.0
    previous_value = previous_benchmark = None
    nav = benchmark_nav = 1.0
    rows, flows, investor_flows = [], [], []
    previous_date = trading_dates[0]
    previous_prices = None
    transaction_rate = rates["commission"] + rates["slippage"]
    for _, row in frame.iterrows():
        date = row["date"]
        days = (date - previous_date).days
        opening_prices = previous_prices if previous_prices is not None else row
        attribution_inputs = {"openingValue": previous_value or 0., "openingBenchmarkValue": previous_benchmark or 0.,
            "openingCash": cash, "cashIncome": 0., "assets": {"asset:"+column: {
                "openingValue": float(units[column]*opening_prices[column]),
                "grossPnl": float(units[column]*(row[column]-opening_prices[column]))} for column in columns if weights.get(column, 0) > 0},
            "benchmarkReturn": float(row[benchmark_column]/opening_prices[benchmark_column]-1),
            "managementFee": 0., "benchmarkManagementFee": 0., "tradingCost": 0., "benchmarkTradingCost": 0.}
        fee_factor = (1 - rates["broad_fee"]) ** (days / 365.25)
        for column in columns:
            charge = units[column] * row[column] * (1 - fee_factor)
            units[column] *= fee_factor
            total_cost += charge
            attribution_inputs["managementFee"] += charge
        charge = benchmark_units * row[benchmark_column] * (1 - fee_factor)
        benchmark_units *= fee_factor
        benchmark_cost += charge
        attribution_inputs["benchmarkManagementFee"] = charge
        before = cash + sum(units[column] * row[column] for column in columns)
        benchmark_before = benchmark_units * row[benchmark_column]
        # Value changes before close-price deposits are the investment return.
        market_ratio = before / previous_value if previous_value else 1.0
        benchmark_market_ratio = benchmark_before / previous_benchmark if previous_benchmark else 1.0
        deposit = len(inflows.get(date, [])) * amount
        buy_cost = benchmark_buy_cost = 0.0
        if deposit:
            total += deposit
            cash += deposit * weights.get("cash", 0)
            for column in columns:
                budget = deposit * weights.get(column, 0)
                net = budget / (1 + transaction_rate)
                units[column] += net / row[column]
                buy_cost += budget - net
            benchmark_net = deposit / (1 + transaction_rate)
            benchmark_units += benchmark_net / row[benchmark_column]
            benchmark_buy_cost = deposit - benchmark_net
            total_cost += buy_cost
            benchmark_cost += benchmark_buy_cost
            investor_flows.append((date, -deposit))
            flows.append({"date": date.isoformat(), "scheduledDates": [item.isoformat() for item in inflows[date]], "amount": deposit, "buyCost": buy_cost, "benchmarkBuyCost": benchmark_buy_cost, "cashAllocation": deposit * weights.get("cash", 0)})
        value = cash + sum(units[column] * row[column] for column in columns)
        benchmark_value = benchmark_units * row[benchmark_column]
        # Two subperiods isolate external flows while retaining deposit-day costs.
        nav *= market_ratio * (value / (before + deposit) if before + deposit > 0 else 1)
        benchmark_nav *= benchmark_market_ratio * (benchmark_value / (benchmark_before + deposit) if benchmark_before + deposit > 0 else 1)
        attribution_inputs.update({"deposit": deposit, "tradingCost": buy_cost, "benchmarkTradingCost": benchmark_buy_cost})
        rows.append({"date": date.isoformat(), "accountValue": value, "benchmarkValue": benchmark_value, "unitNav": nav, "benchmarkNav": benchmark_nav, "contributed": total, "cash": cash, "netReturn": nav / (rows[-1]["unitNav"] if rows else 1) - 1, "attributionInputs": attribution_inputs})
        previous_value, previous_benchmark, previous_date = value, benchmark_value, date
        previous_prices = row
    years = (trading_dates[-1] - trading_dates[0]).days / 365.25
    returns = np.array([item["netReturn"] for item in rows])
    volatility = float(returns[1:].std(ddof=1) * np.sqrt(244)) if len(returns) > 2 else None
    nav_values = np.array([1.0] + [item["unitNav"] for item in rows])
    annualized = float(nav_values[-1] ** (1 / years) - 1)
    irr = xirr(investor_flows + [(trading_dates[-1], rows[-1]["accountValue"])])
    benchmark_irr = xirr(investor_flows + [(trading_dates[-1], rows[-1]["benchmarkValue"])])
    metrics = {
        "annualizedReturn": annualized, "moneyWeightedIrr": irr, "benchmarkIrr": benchmark_irr,
        "excessIrr": irr - benchmark_irr if irr is not None and benchmark_irr is not None else None,
        "maxDrawdown": float(np.min(nav_values / np.maximum.accumulate(nav_values) - 1)),
        "volatility": volatility, "sharpe": annualized / volatility if volatility else None,
        "finalValue": rows[-1]["accountValue"], "benchmarkFinalValue": rows[-1]["benchmarkValue"],
        "totalCost": total_cost, "benchmarkTotalCost": benchmark_cost,
        "totalContributed": total, "contributionCount": sum(len(value) for value in inflows.values()),
        "observations": len(rows), "months": len(set(item["date"][:7] for item in rows)),
        "plannedContributionCount": len(calendar_dates), "pendingContributionCount": len(pending),
    }
    return {"rows": rows, "cashFlows": flows, "pendingContributions": pending, "metrics": metrics, "weights": weights, "costRates": rates, "attribution": cashflow_attribution(rows),
            "period": [rows[0]["date"], rows[-1]["date"]], "benchmarkColumn": benchmark_column,
            "warnings": (["xirr_outside_solver_bounds_or_zero_duration"] if irr is None or benchmark_irr is None else []) + (["scheduled_contribution_without_quote_pending"] if pending else []),
            "calculationNotes": ["Calendar contributions execute at the first available close on/after each scheduled date.", "No sales or rebalancing; new contributions follow fixed weights; cash earns zero.", "TWR chains pre-deposit market returns and post-deposit cost returns; XIRR uses actual dates and 365.25 days/year.", "Benchmark uses identical deposit dates/amounts and identical commission, slippage and broad annual fee.", "Daily volatility uses 244 trading days/year; Sharpe uses a zero risk-free rate."]}


def execute(file_path, config):
    file_path = Path(file_path)
    before = file_path.stat()
    source_bytes = file_path.read_bytes()
    digest = hashlib.sha256(source_bytes).hexdigest()
    frame = pd.read_parquet(io.BytesIO(source_bytes))
    result = run(frame, config)
    after = file_path.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise ValueError("dca_source_changed_retry")
    result["sourceVersion"] = {"sha256": digest, "bytes": after.st_size, "mtimeNs": str(after.st_mtime_ns), "hashPolicy": "full_file_sha256"}
    return result


if __name__ == "__main__":
    try:
        result = execute(sys.argv[1], json.loads(sys.argv[2]))
    except (ValueError, KeyError, TypeError) as error:
        result = {"error": str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
