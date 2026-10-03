import copy
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'modules/factors/src'))
import dca_engine as dca
import fund_nav_engine as fund
import factor_dca_test as dca_fixtures
import factor_three_bucket_test as abc_fixtures


class CashflowAttributionTest(unittest.TestCase):
    def row(self, date, value, benchmark, contributed, **inputs):
        defaults = {'openingValue': 0., 'openingBenchmarkValue': 0., 'openingCash': 0., 'cashIncome': 0.,
            'assets': {'asset:x': {'openingValue': 0., 'grossPnl': 0.}}, 'benchmarkReturn': 0.,
            'deposit': 0., 'managementFee': 0., 'benchmarkManagementFee': 0., 'tradingCost': 0., 'benchmarkTradingCost': 0.}
        return {'date': date, 'accountValue': value, 'benchmarkValue': benchmark, 'contributed': contributed, 'attributionInputs': {**defaults, **inputs}}

    def fixture(self):
        return [self.row('2020-01-30', 100., 100., 100., deposit=100.),
            self.row('2020-01-31', 160., 159., 150., openingValue=100., openingBenchmarkValue=100., openingCash=40.,
                cashIncome=1., assets={'asset:x': {'openingValue': 60., 'grossPnl': 12.}}, benchmarkReturn=.1, deposit=50.,
                managementFee=2., benchmarkManagementFee=1., tradingCost=1.),
            self.row('2020-02-01', 149., 190.8, 150., openingValue=160., openingBenchmarkValue=159., openingCash=50.,
                assets={'asset:x': {'openingValue': 110., 'grossPnl': -11.}}, benchmarkReturn=.2)]

    def closed(self, result):
        a = result['attribution']; r = a['reconciliation']
        self.assertAlmostEqual(r['actualTerminalExcessValue'], result['metrics']['finalValue']-result['metrics']['benchmarkFinalValue'], places=6)
        self.assertAlmostEqual(sum(x['value'] for x in a['buckets']), r['actualTerminalExcessValue'], places=6)
        self.assertAlmostEqual(sum(x['total'] for x in a['monthly']), r['actualTerminalExcessValue'], places=6)
        self.assertAlmostEqual(r['strategyProfit'], result['metrics']['finalValue']-result['metrics']['totalContributed'], places=6)
        self.assertIsNone(a['alphaReturn']); self.assertIsNone(a['smartBetaReturn'])

    def test_known_hand_calculated_daily_components(self):
        a = dca.cashflow_attribution(self.fixture())
        self.assertEqual(a['daily'][1]['components'], {'asset:x': 6., 'cashExposure': -3., 'wealthDifferenceCarry': 0., 'managementFee': -1., 'tradingCost': -1.})
        self.assertAlmostEqual(a['daily'][2]['components']['wealthDifferenceCarry'], .2)
        self.assertAlmostEqual(a['reconciliation']['actualTerminalExcessValue'], -41.8)
        self.assertAlmostEqual(a['reconciliation']['strategyProfit'], -1.)
        self.assertAlmostEqual(a['reconciliation']['benchmarkProfit'], 40.8)

    def test_monthly_amounts_are_additive_and_deposits_not_returns(self):
        a = dca.cashflow_attribution(self.fixture())
        self.assertEqual(a['unit'], 'account_currency')
        self.assertEqual(a['monthly'][0]['deposit'], 150.)
        self.assertAlmostEqual(a['monthly'][0]['total'], 1.)
        self.assertAlmostEqual(a['monthly'][1]['total'], -42.8)
        self.assertAlmostEqual(sum(m['total'] for m in a['monthly']), a['reconciliation']['actualTerminalExcessValue'])
        rows = [self.row('2020-01-01', 100, 100, 100, deposit=100),
            self.row('2020-02-01', 200, 200, 200, deposit=100, openingValue=100, openingBenchmarkValue=100, openingCash=100)]
        self.assertEqual(dca.cashflow_attribution(rows)['reconciliation']['strategyProfit'], 0.)

    def test_first_purchase_cost_carry_not_double_counted(self):
        rows = [self.row('2020-01-01', 99., 100., 100., deposit=100., tradingCost=1.),
            self.row('2020-01-02', 108.9, 110., 100., openingValue=99., openingBenchmarkValue=100.,
                assets={'asset:x': {'openingValue': 99., 'grossPnl': 9.9}}, benchmarkReturn=.1)]
        buckets = {b['key']: b['value'] for b in dca.cashflow_attribution(rows)['buckets']}
        self.assertAlmostEqual(buckets['tradingCost'], -1.)
        self.assertAlmostEqual(buckets['wealthDifferenceCarry'], -.1)
        self.assertAlmostEqual(sum(buckets.values()), -1.1)

    def test_no_global_future_link_weights_or_input_mutation(self):
        rows = self.fixture(); original = copy.deepcopy(rows)
        a = dca.cashflow_attribution(rows)
        self.assertEqual(rows, original)
        prefix = dca.cashflow_attribution(rows[:2])
        self.assertEqual(a['daily'][:2], prefix['daily'])
        self.assertEqual(a['monthly'][0], prefix['monthly'][0])

    def test_rejects_empty_nonfinite_negative_cost_and_duplicate_date(self):
        with self.assertRaisesRegex(ValueError, 'empty_ledger'): dca.cashflow_attribution([])
        for key, value in [('benchmarkReturn', float('nan')), ('managementFee', -1.), ('deposit', -1.), ('benchmarkReturn', -1.)]:
            rows = self.fixture(); rows[0]['attributionInputs'][key] = value
            with self.assertRaises(ValueError): dca.cashflow_attribution(rows)
        rows = self.fixture(); rows[1]['date'] = rows[0]['date']
        with self.assertRaisesRegex(ValueError, 'dates_not_increasing'): dca.cashflow_attribution(rows)

    def test_rejects_broken_capital_flow_and_benchmark_ledgers(self):
        for mutate in [lambda r: r[1].update(accountValue=161.), lambda r: r[1].update(benchmarkValue=160.),
                lambda r: r[1].update(contributed=151.), lambda r: r[1]['attributionInputs'].update(openingValue=101.),
                lambda r: r[1]['attributionInputs'].update(openingCash=41.)]:
            rows = self.fixture(); mutate(rows)
            with self.assertRaisesRegex(ValueError, 'not_closed'): dca.cashflow_attribution(rows)

    def test_broad_same_target_and_costs_have_zero_relative_contribution(self):
        f = dca_fixtures.DcaEngineTest(); config = f.config(); config['costModel'] = 'commission=.01;slippage=.02;broad_fee=.05'
        result = dca.run(f.flat(), config); self.closed(result)
        self.assertAlmostEqual(result['attribution']['reconciliation']['componentsTotal'], 0.)

    def test_broad_cash_and_multiple_prices_scale_amount_not_irr(self):
        f = dca_fixtures.DcaEngineTest(); frame = f.flat()
        frame['hs300_tr'] = np.linspace(100., 120., len(frame)); frame['zz1000_tr'] = np.linspace(100., 90., len(frame))
        config = f.config(cashBucketPolicy='broad_split_cash', bucket={'A': .3, 'B': .4, 'C': .3})
        config['costModel'] = 'commission=.01;slippage=0;broad_fee=.02'
        result = dca.run(frame, config); self.closed(result)
        scaled = copy.deepcopy(config); scaled['transactionSettings']['amount'] *= 2
        double = dca.run(frame, scaled); self.closed(double)
        self.assertAlmostEqual(double['metrics']['moneyWeightedIrr'], result['metrics']['moneyWeightedIrr'])
        for a, b in zip(result['attribution']['buckets'], double['attribution']['buckets']): self.assertAlmostEqual(a['value']*2, b['value'])
        self.assertNotEqual(result['attribution']['buckets'][0]['value'], 0.)

    def test_broad_pending_deposit_does_not_enter_profit(self):
        f = dca_fixtures.DcaEngineTest(); frame = f.flat(); frame = frame[frame.date.dt.dayofweek < 5]
        result = dca.run(frame, f.config(startDate='2020-01-29', endDate='2020-02-29'))
        self.closed(result); self.assertEqual(result['attribution']['reconciliation']['totalContributed'], 100.)
        self.assertEqual(len(result['pendingContributions']), 1)

    def fund_run(self, cost, second_weight=.4):
        dates = pd.bdate_range('2020-01-01', '2020-03-31')
        data = pd.DataFrame({'000001': np.linspace(1., 1.2, len(dates)), '000002': np.linspace(1., .9, len(dates)), 'benchmark': np.linspace(100., 110., len(dates))}, index=dates)
        config = {'strategyTemplateId': 'strategy.fund_nav_fixed_dca', 'snapshotId': 'snapshot.fund_warehouse.nav_db.current', 'universe': 'manual_fund_share_basket',
            'portfolioRule': 'fixed_contribution_hold_adjusted_nav', 'rebalanceCalendar': 'monthly', 'benchmarkId': 'CSI300', 'costModel': cost,
            'strategySettings': {**fund.DEFAULTS, 'startDate': '2020-01-01', 'endDate': '2020-03-31', 'shares': [{'shareCode': '000001', 'weight': .6}, {'shareCode': '000002', 'weight': second_weight}], 'sourceVersions': []}}
        return fund.run(data, {'sourceVersions': [], 'benchmark': {'kind': '全收益'}, 'adjustmentMethod': 'self_calc'}, {key: data[key] for key in data}, config)

    def test_fund_embedded_fee_not_deducted_again_and_gross_benchmark(self):
        result = self.fund_run('subscription=.01;slippage=.01'); self.closed(result)
        buckets = {x['key']: x['value'] for x in result['attribution']['buckets']}
        self.assertEqual(buckets['managementFee'], 0.)
        self.assertAlmostEqual(buckets['tradingCost'], -result['metrics']['totalCost'])
        self.assertTrue({'fund:000001', 'fund:000002'} <= buckets.keys())

    def test_three_bucket_buy_sell_redirect_and_interest_close(self):
        f = abc_fixtures.ThreeBucketTest(); frame = f.fixture()
        frame['broad']['hs300_tr'] = np.linspace(100., 125., len(frame['broad']))
        frame['panel']['close'] *= np.tile(np.linspace(1., 1.1, len(frame['broad'])), 3)
        config = f.config(holdingLimitMonths=1, cashRate=.018, bondRate=.03, broadAnnualFee=.005, sectorAnnualFee=.006)
        config['costModel'] = 'commission=.001;slippage=.002;annual_fee=0'
        result = abc_fixtures.e.run(frame, config); self.closed(result)
        buckets = {x['key']: x['value'] for x in result['attribution']['buckets']}
        self.assertTrue({'sleeve:A', 'sleeve:B', 'sleeve:C'} <= buckets.keys())
        self.assertAlmostEqual(buckets['managementFee'], -result['rows'][-1]['managementFee'], places=7)
        self.assertAlmostEqual(buckets['tradingCost'], -result['rows'][-1]['tradingCost'], places=7)
        self.assertTrue(any(r['attributionInputs']['cashIncome'] > 0 for r in result['rows']))

    def test_three_bucket_all_cash_model_income_is_not_deposit_income(self):
        f = abc_fixtures.ThreeBucketTest(); frame = f.fixture(); frame['basis']['basis_pct'] = np.nan
        for kind, field in [('pmi', abc_fixtures.e.PMI_FIELD), ('m2', abc_fixtures.e.M2_FIELD), ('shibor', abc_fixtures.e.SHIBOR_FIELD)]: frame[kind][field] = np.nan
        result = abc_fixtures.e.run(frame, f.config(bucketA=0, bucketB=0, bucketC=1, neutralEquity=0, bondRate=.1)); self.closed(result)
        self.assertEqual(result['attribution']['daily'][0]['strategyProfit'], 0.)
        self.assertAlmostEqual(sum(d['inputs']['cashIncome'] for d in result['attribution']['daily']), result['metrics']['finalValue']-30000., places=7)

    def test_large_identical_accounts_retain_roundoff_without_blocking(self):
        f = dca_fixtures.DcaEngineTest(); dates = pd.date_range('2020-01-01', '2020-03-31')
        prices = 100*np.exp(np.cumsum(np.random.default_rng(3103).normal(0, .01, len(dates))))
        result = dca.run(pd.DataFrame({'date': dates, 'hs300_tr': prices}), f.config(endDate='2020-03-31', amount=1e9))
        a = result['attribution']; self.assertEqual(a['reconciliation']['actualTerminalExcessValue'], 0.)
        self.assertLessEqual(abs(a['reconciliation']['error']), a['reconciliation']['errorBound'])
        self.assertTrue(any(abs(d['error']) > 1e-7 for d in a['daily']))
        broken = copy.deepcopy(result['rows']); broken[1]['accountValue'] += 1.
        with self.assertRaisesRegex(ValueError, 'not_closed'): dca.cashflow_attribution(broken)

    def test_near_unit_weights_normalized_for_all_three_engines(self):
        f = dca_fixtures.DcaEngineTest()
        broad = dca.run(f.flat(), f.config(cashBucketPolicy='broad_split_cash', bucket={'A': .6, 'B': .2, 'C': .200000005}))
        self.closed(broad); self.assertAlmostEqual(sum(broad['weights'].values()), 1.)
        result = self.fund_run('subscription=0;slippage=0', second_weight=.400000005); self.closed(result)
        self.assertAlmostEqual(sum(result['allocationWeights'].values()), 1.)
        abc = abc_fixtures.ThreeBucketTest(); config = abc.config(bucketC=.200000005); original = copy.deepcopy(config)
        result = abc_fixtures.e.run(abc.fixture(), config); self.closed(result); self.assertEqual(config, original)
        self.assertAlmostEqual(sum(result['cashFlows'][0]['allocations'].values()), 10000.)

    def test_material_weight_errors_rejected_not_hidden_by_closure_tolerance(self):
        f = dca_fixtures.DcaEngineTest()
        with self.assertRaisesRegex(ValueError, 'bucket_weights'): dca.run(f.flat(), f.config(cashBucketPolicy='broad_split_cash', bucket={'A': .6, 'B': .2, 'C': .2001}))
        with self.assertRaisesRegex(ValueError, 'weights_must_sum_one'): self.fund_run('subscription=0;slippage=0', second_weight=.4001)
        abc = abc_fixtures.ThreeBucketTest()
        with self.assertRaisesRegex(ValueError, 'weights_or_top_n'): abc_fixtures.e.run(abc.fixture(), abc.config(bucketC=.2001))


if __name__ == '__main__': unittest.main()
