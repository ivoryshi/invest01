import hashlib
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
import fund_history_snapshot as snapshot
import fund_history_store as store
import fund_nav_engine as engine
import factor_fund_nav_test as fixture


class FundSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.FundNavTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.database = self.fixture.database
        self.output = self.fixture.root/'frozen.sqlite'
        self.config = self.fixture.config()
        self.expected = engine.execute(self.database, self.config)
        self.selection = {'codes': ['000001', '000002'], 'benchmarkId': 'CSI300',
                          'sourceVersions': self.config['strategySettings']['sourceVersions']}

    def capture(self, selection=None, output=None):
        return snapshot.capture(self.database, output or self.output, selection or self.selection)

    def execute(self, captured):
        config = {**self.config, 'snapshotId': 'snapshot.frozen.'+'a'*64}
        return engine.execute(self.output, config, captured['sha256'])

    def test_selected_snapshot_exact_replay_and_subset_catalog(self):
        captured = self.capture()
        self.assertEqual(self.execute(captured), self.expected)
        catalog = engine.catalog(self.output, '000', captured['sha256'])
        self.assertEqual(catalog['benchmarks'], ['CSI300'])
        self.assertEqual(catalog['database']['selection'], captured['selection'])
        self.assertEqual(catalog['database']['lastImport'], None)
        self.assertEqual(next(s for s in catalog['database']['sources'] if s['kind'] == 'universe')['rows'], 2)
        self.assertLess(captured['bytes'], snapshot.MAX_BYTES)
        for codes, benchmark in [(['000001'], 'CSI300'), (['000001', '000002'], 'CSI500')]:
            with self.assertRaisesRegex(ValueError, 'selection_mismatch'):
                engine.profile(self.output, codes, benchmark, captured['sha256'])
        reverse = engine.profile(self.output, ['000002', '000001'], 'CSI300', captured['sha256'])
        self.assertEqual([s['sourceId'] for s in reverse['sourceVersions']], ['universe_master', 'nav.000002', 'nav.000001', 'benchmark.CSI300'])
        config = {**self.config, 'snapshotId': 'snapshot.frozen.'+'a'*64,
                  'strategySettings': {**self.config['strategySettings'], 'shares': [{'shareCode': '000001', 'weight': 1}]}}
        with self.assertRaisesRegex(ValueError, 'selection_mismatch'):
            engine.execute(self.output, config, captured['sha256'])

    def test_live_update_and_deletion_do_not_change_frozen_result(self):
        captured = self.capture()
        self.fixture.change('000001', lambda f: f.__setitem__('adj_nav', 3.))
        with self.assertRaisesRegex(ValueError, 'source_version_changed'):
            engine.execute(self.database, self.config)
        self.assertEqual(self.execute(captured), self.expected)
        self.database.unlink()
        for file in self.fixture.root.glob('**/*.csv'):
            file.unlink()
        self.assertEqual(self.execute(captured), self.expected)

    def test_changed_profile_and_bad_selections_leave_no_output(self):
        invalid = [{**self.selection, 'codes': []}, {**self.selection, 'codes': ['../x']},
                   {**self.selection, 'codes': ['000001', '000001']}, {**self.selection, 'benchmarkId': '../x'},
                   {**self.selection, 'sourceVersions': []}]
        for value in invalid:
            with self.assertRaises(ValueError):
                self.capture(value)
            self.assertFalse(self.output.exists())
        self.fixture.change('000001', lambda f: f.__setitem__('adj_nav', 3.))
        with self.assertRaisesRegex(ValueError, 'source_version_changed'):
            self.capture()
        self.assertFalse(self.output.exists())

    def test_frozen_hash_and_verified_execution_required(self):
        captured = self.capture()
        config = {**self.config, 'snapshotId': 'snapshot.frozen.'+'a'*64}
        with self.assertRaisesRegex(ValueError, 'verified_content_required'):
            engine.execute(self.output, config)
        raw = self.output.read_bytes()
        self.output.write_bytes(raw[:-1]+bytes([raw[-1]^1]))
        with self.assertRaisesRegex(ValueError, 'integrity_failed'):
            self.execute(captured)

    def test_single_read_transaction_during_import(self):
        original = store.source
        changed = False
        def concurrent(db, source_id):
            nonlocal changed
            row = original(db, source_id)
            if not changed:
                changed = True
                self.fixture.change('000001', lambda f: f.__setitem__('adj_nav', 3.))
            return row
        with patch.object(store, 'source', side_effect=concurrent):
            captured = self.capture()
        self.assertEqual(self.execute(captured), self.expected)

    def test_limit_and_missing_rows_cleanup_without_touching_live_data(self):
        with patch.object(snapshot, 'MAX_BYTES', 4096):
            with self.assertRaises(sqlite3.Error):
                self.capture()
        self.assertFalse(self.output.exists())
        self.assertFalse(Path(str(self.output)+'-journal').exists())
        self.assertEqual(engine.execute(self.database, self.config), self.expected)
        with sqlite3.connect(self.database) as db:
            db.execute("DELETE FROM history WHERE kind='nav' AND code='000001' AND date='2020-01-01'")
        with self.assertRaisesRegex(ValueError, 'row_count_mismatch'):
            self.capture()
        self.assertFalse(self.output.exists())

    def test_no_clobber_and_selection_order_idempotency(self):
        captured = self.capture()
        raw = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, 'output_exists'):
            self.capture()
        self.assertEqual(self.output.read_bytes(), raw)
        self.fixture.ingest()
        other = self.fixture.root/'same.sqlite'
        self.assertEqual(self.capture(output=other)['sha256'], captured['sha256'])
        reverse = {'codes': ['000002', '000001'], 'benchmarkId': 'CSI300',
                   'sourceVersions': engine.profile(self.database, ['000002', '000001'], 'CSI300')['sourceVersions']}
        third = self.fixture.root/'reverse.sqlite'
        self.assertEqual(self.capture(reverse, third)['sha256'], captured['sha256'])

    def test_memory_database_uses_same_bytes_as_verified_hash(self):
        captured = self.capture()
        self.fixture.change('000001', lambda f: f.__setitem__('adj_nav', 3.))
        fresh = {'codes': self.selection['codes'], 'benchmarkId': 'CSI300',
                 'sourceVersions': engine.profile(self.database, self.selection['codes'], 'CSI300')['sourceVersions']}
        other = self.fixture.root/'changed.sqlite'
        self.capture(fresh, other)
        replacement = other.read_bytes()
        original = store.sqlite3.connect
        def replace_file(*args, **kwargs):
            if args[0] == ':memory:':
                self.output.write_bytes(replacement)
            return original(*args, **kwargs)
        with patch.object(store.sqlite3, 'connect', side_effect=replace_file):
            self.assertEqual(self.execute(captured), self.expected)
        self.assertNotEqual(hashlib.sha256(self.output.read_bytes()).hexdigest(), captured['sha256'])


if __name__ == '__main__':
    unittest.main()
