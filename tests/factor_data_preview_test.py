import csv
import datetime
import importlib.util
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

spec = importlib.util.spec_from_file_location("factor_data_preview", Path(__file__).resolve().parents[1] / "modules/factors/src/data_preview.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DataPreviewTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.csv_path = Path(self.directory.name) / "wide.csv"
        with self.csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["code", "name", "date", "value"])
            writer.writerows([
                ["000001", "Alpha, Inc", "2026-01-01", ""],
                ["000002", "Beta", "2026-02-01", "2"],
                ["000003", "Alpha", "2026-03-01", "3"],
            ])

    def test_csv_quotes_identifiers_nulls_and_pagination(self):
        first = module.preview(self.csv_path, {"fields": ["code", "name", "value"], "limit": 1})
        self.assertEqual(first["rows"], [{"code": "000001", "name": "Alpha, Inc", "value": None}])
        self.assertEqual(first["missingCounts"]["value"], 1)
        self.assertEqual(first["nextOffset"], 1)
        rest = module.preview(self.csv_path, {"fields": ["code"], "offset": 1})
        self.assertEqual([row["code"] for row in rest["rows"]], ["000002", "000003"])
        self.assertTrue(rest["complete"])
        self.assertEqual(rest["totalRows"], 3)

    def test_date_and_keyword_intersection_and_keyword_scope(self):
        result = module.preview(self.csv_path, {"fields": ["name"], "q": "ALPHA", "startDate": "2026-02-01", "endDate": "2026-03-01"})
        self.assertEqual(result["rows"], [{"name": "Alpha"}])
        result = module.preview(self.csv_path, {"fields": ["code"], "q": "Beta"})
        self.assertEqual(result["rowCount"], 0)

    def test_scan_budget_is_not_reported_as_whole_dataset(self):
        with self.csv_path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["code"])
            writer.writerows([[str(index)] for index in range(5002)])
        first = module.preview(self.csv_path, {"fields": ["code"], "q": "5001"})
        self.assertEqual(first["rowCount"], 0)
        self.assertEqual(first["scannedRows"], 5000)
        self.assertFalse(first["complete"])
        self.assertEqual(first["nextOffset"], 5000)
        second = module.preview(self.csv_path, {"fields": ["code"], "q": "5001", "offset": 5000})
        self.assertEqual(second["rows"], [{"code": "5001"}])
        self.assertTrue(second["complete"])

    def test_parquet_projection_dates_and_nonfinite_values(self):
        file_path = Path(self.directory.name) / "panel.parquet"
        pq.write_table(pa.table({"date": [datetime.date(2026, 1, 1), datetime.date(2026, 2, 1)], "value": [float("nan"), 2.0], "unused": [1, 2]}), file_path)
        first = module.preview(file_path, {"fields": ["value"], "limit": 1})
        self.assertEqual(first["rows"], [{"value": None}])
        self.assertEqual(first["totalRows"], 2)
        second = module.preview(file_path, {"fields": ["date", "value"], "startDate": "2026-02-01"})
        self.assertEqual(second["rows"], [{"date": "2026-02-01", "value": 2.0}])
        self.assertTrue(second["complete"])

    def test_invalid_fields_and_date_binding(self):
        with self.assertRaisesRegex(ValueError, "invalid_fields"):
            module.preview(self.csv_path, {"fields": ["unknown"]})
        with self.assertRaisesRegex(ValueError, "invalid_date_field"):
            module.preview(self.csv_path, {"dateField": "unknown"})
        with self.assertRaisesRegex(ValueError, "invalid_date_value"):
            module.preview(self.csv_path, {"dateField": "value", "startDate": "2026-01-01"})
