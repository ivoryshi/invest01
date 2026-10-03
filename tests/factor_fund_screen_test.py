import importlib.util
import hashlib
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pandas as pd

spec = importlib.util.spec_from_file_location("fund_screen", Path(__file__).parents[1] / "modules/factors/src/fund_screen.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class FundScreenTest(unittest.TestCase):
    def setUp(self):
        self.group = dict(zip(engine.GROUP_KEYS, ["equity", "daily", "index", "total_return"]))
        self.settings = {"comparisonGroup": self.group, "rankFields": [{"factorFamilyId": "absolute", "field": "return", "weight": 1}], "topN": 10}
        self.definitions = [
            {"factorFamilyId": "absolute", "field": "return", "sourceField": "return", "name": "Return", "direction": "higher_is_better", "familyVersion": "v1"},
            {"factorFamilyId": "risk", "field": "risk", "sourceField": "risk", "name": "Risk", "direction": "lower_is_better", "familyVersion": "v1"},
        ]
        self.frame = pd.DataFrame([
            {**dict(zip(engine.GROUP_COLUMNS, self.group.values())), "share_code": f"{i:06d}", "share_name": f"Fund {i}", "fund_key": f"fund_{i}", "is_primary": "1", "return": str(value), "risk": str(value), "\u5386\u53f2\u5e74\u6570": str(i)}
            for i, value in enumerate([10, 20, 30], 1)
        ])

    def run_screen(self):
        return engine.screen(self.frame, self.settings, self.definitions)

    def test_group_isolation(self):
        extra = []
        for column in engine.GROUP_COLUMNS:
            row = self.frame.iloc[0].copy()
            row[column] = "other"
            row["return"] = "999"
            extra.append(row)
        self.frame = pd.concat([self.frame, pd.DataFrame(extra)], ignore_index=True)
        result = self.run_screen()
        self.assertEqual(result["metrics"], {"sourceRowCount": 7, "eligibleCount": 3, "selectedCount": 3})
        self.assertEqual(result["filterAudit"][0]["excluded"], 4)

    def test_primary_identity_and_stable_dedup(self):
        duplicate = self.frame.iloc[0].copy()
        duplicate["share_code"] = "000009"
        duplicate["return"] = "999"
        nonprimary = self.frame.iloc[1].copy()
        nonprimary["is_primary"] = "0"
        nonprimary["share_code"] = "000008"
        self.frame = pd.concat([self.frame, pd.DataFrame([duplicate, nonprimary])], ignore_index=True)
        result = self.run_screen()
        self.assertEqual([row["shareCode"] for row in result["candidates"]], ["000003", "000002", "000001"])
        self.settings["primaryShareOnly"] = False
        self.assertEqual(self.run_screen()["metrics"]["selectedCount"], 5)

    def test_direction_ties_and_weight_normalization(self):
        self.settings["rankFields"].append({"factorFamilyId": "risk", "field": "risk", "weight": 3})
        result = self.run_screen()
        self.assertEqual(result["candidates"][0]["shareCode"], "000001")
        self.assertAlmostEqual(result["candidates"][0]["score"], .75)
        self.frame["return"] = "20"
        self.settings["rankFields"] = self.settings["rankFields"][:1]
        result = self.run_screen()
        self.assertEqual([row["score"] for row in result["candidates"]], [.5, .5, .5])
        self.assertEqual(result["candidates"][0]["shareCode"], "000001")

    def test_missing_exclude_and_neutral(self):
        self.settings["rankFields"].append({"factorFamilyId": "risk", "field": "risk", "weight": 1})
        self.frame.loc[2, "return"] = None
        self.frame.loc[0, "return"] = "inf"
        self.frame.loc[0, "risk"] = "bad"
        result = self.run_screen()
        self.assertEqual(result["metrics"]["eligibleCount"], 1)
        self.assertEqual(result["missingCounts"], {"return": 2, "risk": 1})
        self.settings["missingValuePolicy"] = "neutral"
        result = self.run_screen()
        self.assertEqual(result["metrics"]["eligibleCount"], 2)
        missing = next(row for row in result["candidates"] if row["shareCode"] == "000003")["factorDetails"][0]
        self.assertIsNone(missing["rawValue"])
        self.assertTrue(missing["missing"])
        self.assertEqual(missing["score"], .5)

    def test_all_missing_field_rejected(self):
        self.settings["rankFields"].append({"factorFamilyId": "risk", "field": "risk", "weight": 1})
        self.settings["missingValuePolicy"] = "neutral"
        self.frame["risk"] = None
        with self.assertRaisesRegex(ValueError, "fund_rank_field_has_no_valid_values"):
            self.run_screen()

    def test_invalid_fields_weights_and_direction(self):
        for value in [0, -1, "nan", "inf"]:
            self.settings["rankFields"][0]["weight"] = value
            with self.assertRaisesRegex(ValueError, "invalid_fund_factor_weight"):
                self.run_screen()
        self.settings["rankFields"][0]["weight"] = 1
        self.settings["rankFields"].append(dict(self.settings["rankFields"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate_fund_rank_field"):
            self.run_screen()
        self.settings["rankFields"] = self.settings["rankFields"][:1]
        self.definitions[0]["direction"] = "context_dependent"
        with self.assertRaisesRegex(ValueError, "fund_factor_direction_required"):
            self.run_screen()
        self.definitions[0]["sourceField"] = "missing"
        with self.assertRaisesRegex(ValueError, "fund_factor_field_unavailable"):
            self.run_screen()

    def test_history_minimum_and_single_sample(self):
        self.settings["minHistoryYears"] = 3
        result = self.run_screen()
        self.assertEqual(result["metrics"]["selectedCount"], 1)
        self.assertEqual(result["candidates"][0]["score"], .5)
        self.assertIsNone(result["candidates"][0]["dataEnd"])

    def test_relative_requires_benchmark(self):
        self.definitions[0]["factorFamilyId"] = "library.fund.benchmark_relative"
        self.settings["rankFields"][0]["factorFamilyId"] = "library.fund.benchmark_relative"
        self.group["benchmark"] = ""
        with self.assertRaisesRegex(ValueError, "fund_relative_factor_benchmark_required"):
            self.run_screen()

    def test_source_profile_and_version_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "wide.csv"
            self.frame.to_csv(file, index=False)
            result = engine.execute(file, "profile", {})
            self.assertEqual(result["groups"][0]["primaryCount"], 3)
            self.assertEqual(len(result["sourceVersion"]["sha256"]), 64)
            payload = {"settings": self.settings, "definitions": self.definitions, "expectedSha256": result["sourceVersion"]["sha256"]}
            self.assertEqual(engine.execute(file, "screen", payload)["candidates"][0]["shareCode"], "000003")
            self.frame.loc[0, "return"] = "100"
            self.frame.to_csv(file, index=False)
            with self.assertRaisesRegex(ValueError, "fund_source_version_changed_reload_profile"):
                engine.execute(file, "screen", payload)

    def test_invalid_group_settings_and_rank_spec(self):
        for settings in [[], {"comparisonGroup": []}, {"comparisonGroup": self.group, "rankFields": [None]}]:
            with self.assertRaises(ValueError):
                engine.screen(self.frame, settings, self.definitions)

    def test_hash_and_csv_parser_use_identical_bytes_under_same_stat_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "wide.csv"
            self.frame.to_csv(file, index=False)
            original = file.read_bytes()
            info = file.stat()
            reader = engine.pd.read_csv

            def replace_then_parse(buffer, **kwargs):
                file.write_bytes(original.replace(b",10,10,", b",90,10,"))
                os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns))
                return reader(buffer, **kwargs)

            with patch.object(engine.pd, "read_csv", side_effect=replace_then_parse):
                result = engine.execute(file, "screen", {"settings": self.settings, "definitions": self.definitions})
            self.assertEqual(result["candidates"][0]["shareCode"], "000003")
            self.assertEqual(result["sourceVersion"]["sha256"], hashlib.sha256(original).hexdigest())
            self.assertNotEqual(file.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
