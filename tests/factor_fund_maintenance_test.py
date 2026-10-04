import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
import fund_history_backup as backup
import fund_history_store as store


class FundMaintenanceTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.raw = self.root/'raw'
        (self.raw/'nav').mkdir(parents=True)
        (self.raw/'bench').mkdir()
        (self.raw/'universe_master.csv').write_text('share_code,share_name\n000001,one\n000002,two\n')
        for code in ['000001', '000002']:
            self.nav(code, 1)
        (self.raw/'bench/CSI300.csv').write_text('date,close,kind,source_code\n2020-01-01,100,全收益,H00300\n2020-01-02,101,全收益,H00300\n')
        self.db = self.root/'live.sqlite'
        store.import_csvs(self.raw, self.db, ['CSI300'])
        self.packs = self.root/'packs'

    def nav(self, code, value):
        (self.raw/'nav'/f'{code}.csv').write_text(f'date,adj_nav,unit_nav,source,adj_method,freq\n2020-01-01,{value},1,offex_unit,self_calc,日频\n2020-01-02,{value},1,offex_unit,self_calc,日频\n')

    def capture(self):
        m = backup.create_pack(self.db, self.packs)
        return m, self.packs/m['backupId']

    def values(self, database):
        db = store.open_reader(database)
        try:
            return [tuple(row) for row in db.execute('SELECT * FROM history ORDER BY kind,code,date')]
        finally:
            db.close()

    def test_roundtrip_original_unchanged_independent_recovery(self):
        expected = self.values(self.db)
        original = self.db.read_bytes()
        manifest, folder = self.capture()
        self.assertEqual(self.db.read_bytes(), original)
        self.assertEqual(backup.verify_pack(folder), manifest)
        self.nav('000001', 2)
        store.import_csvs(self.raw, self.db, [], nav_codes=['000001'])
        restored = self.root/'recovered.sqlite'
        result = backup.restore_pack(folder, restored)
        self.assertEqual(result['status'], 'restored_to_new_file')
        self.assertEqual(self.values(restored), expected)
        self.assertNotEqual(self.values(self.db), expected)
        repeated = backup.create_pack(restored, self.packs)
        self.assertEqual(repeated['payload']['database'], manifest['payload']['database'])
        self.assertEqual(self.values(self.packs/repeated['backupId']/'database.sqlite'), expected)
        # SQLite may change header counters on re-backup; identity is bytes, not logical equality.
        self.assertEqual(backup.verify_pack(self.packs/repeated['backupId']), repeated)

    def test_wal_is_included_and_active_import_rejected(self):
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute("UPDATE history SET value=3 WHERE kind='nav'")
        writer.commit()
        _, folder = self.capture()
        self.assertEqual(self.values(folder/'database.sqlite'), self.values(self.db))
        writer.execute("INSERT INTO import_runs(started_at,status) VALUES('test','running')")
        writer.commit()
        with self.assertRaisesRegex(ValueError, 'import_in_progress'):
            self.capture()
        self.assertFalse(list(self.packs.glob('.staging-*')))

    def test_restore_never_overwrites_or_accepts_sidecars(self):
        _, folder = self.capture()
        for output in [self.db, folder/'database.sqlite']:
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'target_exists'):
                backup.restore_pack(folder, output)
            self.assertEqual(output.read_bytes(), before)
        output = self.root/'new.sqlite'
        Path(str(output)+'-wal').write_bytes(b'old sidecar')
        with self.assertRaisesRegex(ValueError, 'target_exists'):
            backup.restore_pack(folder, output)
        self.assertFalse(output.exists())

    def test_corrupt_database_and_manifest_rejected(self):
        _, folder = self.capture()
        file = folder/'database.sqlite'
        raw = file.read_bytes()
        file.write_bytes(raw[:-1]+bytes([raw[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, 'hash_mismatch'):
            backup.verify_pack(folder)
        file.write_bytes(raw)
        manifest_file = folder/'manifest.json'
        manifest = json.loads(manifest_file.read_text())
        manifest['payload']['database']['sourceDigest'] = '0'*64
        manifest_file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'identity_mismatch'):
            backup.verify_pack(folder)

    def test_tampered_sqlite_with_rehashed_manifest_still_rejects(self):
        manifest, folder = self.capture()
        with sqlite3.connect(folder/'database.sqlite') as db:
            db.execute("UPDATE sources SET sha256='bad'")
        manifest['payload']['sha256'] = backup.digest(folder/'database.sqlite')
        manifest['payload']['bytes'] = (folder/'database.sqlite').stat().st_size
        manifest['backupId'] = backup.identity(manifest['payload'])
        (folder/'manifest.json').write_bytes(backup.canonical(manifest))
        destination = folder.parent/manifest['backupId']
        folder.rename(destination)
        with self.assertRaisesRegex(ValueError, 'provenance_mismatch'):
            backup.verify_pack(destination)

    def test_symlink_failure_and_staging_cleanup(self):
        link = self.root/'link.sqlite'
        link.symlink_to(self.db)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            backup.create_pack(link, self.packs)
        _, folder = self.capture()
        output = self.root/'recovery.sqlite'
        original = backup.shutil.copyfile
        def damaged(source, target):
            original(source, target)
            Path(target).write_bytes(b'broken')
        with patch.object(backup.shutil, 'copyfile', side_effect=damaged):
            with self.assertRaisesRegex(ValueError, 'copy_mismatch'):
                backup.restore_pack(folder, output)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob('.restore-*')))
        with patch.object(backup, 'inspect_database', side_effect=ValueError('broken')):
            with self.assertRaisesRegex(ValueError, 'broken'):
                self.capture()
        self.assertFalse(list(self.packs.glob('.staging-*')))

    def test_selected_import_preserves_others_and_benchmark(self):
        self.nav('000001', 2)
        (self.raw/'nav/000002.csv').write_text('invalid')
        (self.raw/'bench/CSI300.csv').write_text('invalid')
        report = store.import_csvs(self.raw, self.db, [], nav_codes=['000001'])
        self.assertEqual(report['lastImport']['imported'], 1)
        self.assertEqual(report['lastImport']['skipped'], 1)
        self.assertEqual(report['lastImport']['rejected'], 0)
        values = self.values(self.db)
        self.assertEqual([row[3] for row in values if row[1] == '000001'], [2, 2])
        self.assertEqual([row[3] for row in values if row[1] == '000002'], [1, 1])
        self.assertEqual(len([row for row in values if row[0] == 'benchmark']), 2)
        self.assertEqual(store.import_csvs(self.raw, self.db, [], nav_codes=['000001'])['lastImport']['imported'], 0)

    def test_missing_selected_sources_are_audited_previous_rows_kept(self):
        expected = self.values(self.db)
        (self.raw/'nav/000001.csv').unlink()
        (self.raw/'bench/CSI300.csv').unlink()
        report = store.import_csvs(self.raw, self.db, ['CSI300'], nav_codes=['000001'], require_benchmarks=True)
        self.assertEqual(report['lastImport']['rejected'], 2)
        self.assertEqual(report['lastImport']['status'], 'completed_with_rejections')
        self.assertEqual(self.values(self.db), expected)

    def test_bad_selection_refused_before_writes(self):
        before = self.db.read_bytes()
        for codes in [['../one'], ['000001','000001'], [1]]:
            with self.assertRaisesRegex(ValueError, 'invalid_nav_selection'):
                store.import_csvs(self.raw, self.db, [], nav_codes=codes)
        for ids in [['../oops'], ['CSI300', 'CSI300'], [['CSI300']]]:
            with self.assertRaisesRegex(ValueError, 'invalid_benchmark_selection'):
                store.import_csvs(self.raw, self.db, ids)
        self.assertEqual(self.db.read_bytes(), before)

    def test_directory_sync_before_and_after_publication(self):
        with patch.object(backup, 'sync_directory', wraps=backup.sync_directory) as sync:
            _, folder = self.capture()
            calls = [args.args[0] for args in sync.call_args_list]
            staging = next(p for p in calls if p.name.startswith('.staging-'))
            self.assertLess(calls.index(staging), len(calls)-1)
            self.assertEqual(calls[-1], self.packs)
        output = self.root/'new/recovery.sqlite'
        with patch.object(backup, 'sync_directory', wraps=backup.sync_directory) as sync:
            backup.restore_pack(folder, output)
            self.assertEqual([args.args[0] for args in sync.call_args_list][-2:], [output.parent, output.parent])

    def test_retry_resyncs_pack_published_before_failed_sync(self):
        self.packs.mkdir()
        original = backup.sync_directory
        def fail_publish(directory):
            if directory == self.packs:
                raise OSError('simulated_directory_sync_failure')
            return original(directory)
        with patch.object(backup, 'sync_directory', side_effect=fail_publish):
            with self.assertRaisesRegex(OSError, 'simulated_directory_sync_failure'):
                self.capture()
        self.assertEqual(len(list(self.packs.iterdir())), 1)
        with patch.object(backup, 'sync_directory', wraps=original) as sync:
            manifest, folder = self.capture()
            self.assertEqual(backup.verify_pack(folder), manifest)
            self.assertIn(self.packs, [args.args[0] for args in sync.call_args_list])
        self.assertFalse(list(self.packs.glob('.staging-*')))

    def test_cli_roundtrip_and_import_exit_codes_in_separate_workbench(self):
        project = Path(__file__).resolve().parents[1]
        workspace = self.root/'workbench'
        (workspace/'scripts').mkdir(parents=True)
        (workspace/'modules/factors/src').mkdir(parents=True)
        (workspace/'var/factors').mkdir(parents=True)
        for relative in ['scripts/import-fund-history.py', 'scripts/fund-history-backup.py',
                         'modules/factors/src/fund_history_store.py', 'modules/factors/src/fund_history_backup.py']:
            shutil.copyfile(project/relative, workspace/relative)
        live = workspace/'var/factors/fund-history.sqlite'
        shutil.copyfile(self.db, live)
        def run(script, *args):
            return subprocess.run([sys.executable, '-B', str(workspace/'scripts'/script), *map(str, args)],
                                  capture_output=True, text=True, timeout=10)
        result = run('import-fund-history.py', '--raw-root', self.raw, '--nav-codes', '000001', '--skip-benchmarks')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['lastImport']['skipped'], 2)
        (self.raw/'nav/000001.csv').write_text('invalid')
        result = run('import-fund-history.py', '--raw-root', self.raw, '--nav-codes', '000001', '--skip-benchmarks')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['lastImport']['rejected'], 1)
        before = self.values(live)
        result = run('import-fund-history.py', '--raw-root', self.raw, '--nav-codes', '000001', '--benchmark-ids', 'CSI300', 'CSI300')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)['error'], 'fund_history_invalid_benchmark_selection')
        self.assertEqual(self.values(live), before)
        result = run('fund-history-backup.py', 'create')
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        folder = workspace/'var/factors/database-backups'/manifest['backupId']
        self.assertEqual(run('fund-history-backup.py', 'verify', folder).returncode, 0)
        output = workspace/'restored.sqlite'
        result = run('fund-history-backup.py', 'restore', folder, '--output', output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(output), before)
        self.assertEqual(run('fund-history-backup.py', 'restore', folder, '--output', output).returncode, 1)


if __name__ == '__main__':
    unittest.main()
