import datetime as dt
import importlib.util
import hashlib
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pandas as pd

spec = importlib.util.spec_from_file_location("dca_engine", Path(__file__).resolve().parents[1] / "modules/factors/src/dca_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class DcaEngineTest(unittest.TestCase):
    def config(self, **settings):
        return {"benchmarkId": "hs300_total_return", "costModel": "commission=0;slippage=0;broad_fee=0", "rebalanceCalendar": settings.get("frequency", "monthly"),
                "transactionSettings": {"startDate": "2020-01-01", "endDate": "2020-12-31", "amount": 100, "frequency": "monthly", "cashBucketPolicy": "broad_only", "targetId": "hs300_total_return", "executionRule": "fixed_contribution_hold", **settings}}

    def flat(self):
        return pd.DataFrame({"date": pd.date_range("2019-12-01", "2021-01-01"), "hs300_tr": 100.0, "zz1000_tr": 100.0})

    def test_deposits_are_not_returns_and_amount_scales(self):
        frame = self.flat()
        result = engine.run(frame, self.config())
        self.assertEqual(result["metrics"]["contributionCount"], 12)
        self.assertAlmostEqual(result["metrics"]["finalValue"], 1200)
        self.assertAlmostEqual(result["metrics"]["moneyWeightedIrr"], 0, places=10)
        self.assertAlmostEqual(result["metrics"]["annualizedReturn"], 0)
        double = engine.run(frame, self.config(amount=200))
        self.assertAlmostEqual(double["metrics"]["finalValue"], 2 * result["metrics"]["finalValue"])
        self.assertAlmostEqual(double["metrics"]["moneyWeightedIrr"], result["metrics"]["moneyWeightedIrr"])
        weekly = engine.run(frame, self.config(frequency="weekly"))
        self.assertGreater(weekly["metrics"]["contributionCount"], result["metrics"]["contributionCount"])
        self.assertAlmostEqual(weekly["metrics"]["annualizedReturn"], 0)

    def test_month_end_anchor_and_next_quote_without_lookahead(self):
        dates = engine.schedule(dt.date(2020, 1, 31), dt.date(2020, 4, 30), "monthly")
        self.assertEqual(dates, [dt.date(2020, 1, 31), dt.date(2020, 2, 29), dt.date(2020, 3, 31), dt.date(2020, 4, 30)])
        frame = self.flat()
        frame = frame[frame.date.dt.dayofweek < 5]
        result = engine.run(frame, self.config(startDate="2020-01-04", endDate="2020-03-31"))
        self.assertEqual(result["cashFlows"][0]["date"], "2020-01-06")
        self.assertEqual(result["cashFlows"][0]["scheduledDates"], ["2020-01-04"])
        pending = engine.run(frame, self.config(startDate="2020-01-29", endDate="2020-02-29"))
        self.assertEqual(pending["metrics"]["pendingContributionCount"], 1)
        self.assertEqual(pending["pendingContributions"][0]["scheduledDate"], "2020-02-29")

    def test_known_one_deposit_xirr_and_different_benchmark(self):
        frame = pd.DataFrame({"date": ["2020-01-01", "2020-01-02"], "hs300_tr": [100., 110.], "zz1000_tr": [100., 120.]})
        config = self.config(endDate="2020-01-02")
        config["benchmarkId"] = "zz1000_total_return"
        result = engine.run(frame, config)
        self.assertAlmostEqual(result["metrics"]["finalValue"], 110)
        self.assertAlmostEqual(result["metrics"]["benchmarkFinalValue"], 120)
        self.assertIsNone(result["metrics"]["moneyWeightedIrr"])
        self.assertIn("xirr_outside_solver_bounds_or_zero_duration", result["warnings"])
        flows = [(dt.date(2020, 1, 1), -100.), (dt.date(2021, 1, 1), 110.)]
        self.assertAlmostEqual(engine.xirr(flows), 1.1 ** (365.25 / 366) - 1, places=10)

    def test_costs_are_in_nav_and_benchmark_uses_same_cashflows(self):
        config = self.config()
        config["costModel"] = "commission=0.1;slippage=0;broad_fee=0.1"
        result = engine.run(self.flat(), config)
        self.assertAlmostEqual(result["rows"][0]["unitNav"], 1 / 1.1)
        self.assertLess(result["metrics"]["finalValue"], result["metrics"]["totalContributed"])
        self.assertLess(result["metrics"]["annualizedReturn"], 0)
        self.assertAlmostEqual(result["metrics"]["excessIrr"], 0, places=10)
        self.assertAlmostEqual(result["metrics"]["totalCost"], result["metrics"]["benchmarkTotalCost"])

    def test_cash_allocation_is_preserved(self):
        result = engine.run(self.flat(), self.config(cashBucketPolicy="broad_split_cash", bucket={"A": .5, "B": 0, "C": .5}))
        self.assertAlmostEqual(result["rows"][-1]["cash"], 600)
        self.assertAlmostEqual(result["cashFlows"][0]["cashAllocation"], 50)
        with self.assertRaisesRegex(ValueError, "invalid_dca_bucket_weights"):
            engine.run(self.flat(), self.config(cashBucketPolicy="broad_split_cash", bucket={"A": .5, "B": 0, "C": 0}))

    def test_unsupported_rules_costs_and_coverage_fail_explicitly(self):
        for settings, message in [({"frequency": "manual"}, "unsupported_dca_frequency"), ({"cashBucketPolicy": "bucket_a_b_c"}, "unsupported_dca_bucket_policy"), ({"startDate": "2018-01-01"}, "dca_period_outside_data_coverage"), ({"amount": -1}, "invalid_dca_amount"), ({"executionRule": "legacy_rules"}, "unsupported_dca_execution_rule")]:
            with self.assertRaisesRegex(ValueError, message):
                engine.run(self.flat(), self.config(**settings))
        config = self.config()
        config["costModel"] = "sector_fee=0.006"
        with self.assertRaisesRegex(ValueError, "unsupported_dca_cost_model"):
            engine.run(self.flat(), config)
        config = self.config(buyRule="PE conditional rule")
        del config["transactionSettings"]["executionRule"]
        with self.assertRaisesRegex(ValueError, "dca_structured_rule_required"):
            engine.run(self.flat(), config)
        config = self.config()
        config["factorFamilyIds"] = ["library.industry.dividend"]
        with self.assertRaisesRegex(ValueError, "dca_factor_selection_not_supported"):
            engine.run(self.flat(), config)

    def test_invalid_prices_and_duplicate_dates_fail(self):
        frame = self.flat()
        frame.loc[frame.date == "2020-02-01", "hs300_tr"] = 0
        with self.assertRaisesRegex(ValueError, "invalid_dca_price_data"):
            engine.run(frame, self.config())
        duplicate = pd.concat([self.flat(), self.flat().iloc[:1]])
        with self.assertRaisesRegex(ValueError, "duplicate_dca_dates"):
            engine.run(duplicate, self.config())

    def test_hash_and_parquet_parser_use_identical_bytes_under_same_stat_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "broad.parquet"
            replacement_file = Path(directory) / "replacement.parquet"
            frame = pd.DataFrame({"date": pd.to_datetime(["2020-01-01", "2020-02-01"]), "hs300_tr": [100.0, 101.0], "zz1000_tr": [100.0, 100.0]})
            frame.to_parquet(file, compression=None, use_dictionary=False)
            frame.loc[1, "hs300_tr"] = 202.0
            frame.to_parquet(replacement_file, compression=None, use_dictionary=False)
            original, replacement = file.read_bytes(), replacement_file.read_bytes()
            self.assertEqual(len(original), len(replacement))
            info, reader = file.stat(), engine.pd.read_parquet

            def replace_then_parse(buffer):
                file.write_bytes(replacement)
                os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns))
                return reader(buffer)

            with patch.object(engine.pd, "read_parquet", side_effect=replace_then_parse):
                result = engine.execute(file, self.config(startDate="2020-01-01", endDate="2020-02-01"))
            self.assertEqual(result["metrics"]["finalValue"], 201.0)
            self.assertEqual(result["sourceVersion"]["sha256"], hashlib.sha256(original).hexdigest())
