import copy
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
from industry_engine import performance_attribution


class AttributionTest(unittest.TestCase):
    def ledger(self, returns, benchmark, exposures=None, fees=None, costs=None):
        nav, bench, rows = 1., 1., []
        for i,(gross,rb) in enumerate(zip(returns,benchmark)):
            exposure = exposures[i] if exposures is not None else 1.
            fee = fees[i] if fees else 0.; cost = costs[i] if costs else 0.
            before = nav; nav = before*(1+gross)-fee-cost; bench *= 1+rb
            rows.append({'date':f'2020-0{1+i//2}-{1+i%2:02d}','unitNav':nav,'benchmarkNav':bench,
                         'grossReturn':gross,'netReturn':nav/before-1,'openingExposure':exposure,
                         'managementFee':fee,'tradingCost':cost})
        return rows

    def closed(self, result):
        self.assertAlmostEqual(result['reconciliation']['error'],0,places=12)
        self.assertAlmostEqual(sum(row['total'] for row in result['monthly']),result['reconciliation']['actualTerminalExcess'],places=12)

    def test_identical_market_has_zero_excess(self):
        result=performance_attribution(self.ledger([.1,-.05,.03],[.1,-.05,.03]))
        self.closed(result);self.assertAlmostEqual(result['regression']['benchmarkBeta'],1)
        self.assertAlmostEqual(result['regression']['interceptPerObservation'],0)

    def test_cash_opportunity_cost_and_no_false_selection(self):
        result=performance_attribution(self.ledger([0,0,0],[.1,-.02,.04],[0,0,0]))
        self.closed(result); buckets={b['key']:b['value'] for b in result['buckets']}
        self.assertAlmostEqual(buckets['industrySelection'],0)
        self.assertAlmostEqual(buckets['cashExposure'],1-1.1*.98*1.04)

    def test_compound_link_not_sum_daily_excess(self):
        result=performance_attribution(self.ledger([.2,.1],[.1,.05]))
        self.closed(result);self.assertAlmostEqual(result['reconciliation']['actualTerminalExcess'],.165)
        self.assertNotAlmostEqual(result['reconciliation']['componentsTotal'],.15)

    def test_once_only_fees_and_initial_purchase_cost(self):
        result=performance_attribution(self.ledger([0,0],[0,0],[0,1],[0,.002],[.01,0]))
        self.closed(result);buckets={b['key']:b['value'] for b in result['buckets']}
        self.assertAlmostEqual(buckets['managementFee'],-.002);self.assertAlmostEqual(buckets['tradingCost'],-.01)
        self.assertAlmostEqual(result['reconciliation']['actualTerminalExcess'],-.012)

    def test_variable_exposure_partition(self):
        result=performance_attribution(self.ledger([0,.03,-.01],[0,.04,-.02],[0,.5,.5]))
        self.closed(result)
        day=result['daily'][1];self.assertAlmostEqual(day['components']['cashExposure'],-.02)
        self.assertAlmostEqual(day['components']['industrySelection'],.01)

    def test_ols_known_beta_intercept_and_residual_closure(self):
        x=[-.02,.01,.03,-.01,.005];y=[.001+1.5*r for r in x]
        result=performance_attribution(self.ledger(y,x));reg=result['regression']
        self.closed(result);self.assertAlmostEqual(reg['benchmarkBeta'],1.5)
        self.assertAlmostEqual(reg['interceptPerObservation'],.001);self.assertAlmostEqual(reg['rSquared'],1)
        self.assertAlmostEqual(reg['reconciliationError'],0,places=12)
        self.assertIsNone(result['smartBetaReturn']);self.assertIsNone(result['alphaReturn'])

    def test_regression_constant_benchmark_and_short_sample(self):
        for ledger in [self.ledger([.01,.02,.03],[0,0,0]),self.ledger([.01,.02],[0,.01])]:
            result=performance_attribution(ledger);self.closed(result)
            self.assertIsNone(result['regression']['benchmarkBeta']);self.assertEqual(result['regression']['buckets'],[])

    def test_bad_ledger_rejected_not_fabricated_residual(self):
        for key,value in [('netReturn',.5),('grossReturn',.5),('openingExposure',2),('unitNav',np.nan)]:
            rows=self.ledger([.01,.02],[0,.01]);rows[0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):performance_attribution(rows)
        with self.assertRaises(ValueError):performance_attribution([])

    def test_input_not_mutated(self):
        rows=self.ledger([0,.03,-.01],[0,.01,-.02]);before=copy.deepcopy(rows)
        performance_attribution(rows);self.assertEqual(rows,before)

    def test_future_changes_only_expost_links_not_past_components(self):
        rows=self.ledger([0,.03,-.01],[0,.01,-.02]);first=performance_attribution(rows)
        changed=self.ledger([0,.03,.1],[0,.01,.05]);second=performance_attribution(changed)
        self.assertEqual(first['daily'][1]['components'],second['daily'][1]['components'])
        self.assertNotEqual(first['daily'][1]['linkWeight'],second['daily'][1]['linkWeight'])


if __name__=='__main__':unittest.main()
