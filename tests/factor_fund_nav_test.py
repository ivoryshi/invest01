import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'modules/factors/src'))
import fund_nav_engine as e
import fund_history_store as store


class FundNavTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); (self.root/'nav').mkdir(); (self.root/'bench').mkdir()
        self.database = self.root/'history.sqlite'
        self.dates = pd.bdate_range('2020-01-01', '2020-03-31')
        pd.DataFrame({'share_code': ['000001', '000002'], 'share_name': ['one', 'two']}).to_csv(self.root/'universe_master.csv', index=False)
        for code in ['000001', '000002']:
            pd.DataFrame({'date': self.dates, 'adj_nav': 1., 'unit_nav': 1., 'source': 'offex_unit', 'adj_method': 'self_calc', 'freq': '日频'}).to_csv(self.root/'nav'/f'{code}.csv', index=False)
        pd.DataFrame({'date': self.dates, 'close': 100., 'kind': '全收益', 'source_code': 'H00300'}).to_csv(self.root/'bench'/'CSI300.csv', index=False)
        self.ingest()

    def ingest(self): return store.import_csvs(self.root, self.database, e.BENCHMARKS)

    def change(self, code, fn, ingest=True):
        path = self.root/'nav'/f'{code}.csv'; frame = pd.read_csv(path); fn(frame); frame.to_csv(path, index=False)
        if ingest: self.ingest()

    def config(self, **settings):
        p = e.profile(self.database, ['000001', '000002'], 'CSI300')
        return {'strategyTemplateId': 'strategy.fund_nav_fixed_dca', 'snapshotId': 'snapshot.fund_warehouse.nav_db.current', 'universe': 'manual_fund_share_basket',
            'benchmarkId': 'CSI300', 'portfolioRule': 'fixed_contribution_hold_adjusted_nav', 'rebalanceCalendar': settings.get('frequency', 'monthly'), 'costModel': 'subscription=0;slippage=0',
            'factorFamilyIds': [], 'factorWeights': [], 'strategySettings': {**e.DEFAULTS, 'startDate': '2020-01-01', 'endDate': '2020-03-31', 'shares': [{'shareCode': '000001', 'weight': .5}, {'shareCode': '000002', 'weight': .5}], 'sourceVersions': p['sourceVersions'], **settings}}

    def execute(self, config): return e.execute(self.database, config)

    def test_flat_flow_scaling_and_provenance(self):
        r = self.execute(self.config())
        self.assertAlmostEqual(r['metrics']['finalValue'], 30000)
        self.assertAlmostEqual(r['metrics']['moneyWeightedIrr'], 0, places=7)
        self.assertAlmostEqual(r['rows'][-1]['unitNav'], 1)
        self.assertAlmostEqual(self.execute(self.config(amount=20000))['metrics']['finalValue'], 60000)
        self.assertEqual(r['profile']['storage'], 'workbench_sqlite')
        self.assertEqual(r['profile']['funds'][0]['shareCode'], '000001')
        for file, v in zip([self.root/'universe_master.csv', self.root/'nav'/'000001.csv', self.root/'nav'/'000002.csv', self.root/'bench'/'CSI300.csv'], r['profile']['sourceVersions']):
            self.assertEqual(v['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())

    def test_database_independent_of_deleted_originals(self):
        c = self.config(); expected = self.execute(c)
        for file in self.root.glob('**/*.csv'): file.unlink()
        self.assertEqual(self.execute(c), expected)
        self.assertEqual(e.catalog(self.database, '000001')['items'][0]['shareCode'], '000001')

    def test_idempotency_and_literal_search(self):
        before = self.execute(self.config()); report = self.ingest()['lastImport']
        self.assertEqual(report['imported'], 0); self.assertEqual(report['skipped'], 4)
        self.assertEqual(self.execute(self.config()), before)
        for query in ['%', "' OR 1=1 --", '']: self.assertEqual(e.catalog(self.database, query)['items'], [])

    def test_fixed_weights_drift_close_purchase(self):
        self.change('000001', lambda f: f.loc.__setitem__((f.date >= '2020-01-15', 'adj_nav'), 2.))
        r = self.execute(self.config(endDate='2020-01-20'))
        self.assertEqual(r['rows'][0]['accountValue'], 10000)
        self.assertAlmostEqual(r['metrics']['finalValue'], 15000)
        self.assertAlmostEqual(r['rows'][-1]['fundValues']['000001'], 10000)
        self.assertAlmostEqual(r['rows'][-1]['fundValues']['000002'], 5000)

    def test_subscription_once_no_extra_annual_fee(self):
        c = self.config(); c['costModel'] = 'subscription=.01;slippage=.01'; r = self.execute(c)
        self.assertAlmostEqual(r['metrics']['finalValue'], 30000/1.02)
        self.assertAlmostEqual(r['metrics']['totalCost'], 30000-30000/1.02)
        self.assertAlmostEqual(r['rows'][0]['unitNav'], 1/1.02)
        self.assertEqual(r['metrics']['benchmarkFinalValue'], 30000)
        c['costModel'] = 'subscription=0;slippage=0;annual_fee=.01'
        with self.assertRaisesRegex(ValueError, 'no_extra_annual_fee'): self.execute(c)

    def test_common_calendar_no_fill_and_delay_guard(self):
        self.change('000001', lambda f: f.drop(f.index[f.date == '2020-01-06'], inplace=True))
        r = self.execute(self.config(startDate='2020-01-05'))
        self.assertEqual(r['cashFlows'][0]['date'], '2020-01-07')
        self.assertNotIn('2020-01-06', [row['date'] for row in r['rows']])
        self.assertGreater(r['calendarAudit']['sourceDateCounts']['000002'], r['calendarAudit']['commonDateCount'])
        self.change('000001', lambda f: f.drop(f.index[(f.date > '2020-01-01') & (f.date < '2020-01-30')], inplace=True))
        with self.assertRaisesRegex(ValueError, 'gap_exceeds_limit'): self.execute(self.config(startDate='2020-01-02'))

    def test_frequency_and_adjustment_enforced(self):
        self.change('000002', lambda f: (f.__setitem__('adj_method', 'hfq'), f.__setitem__('source', 'onex_hfq')))
        with self.assertRaisesRegex(ValueError, 'mixed_adjustment'): e.profile(self.database, ['000001','000002'], 'CSI300')
        self.change('000002', lambda f: (f.__setitem__('adj_method', 'self_calc'), f.__setitem__('source', 'offex_unit'), f.__setitem__('freq', '非日频')))
        with self.assertRaisesRegex(ValueError, 'unsupported_freq'): e.profile(self.database, ['000002'], 'CSI300')
        self.change('000002', lambda f: (f.__setitem__('freq', '日频'), f.drop(f.index[1:][np.arange(len(f)-1) % 10 != 0], inplace=True)))
        with self.assertRaisesRegex(ValueError, 'non_daily_actual_frequency'): e.profile(self.database, ['000002'], 'CSI300')

    def test_invalid_paths_database_symlink(self):
        for codes in [['../x'], [1], ['000001', '000001']]:
            with self.assertRaises(ValueError): e.profile(self.database, codes, 'CSI300')
        with self.assertRaises(ValueError): e.profile(self.database, ['000001'], '../../etc/passwd')
        link = self.root/'link.sqlite'; link.symlink_to(self.database)
        with self.assertRaisesRegex(ValueError, 'not_imported'): e.catalog(link, '')

    def test_bad_csv_isolated_previous_rows_preserved(self):
        before = self.execute(self.config())
        self.change('000001', lambda f: f.loc.__setitem__((0, 'adj_nav'), -1), ingest=False)
        report = self.ingest(); self.assertEqual(report['lastImport']['rejected'], 1)
        self.assertIn('invalid_positive', report['rejectedSample'][0]['message'])
        self.assertEqual(self.execute(self.config()), before)
        file = self.root/'nav'/'000001.csv'; file.unlink(); file.symlink_to(self.root/'nav'/'000002.csv')
        self.assertEqual(self.ingest()['lastImport']['rejected'], 1)

    def test_duplicates_isolated_and_universe_failure_not_silent(self):
        file = self.root/'nav'/'000001.csv'; f = pd.read_csv(file); pd.concat([f,f.iloc[:1]]).to_csv(file,index=False)
        self.assertEqual(self.ingest()['lastImport']['rejected'], 1)
        (self.root/'universe_master.csv').write_text('share_code,share_name\n000001,a\n000001,b\n')
        with self.assertRaisesRegex(ValueError, 'universe_import_failed'): self.ingest()
        db = store.open_reader(self.database)
        try: self.assertEqual(store.status(db)['lastImport']['status'], 'failed')
        finally: db.close()

    def test_coverage_internal_gap_boundaries(self):
        with self.assertRaisesRegex(ValueError, 'outside_common_coverage'): self.execute(self.config(endDate='2020-04-01'))
        self.change('000001', lambda f: f.drop(f.index[(f.date >= '2020-02-01') & (f.date <= '2020-02-20')], inplace=True))
        with self.assertRaisesRegex(ValueError, 'gap_exceeds_limit'): self.execute(self.config())

    def test_changes_apply_only_on_explicit_import_require_reload(self):
        c = self.config(); expected = self.execute(c)
        self.change('000001', lambda f: f.__setitem__('adj_nav', 2.), ingest=False)
        self.assertEqual(self.execute(c), expected); self.ingest()
        with self.assertRaisesRegex(ValueError, 'source_version_changed'): self.execute(c)
        self.assertEqual(self.execute(self.config())['metrics']['finalValue'], 30000)

    def test_future_values_do_not_change_past_calculation(self):
        first = self.execute(self.config(endDate='2020-01-31'))
        self.change('000001', lambda f: f.loc.__setitem__((f.date > '2020-01-31', 'adj_nav'), 9999))
        second = self.execute(self.config(endDate='2020-01-31'))
        self.assertEqual(first['rows'], second['rows']); self.assertEqual(first['metrics'], second['metrics'])

    def test_import_during_execution_does_not_mix_versions(self):
        c = self.config(); expected = self.execute(c); original = e.run
        def changed(*args):
            self.change('000001', lambda f: f.__setitem__('adj_nav', 2.)); return original(*args)
        with patch.object(e, 'run', side_effect=changed): self.assertEqual(self.execute(c), expected)
        with self.assertRaisesRegex(ValueError, 'source_version_changed'): self.execute(c)
        c['factorFamilyIds'] = ['library.fund.absolute_performance']
        with self.assertRaisesRegex(ValueError, 'historical_factor_selection_not_supported'): self.execute(c)

    def test_weekly_pending_price_kind(self):
        self.change('000001', lambda f: f.drop(f.index[f.date == '2020-02-05'], inplace=True))
        r = self.execute(self.config(startDate='2020-01-05', endDate='2020-02-05'))
        self.assertEqual(r['pendingContributions'][0]['scheduledDate'], '2020-02-05')
        weekly = self.execute(self.config(frequency='weekly'))
        self.assertGreater(weekly['metrics']['contributionCount'], r['metrics']['contributionCount'])
        file = self.root/'bench'/'CSI300.csv'; f = pd.read_csv(file); f['kind'] = '价格'; f.to_csv(file,index=False); self.ingest()
        self.assertIn('price_benchmark_not_total_return', self.execute(self.config())['warnings'])

    def test_truncated_rows_are_isolated_and_later_files_continue(self):
        (self.root/'nav'/'000001.csv').write_text('date,adj_nav,unit_nav,source,adj_method,freq\n2020-01-01\n')
        self.change('000002', lambda f: f.__setitem__('adj_nav', 2.), ingest=False)
        report = self.ingest()
        self.assertEqual(report['lastImport']['status'], 'completed_with_rejections')
        self.assertEqual(report['lastImport']['rejected'], 1); self.assertEqual(report['lastImport']['imported'], 1)
        self.assertIn('truncated_row', report['rejectedSample'][0]['message'])
        self.assertEqual(e.profile(self.database, ['000002'], 'CSI300')['funds'][0]['observations'], len(self.dates))

    def test_trailing_gap_rejected_and_small_gap_audited(self):
        self.change('000001', lambda f: f.drop(f.index[(f.date > '2020-03-02') & (f.date < '2020-03-31')], inplace=True))
        with self.assertRaisesRegex(ValueError, 'gap_exceeds_limit'): self.execute(self.config(endDate='2020-03-30'))
        r = self.execute(self.config(endDate='2020-03-03'))
        self.assertEqual(r['calendarAudit']['trailingGapDays'], 1)
        self.assertEqual(r['period'][1], '2020-03-02'); self.assertEqual(r['calendarAudit']['requestedPeriod'][1], '2020-03-03')


if __name__ == '__main__': unittest.main()
