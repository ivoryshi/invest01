import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location("industry", Path(__file__).resolve().parents[1] / "modules/factors/src/industry_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class IndustryTest(unittest.TestCase):
    def fixture(self, start="2019-12-01", end="2020-03-31"):
        dates = pd.date_range(start, end)
        panel = pd.concat([pd.DataFrame({"date": dates, "ind": code, "ind_name": code, "close": 100., "pb": i + 1., "pe": 10. * (i + 1), "turnover": 1., "amt_share": i + 1., "div_yield": 0.}) for i, code in enumerate(["0001", "0002", "0003"])], ignore_index=True)
        bench = pd.DataFrame({"date": dates, "hs300_tr": 100.})
        inv = pd.DataFrame({"ind_name": ["0001", "0002", "0003"], "first_investable": pd.Timestamp("2018-01-01")})
        return panel, bench, inv

    def config(self, **settings):
        return {"strategyTemplateId": "strategy.industry_parquet_monthly_topn", "universe": "sw_industry_and_etf_proxy", "factorFamilyIds": ["library.industry.value"],
            "factorWeights": [{"factorFamilyId": "library.industry.value", "weight": 1}], "portfolioRule": "monthly_topn_equal_weight_prior_signal", "rebalanceCalendar": "monthly", "benchmarkId": "hs300_total_return", "costModel": "commission=0;slippage=0;annual_fee=0",
            "strategySettings": {"startDate": "2020-01-01", "endDate": "2020-03-31", "topN": 1, "minInvestable": 3, "signalLagDays": 1, "weightingMethod": "equal_weight", "missingValuePolicy": "neutral_with_coverage", **settings}}

    def test_flat_prices_and_irr_not_aliased(self):
        result = engine.run(*self.fixture(), self.config())
        self.assertEqual(result["metrics"]["finalValue"], 1)
        self.assertEqual(result["metrics"]["maxDrawdown"], 0)
        self.assertIsNone(result["metrics"]["moneyWeightedIrr"])
        self.assertIsNone(result["metrics"]["excessIrr"])
        self.assertEqual(result["decisions"][0]["signalDate"], "2019-12-31")
        self.assertEqual(result["decisions"][0]["codes"], ["0001"])
        self.assertEqual(result["decisions"][0]["turnover"], 1)

    def test_lag_and_purchase_close_not_same_day_profit(self):
        panel, bench, inv = self.fixture()
        panel.loc[(panel.ind == "0001") & (panel.date >= "2020-01-01"), "close"] = 200.
        panel.loc[(panel.ind == "0001") & (panel.date >= "2020-01-01"), "pb"] = 100.
        result = engine.run(panel, bench, inv, self.config(endDate="2020-01-02"))
        self.assertEqual(result["decisions"][0]["codes"], ["0001"])
        self.assertEqual(result["metrics"]["finalValue"], 1)
        self.assertLess(result["decisions"][0]["signalDate"], result["decisions"][0]["date"])

    def test_future_append_cannot_change_past_ledger_or_scores(self):
        panel, bench, inv = self.fixture()
        first = engine.run(panel, bench, inv, self.config(endDate="2020-01-31"))
        panel.loc[panel.date > "2020-01-31", ["close", "pb", "pe"]] = [9999., .01, .1]
        second = engine.run(panel, bench, inv, self.config(endDate="2020-01-31"))
        self.assertEqual(first["rows"], second["rows"])
        self.assertEqual(first["decisions"], second["decisions"])

    def test_investable_filter_and_cash_threshold(self):
        panel, bench, inv = self.fixture()
        inv.loc[inv.ind_name == "0001", "first_investable"] = pd.Timestamp("2021-01-01")
        result = engine.run(panel, bench, inv, self.config(minInvestable=2))
        self.assertEqual(result["decisions"][0]["codes"], ["0002"])
        cash = engine.run(panel, bench, inv, self.config(minInvestable=3))
        self.assertTrue(all(row["cash"] == 1 for row in cash["rows"]))
        self.assertEqual(cash["metrics"]["cashMonths"], 3)
        self.assertEqual(cash["metrics"]["totalCost"], 0)

    def test_single_fee_and_initial_purchase_cost(self):
        config = self.config()
        config["costModel"] = "commission=0.01;slippage=0;annual_fee=0.1"
        result = engine.run(*self.fixture(), config)
        expected = .99 * .9 ** (90 / 365.25)
        self.assertAlmostEqual(result["metrics"]["finalValue"], expected)
        self.assertAlmostEqual(result["metrics"]["totalCost"], 1 - expected)
        self.assertEqual(result["metrics"]["benchmarkFinalValue"], 1)
        self.assertGreater(result["sensitivity"][0]["finalValue"], result["metrics"]["finalValue"])

    def test_complete_switch_is_two_one_sided_legs(self):
        panel, bench, inv = self.fixture()
        panel.loc[(panel.ind == "0001") & (panel.date >= "2020-01-31"), ["pb", "pe"]] = [100., 1000.]
        config = self.config()
        config["costModel"] = "commission=0.01;slippage=0;annual_fee=0"
        result = engine.run(panel, bench, inv, config)
        self.assertEqual(result["decisions"][1]["codes"], ["0002"])
        self.assertEqual(result["decisions"][1]["turnover"], 2)
        self.assertAlmostEqual(result["metrics"]["finalValue"], .99 * .98)

    def test_features_match_executable_legacy_windows(self):
        panel, _, _ = self.fixture(start="2019-01-01", end="2020-03-31")
        panel["close"] = panel.groupby("ind").cumcount() + 100.
        f = engine.features(panel)
        g = f[f.ind == "0001"].reset_index(drop=True)
        t = 300
        self.assertAlmostEqual(g.loc[t, "mom12"], g.loc[t - 21, "close"] / g.loc[t - 252, "close"] - 1)
        self.assertAlmostEqual(g.loc[t, "eg"], g.loc[t, "close"] / g.loc[t - 244, "close"] - 1)
        self.assertAlmostEqual(g.loc[t, "vol60"], g.close.pct_change().iloc[t - 59:t + 1].std() * np.sqrt(244))

    def test_missing_slots_constant_z_and_fixed_weights(self):
        panel, _, _ = self.fixture()
        data = engine.features(panel)
        day = data[data.date == pd.Timestamp("2019-12-31")].copy()
        rows, coverage = engine.score(day, {"library.industry.value": 1})
        self.assertEqual(coverage["pbpct"], 0)
        self.assertAlmostEqual(rows[0]["coverage"], .65)
        self.assertAlmostEqual(rows[0]["score"], sum(x["contribution"] for x in rows[0]["factorDetails"]))
        day["pb"] = 1.
        day["bm"] = 1.
        rows, _ = engine.score(day, {"library.industry.value": 1})
        self.assertEqual(rows[0]["factorDetails"][0]["zScore"], 0.)

    def test_low_vol_dividend_liquidity_definitions_and_no_scale_claim(self):
        panel, bench, inv = self.fixture()
        panel["div_yield"] = 2.
        config = self.config()
        config["factorFamilyIds"] = ["library.industry.dividend", "library.industry.size_liquidity"]
        config["factorWeights"] = [{"factorFamilyId": x, "weight": 1} for x in config["factorFamilyIds"]]
        result = engine.run(panel, bench, inv, config)
        self.assertEqual(result["decisions"][0]["codes"], ["0003"])
        self.assertIn("liquidity_proxy_is_not_size_factor", result["warnings"])
        self.assertGreater(result["metrics"]["finalValue"], 1)

    def test_unknown_or_unsupported_configs_rejected(self):
        for key, value, error in [("signalLagDays", 0, "invalid_industry_signal_lag"), ("topN", 1.5, "invalid_industry_top_n"), ("weightingMethod", "risk_budget", "unsupported_industry_portfolio_rule"), ("timingRule", "gate", "unsupported_industry_strategy_settings")]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, error):
                engine.run(*self.fixture(), self.config(**{key: value}))
        config = self.config()
        config["factorFamilyIds"] = ["submission.custom"]
        with self.assertRaisesRegex(ValueError, "unsupported_industry_factor_family"):
            engine.run(*self.fixture(), config)
        config = self.config()
        config["benchmarkId"] = "zz1000_total_return"
        with self.assertRaisesRegex(ValueError, "unsupported_industry_benchmark"):
            engine.run(*self.fixture(), config)

    def test_duplicate_quotes_missing_held_quote_and_benchmark_gaps(self):
        panel, bench, inv = self.fixture()
        with self.assertRaisesRegex(ValueError, "duplicate_industry_source_keys"):
            engine.run(pd.concat([panel, panel.iloc[:1]]), bench, inv, self.config())
        with self.assertRaisesRegex(ValueError, "industry_held_quote_missing"):
            engine.run(panel[~((panel.ind == "0001") & (panel.date == "2020-01-02"))], bench, inv, self.config())
        with self.assertRaisesRegex(ValueError, "industry_benchmark_calendar_gap"):
            engine.run(panel, bench[bench.date != "2020-01-02"], inv, self.config())

    def test_parser_and_source_fingerprint_bind_same_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for name, frame in zip(["panel", "bench", "investable"], self.fixture()):
                file = Path(directory) / (name + ".parquet")
                frame.to_parquet(file)
                paths.append(file)
            original_read = pd.read_parquet
            buffers = []
            def read(source):
                self.assertIsInstance(source, io.BytesIO)
                buffers.append(source.getvalue())
                return original_read(source)
            with patch.object(engine.pd, "read_parquet", side_effect=read):
                result = engine.execute(paths, self.config())
            self.assertEqual([x["sha256"] for x in result["sourceVersions"]], [hashlib.sha256(b).hexdigest() for b in buffers])
            original_run = engine.run
            def mutate(*args):
                result = original_run(*args)
                paths[0].write_bytes(b"changed")
                return result
            with patch.object(engine, "run", side_effect=mutate), self.assertRaisesRegex(ValueError, "industry_source_changed_retry"):
                engine.execute(paths, self.config())


if __name__ == "__main__":
    unittest.main()
