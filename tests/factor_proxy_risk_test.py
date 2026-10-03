import copy
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
import industry_engine as engine
import factor_expression_test as fixtures


class ProxyRiskTest(unittest.TestCase):
    def ledger(self, returns, benchmark):
        nav = b = 1.; rows = []
        for date, r, rb in zip(pd.date_range('2020-01-01', periods=len(returns)), returns, benchmark):
            nav *= 1+r; b *= 1+rb
            rows.append({'date': date.date().isoformat(), 'unitNav': nav, 'benchmarkNav': b, 'netReturn': float(r),
                         'grossReturn': float(r), 'openingExposure': 1., 'managementFee': 0., 'tradingCost': 0.})
        return rows

    def fixture(self):
        t = np.arange(80); rb = .01*np.sin(t); f = .006*np.cos(t*.71); g = .004*np.sin(t*.23)
        y = .0002 + .3*rb + .7*f - .2*g
        return self.ledger(rb+y,rb), {'value': self.ledger(rb+f,rb), 'momentum': self.ledger(rb+g,rb)}

    def test_known_loadings_and_two_closures(self):
        rows, proxies = self.fixture(); r = engine.proxy_risk_model(rows, proxies)
        self.assertEqual(r['status'], 'computed_proxy_multifactor_diagnostic')
        np.testing.assert_allclose([v['coefficient'] for v in r['loadings']], [.3,.7,-.2], atol=1e-12)
        self.assertAlmostEqual(r['interceptPerObservation'], .0002, places=12)
        self.assertAlmostEqual(r['reconciliation']['terminalExcessError'], 0, places=12)
        self.assertAlmostEqual(r['reconciliation']['varianceError'], 0, places=12)
        self.assertIsNone(r['alphaReturn']); self.assertIsNone(r['smartBetaReturn'])

    def test_variance_direct_calculation_and_residual(self):
        rows, proxies = self.fixture(); r = engine.proxy_risk_model(rows, proxies)
        y = [d['excessReturn'] for d in r['daily']]
        self.assertAlmostEqual(r['annualizedTrackingVariance'], np.var(y,ddof=1)*244, places=12)
        self.assertLess(max(abs(d['components']['model_residual']) for d in r['daily']), 1e-12)

    def test_duplicate_proxies_refuse_individual_loadings(self):
        rows, proxies = self.fixture(); proxies['duplicate'] = proxies['value']
        r = engine.proxy_risk_model(rows, proxies)
        self.assertEqual(r['reason'], 'collinear_or_ill_conditioned_proxies'); self.assertNotIn('loadings',r)

    def test_reserved_model_names_are_namespaced(self):
        rows, proxies = self.fixture()
        for name in ['market_relative','sample_intercept','model_residual']:
            r = engine.proxy_risk_model(rows,{name:proxies['value'],'other':proxies['momentum']})
            self.assertEqual(r['status'],'computed_proxy_multifactor_diagnostic')
            self.assertIn('proxy:'+name,[row['key'] for row in r['loadings']])

    def test_failed_variant_preserves_baseline_and_explicit_failure(self):
        fixture = fixtures.ExpressionTest()
        p = {'top':1,'minimum':3,'lag':1,'rates':{'commission':0.,'slippage':0.,'annual_fee':0.}}
        with patch.object(engine,'simulate',side_effect=ValueError('industry_held_quote_missing')):
            cases = engine.sensitivity_runs(None,None,None,p,{'metrics':{'finalValue':1.}})
        self.assertTrue(all(c['status']=='unavailable' and c['error']=='industry_held_quote_missing' for c in cases))
        self.assertTrue(all('finalValue' not in c for c in cases))

    def test_large_program_keeps_baseline_but_refuses_partial_proxy_model(self):
        fixture = fixtures.ExpressionTest(); spec=fixture.spec()
        spec['nodes']=[{**spec['nodes'][0],'id':f'node_{i}'} for i in range(9)]
        import custom_industry_engine
        r = custom_industry_engine.run(*fixture.data(),fixture.config(spec))
        self.assertEqual(r['metrics']['finalValue'],1.)
        self.assertEqual(r['riskModel']['reason'],'proxy_budget_exceeded')
        self.assertEqual(r['riskModel']['maxProxyOutputs'],8)

    def test_constant_market_refuses(self):
        rows = self.ledger(np.ones(30)*.001,np.zeros(30))
        self.assertEqual(engine.proxy_risk_model(rows, {})['reason'], 'constant_proxy')

    def test_short_calendar_and_bad_input(self):
        rows, proxies = self.fixture()
        self.assertEqual(engine.proxy_risk_model(rows[:3], {k:v[:3] for k,v in proxies.items()})['reason'], 'insufficient_observations')
        proxies['value'][0]['date'] = '1900-01-01'
        with self.assertRaisesRegex(ValueError,'calendar'): engine.proxy_risk_model(rows,proxies)

    def test_custom_sensitivity_actual_reruns_and_immutable_config(self):
        fixture = fixtures.ExpressionTest(); config = fixture.config(); before = copy.deepcopy(config)
        config['costModel'] = 'commission=.01;slippage=0;annual_fee=0'
        import custom_industry_engine
        r = custom_industry_engine.run(*fixture.data(),config)
        cases = {c['case']:c for c in r['sensitivity']}
        self.assertAlmostEqual(cases['zero_cost']['finalValue'],1.)
        self.assertAlmostEqual(cases['double_trade_cost']['finalValue'],.98)
        self.assertEqual(cases['signal_lag_plus_one']['parameterChanges'], {'lag':2})
        self.assertEqual(config['strategySettings'],before['strategySettings'])
        self.assertEqual(r['riskModel']['reason'],'constant_proxy')


if __name__ == '__main__': unittest.main()
