import copy
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'modules/factors/src'))
import three_bucket_engine as e


class ThreeBucketTest(unittest.TestCase):
    def fixture(self):
        dates = pd.date_range('2019-12-01', '2020-03-31')
        broad = pd.DataFrame({'date': dates, 'hs300_tr': 100., 'zz1000_tr': 100., 'hs300_px': 100., 'zz1000_px': 100., 'hs300_pe': 10., 'zz1000_pe': 10.})
        panel = pd.concat([pd.DataFrame({'date': dates, 'ind': code, 'ind_name': code, 'close': 100., 'pe': 10. * (i+1), 'pb': i+1., 'turnover': 1., 'amt_share': i+1., 'div_yield': 0.}) for i, code in enumerate(['0001', '0002', '0003'])], ignore_index=True)
        months = pd.date_range('2018-01-01', '2020-03-01', freq='MS').strftime('%Y年%m月份')
        return {'broad': broad, 'bench': broad[['date', 'hs300_tr']], 'panel': panel,
            'investable': pd.DataFrame({'ind_name': ['0001', '0002', '0003'], 'first_investable': pd.Timestamp('2018-01-01')}),
            'basis': pd.DataFrame({'date': dates, 'basis_pct': np.linspace(0, 1, len(dates))}),
            'pmi': pd.DataFrame({e.MONTH_FIELD: months, e.PMI_FIELD: 50.}), 'm2': pd.DataFrame({e.MONTH_FIELD: months, e.M2_FIELD: 8.}),
            'shibor': pd.DataFrame({e.SHIBOR_DATE: dates, e.SHIBOR_FIELD: 2.})}

    def config(self, **settings):
        return {'strategyTemplateId': 'strategy.legacy_three_bucket_monthly', 'universe': 'broad_index_or_industry_proxy', 'benchmarkId': 'hs300_total_return',
            'rebalanceCalendar': 'monthly', 'portfolioRule': 'monthly_three_bucket_lagged_signals', 'costModel': 'commission=0;slippage=0;annual_fee=0',
            'factorFamilyIds': ['library.industry.value'], 'factorWeights': [{'factorFamilyId': 'library.industry.value', 'weight': 1}],
            'strategySettings': {**e.DEFAULTS, 'startDate': '2020-01-01', 'endDate': '2020-03-31', 'minInvestable': 3, 'topN': 1,
                'peLookback': 3, 'peMinObservations': 2, 'basisLookback': 3, 'basisMinObservations': 2, 'macroLookbackMonths': 3, 'macroMinObservations': 2,
                'cashRate': 0, 'bondRate': 0, 'broadAnnualFee': 0, 'sectorAnnualFee': 0, **settings}}

    def test_flat_prices_flows_not_returns_and_scaling(self):
        r = e.run(self.fixture(), self.config())
        self.assertAlmostEqual(r['metrics']['finalValue'], 30000)
        self.assertAlmostEqual(r['rows'][-1]['unitNav'], 1)
        self.assertAlmostEqual(r['metrics']['moneyWeightedIrr'], 0, places=7)
        scaled = e.run(self.fixture(), self.config(amount=20000))
        self.assertAlmostEqual(scaled['metrics']['finalValue'], 2*r['metrics']['finalValue'])
        self.assertAlmostEqual(scaled['rows'][-1]['unitNav'], r['rows'][-1]['unitNav'])

    def test_a_fixed_prebuy_budget_split(self):
        r = e.run(self.fixture(), self.config(bucketA=1, bucketB=0, bucketC=0, endDate='2020-01-02'))
        self.assertAlmostEqual(r['rows'][0]['sleeveCash']['A'], 0)
        self.assertAlmostEqual(r['sleeveMetrics'][0]['finalValue'], 10000)
        self.assertEqual(r['decisions'][0]['signalDate'], '2019-12-31')
        self.assertIsNone(r['sleeveMetrics'][1]['annualizedReturn'])
        self.assertIsNone(r['sleeveMetrics'][1]['activeStartDate'])

    def test_a_gate_cash_then_release_and_missing_policy(self):
        f = self.fixture()
        f['broad'].loc[f['broad'].date == '2019-12-31', ['hs300_pe', 'zz1000_pe']] = 100
        r = e.run(f, self.config(bucketA=1, bucketB=0, bucketC=0, peGate=.5))
        self.assertAlmostEqual(r['rows'][0]['cash'], 10000)
        self.assertAlmostEqual(next(row['cash'] for row in r['rows'] if row['date'] == '2020-02-01'), 0)
        f['broad'][['hs300_pe', 'zz1000_pe']] = np.nan
        cash = e.run(f, self.config(bucketA=1, bucketB=0, bucketC=0, missingPePolicy='hold_cash'))
        self.assertAlmostEqual(cash['rows'][-1]['cash'], 30000)
        opened = e.run(f, self.config(bucketA=1, bucketB=0, bucketC=0))
        self.assertAlmostEqual(opened['rows'][-1]['cash'], 0)
        self.assertIn('pe_missing_or_warmup_policy_applied', opened['warnings'])

    def test_b_new_flows_redirect_and_old_positions_kept(self):
        f = self.fixture()
        f['panel'].loc[(f['panel'].date >= '2020-01-31') & (f['panel'].ind != '0001'), ['pb', 'pe']] = np.nan
        r = e.run(f, self.config(bucketA=0, bucketB=1, bucketC=0))
        self.assertTrue(r['decisions'][0]['bActive'])
        self.assertFalse(r['decisions'][1]['bActive'])
        self.assertEqual(r['decisions'][1]['redirectBToA'], 10000)
        self.assertAlmostEqual(r['rows'][-1]['sleeveValues']['B'], 10000)
        self.assertEqual(r['decisions'][1]['holdingCodes'], ['0001'])
        self.assertEqual(r['decisions'][1]['holdingNames'], ['0001'])
        self.assertAlmostEqual(r['decisions'][1]['holdingCash'], 0)

    def test_b_forced_exit_blacklist(self):
        r = e.run(self.fixture(), self.config(bucketA=0, bucketB=1, bucketC=0, holdingLimitMonths=1))
        self.assertEqual(r['decisions'][0]['codes'], ['0001'])
        self.assertEqual(r['decisions'][1]['forcedCodes'], ['0001'])
        self.assertNotIn('0001', r['decisions'][1]['codes'])

    def test_post_cost_rebalance_conserves_cash(self):
        sleeve = e.Sleeve(.01); sleeve.cash = 10000
        sleeve.rebalance({'a': .5, 'b': .5}, pd.Timestamp('2020-01-01'))
        self.assertAlmostEqual(sleeve.holdings['a'], sleeve.holdings['b'])
        self.assertAlmostEqual(sleeve.value() + sleeve.trading_cost, 10000)
        sleeve.rebalance({'b': .5, 'c': .5}, pd.Timestamp('2020-02-01'))
        self.assertNotIn('a', sleeve.holdings)
        self.assertAlmostEqual(sleeve.holdings['b'], sleeve.holdings['c'])
        self.assertAlmostEqual(sleeve.value() + sleeve.trading_cost, 10000)
        self.assertGreaterEqual(sleeve.cash, -1e-6)

    def test_holding_limit_short_month_explicit_policy(self):
        f = self.fixture()
        f['panel'].loc[(f['panel'].date >= '2020-01-31') & (f['panel'].ind == '0002'), ['pe', 'pb']] = [.1, .1]
        old = e.run(f, self.config(holdingLimitMonths=1))
        self.assertIn('0002', old['decisions'][2]['codes'])
        calendar = e.run(f, self.config(holdingLimitMonths=1, holdingLimitPolicy='calendar_months'))
        self.assertIn('0002', calendar['decisions'][2]['forcedCodes'])
        self.assertNotIn('0002', calendar['decisions'][2]['codes'])

    def test_c_interest_once_calendar_days(self):
        f = self.fixture(); f['basis']['basis_pct'] = np.nan
        f['pmi'][e.PMI_FIELD] = np.nan; f['m2'][e.M2_FIELD] = np.nan; f['shibor'][e.SHIBOR_FIELD] = np.nan
        r = e.run(f, self.config(bucketA=0, bucketB=0, bucketC=1, neutralEquity=0, bondRate=.1))
        expected = sum(10000 * 1.1 ** ((pd.Timestamp('2020-03-31') - pd.Timestamp(d)).days / 365.25) for d in ['2020-01-01', '2020-02-01', '2020-03-01'])
        self.assertAlmostEqual(r['metrics']['finalValue'], expected, places=7)
        self.assertEqual(r['rows'][0]['accountValue'], 10000)
        self.assertEqual(r['decisions'][0]['timing']['fallback'], 'configured_neutral')

    def test_fees_once_and_first_close_buy(self):
        c = self.config(bucketA=1, bucketB=0, bucketC=0, endDate='2020-01-31', broadAnnualFee=.1)
        c['costModel'] = 'commission=.01;slippage=0;annual_fee=0'
        r = e.run(self.fixture(), c)
        self.assertAlmostEqual(r['rows'][0]['accountValue'], 9900)
        self.assertAlmostEqual(r['metrics']['finalValue'], 9900 * .9 ** (30/365.25), places=7)
        self.assertAlmostEqual(r['rows'][0]['unitNav'], .99)
        self.assertEqual(r['rows'][0]['benchmarkValue'], 10000)

    def test_macro_calendar_lags_and_shibor_no_future_month(self):
        f = self.fixture(); s = e.validate(self.config())
        f['m2'] = pd.DataFrame({e.MONTH_FIELD: ['2019年11月份', '2020年01月份'], e.M2_FIELD: [1., 8.]})
        records = e.macro_signals(f, s)
        jan = next(row for row in records if row['component'] == 'm2' and row['sourceMonth'] == pd.Timestamp('2020-01-01'))
        self.assertEqual(jan['availableAt'], pd.Timestamp('2020-03-01'))
        shibor = next(row for row in records if row['component'] == 'shibor' and row['sourceMonth'] == pd.Timestamp('2020-01-01'))
        self.assertEqual(shibor['availableAt'], pd.Timestamp('2020-02-01'))
        basis = pd.DataFrame({'signal': [np.nan]}, index=[pd.Timestamp('2020-01-01')])
        timing = e.timing_on(records, basis, pd.Timestamp('2020-01-15'), s)
        self.assertIsNone(next(row for row in timing['components'] if row['component'] == 'shibor')['score'])

    def test_stale_signals_use_explicit_neutral(self):
        s = e.validate(self.config(maxMacroAgeDays=1, maxBasisAgeDays=1, neutralEquity=.3))
        records = [{'component': 'pmi', 'sourceMonth': pd.Timestamp('2019-12-01'), 'availableAt': pd.Timestamp('2020-01-01'), 'score': 1.}]
        basis = pd.DataFrame({'signal': [1.]}, index=[pd.Timestamp('2020-01-01')])
        r = e.timing_on(records, basis, pd.Timestamp('2020-02-01'), s)
        self.assertEqual(r['equityRatio'], .3); self.assertEqual(r['basisStatus'], 'stale')

    def test_future_changes_do_not_change_past(self):
        f = self.fixture(); c = self.config(endDate='2020-01-31')
        first = e.run(f, c)
        f['broad'].loc[f['broad'].date > '2020-01-31', ['hs300_tr', 'hs300_pe']] = 9999
        f['panel'].loc[f['panel'].date > '2020-01-31', ['close', 'pb']] = 9999
        f['shibor'].loc[f['shibor'][e.SHIBOR_DATE] >= '2020-01-01', e.SHIBOR_FIELD] = 9999
        second = e.run(f, c)
        self.assertEqual(first['rows'], second['rows']); self.assertEqual(first['decisions'], second['decisions'])

    def test_reject_unsupported_and_invalid_sources(self):
        for override in [{'bucketA': .7}, {'m2LagMonths': 1}, {'shiborLagMonths': 0}, {'signalLagDays': 0}, {'extra': 1}]:
            with self.assertRaises(ValueError): e.validate(self.config(**override))
        c = self.config(); c['costModel'] = 'commission=0;slippage=0;annual_fee=.01'
        with self.assertRaisesRegex(ValueError, 'annual_fee_use_sleeve'): e.validate(c)
        f = self.fixture(); f['broad'].loc[f['broad'].date == '2020-01-15', 'hs300_tr'] = np.nan
        with self.assertRaisesRegex(ValueError, 'price_or_benchmark_gap'): e.run(f, self.config())
        f = self.fixture(); f['panel'] = f['panel'][~((f['panel'].date == '2020-01-15') & (f['panel'].ind == '0001'))]
        with self.assertRaisesRegex(ValueError, 'held_industry_quote_gap'): e.run(f, self.config(bucketA=0, bucketB=1, bucketC=0))

    def test_exact_source_hashes_and_inflight_change_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            paths = []
            for key, frame in self.fixture().items():
                p = Path(root) / (key + '.parquet'); frame.to_parquet(p); paths.append(str(p))
            result = e.execute(paths, self.config())
            for file, version in zip(paths, result['sourceVersions']): self.assertEqual(version['sha256'], hashlib.sha256(Path(file).read_bytes()).hexdigest())
            original = e.run
            def changed(frames, config):
                result = original(frames, config); Path(paths[-1]).write_bytes(b'changed'); return result
            with patch.object(e, 'run', side_effect=changed):
                with self.assertRaisesRegex(ValueError, 'source_changed_retry'): e.execute(paths, self.config())

    def test_explicit_common_calendar_rejects_whole_missing_month(self):
        f = self.fixture(); f['panel'] = f['panel'][f['panel'].date != '2020-01-01']
        r = e.run(f, self.config())
        self.assertEqual(r['calendarAudit']['excludedBroadDates'], ['2020-01-01'])
        self.assertEqual(r['cashFlows'][0]['date'], '2020-01-02')
        self.assertAlmostEqual(r['metrics']['finalValue'], 30000)
        f['panel'] = f['panel'][~f['panel'].date.between('2020-02-01', '2020-02-29')]
        with self.assertRaisesRegex(ValueError, 'month_missing_common_calendar'): e.run(f, self.config())


if __name__ == '__main__':
    unittest.main()
