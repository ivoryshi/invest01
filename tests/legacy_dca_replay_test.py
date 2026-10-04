import copy
import json
import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'modules/factors/src'))
import legacy_dca_engine as engine


class ReplayTest(unittest.TestCase):
    def fixture(self):
        dates = [int(d.strftime('%Y%m%d')) for d in pd.bdate_range('2020-01-15', '2020-04-30')]
        pe_dates = [int(d.strftime('%Y%m%d')) for d in pd.bdate_range('2018-01-01', '2020-05-31')]
        base = {'D':dates,'C':[100.]*len(dates),'A':[200.]*len(dates),'V':[100.]*len(dates)}
        pe = {'D':pe_dates, **{key:[10.]*len(pe_dates) for key in ['TTM','LYR','MED']}}
        p = copy.deepcopy(engine.DEFAULTS);p.update(startMonth='2020-02',endMonth='2020-04',fee=0,slippage=0,cashRate=0)
        return base,pe,p

    def test_strict_json_extraction_never_executes_script(self):
        base,pe,_=self.fixture()
        html=f'<script>const BASE = {json.dumps(base)}; const PE = {json.dumps(pe)}; throw new Error("must not run");</script>'.encode()
        self.assertEqual(engine.load(html),(base,pe))
        with self.assertRaises(ValueError):engine.load(b'<script>const BASE = (globalThis.bad(), {});</script>')
        base['D'][1]=base['D'][0]
        with self.assertRaises(ValueError):engine.load(f'<script>const BASE = {json.dumps(base)};const PE = {json.dumps(pe)};</script>'.encode())

    def test_signals_use_strictly_prior_observation_and_future_changes_do_not_change_past(self):
        base,pe,p=self.fixture();p['endMonth']='2020-03'
        result=engine.replay(base,pe,p)
        self.assertTrue(all(row['signalDate'] < row['date'] for row in result['trades']))
        for i,date in enumerate(pe['D']):
            if date>=20200401:pe['TTM'][i]=.1
        other=engine.replay(base,pe,p)
        self.assertEqual(result,other)

    def test_pool_pause_keeps_same_contributions_and_interest(self):
        base,pe,p=self.fixture();p['cashRate']=.02
        result=engine.replay(base,pe,p)
        self.assertTrue(all(row['spend']==0 and row['status']=='pause' for row in result['trades']))
        self.assertEqual(result['metrics']['totalContributed'],30000)
        self.assertEqual(result['metrics']['benchmarkContributed'],30000)
        self.assertGreater(result['accountLedger'][-1]['cash'],30000)

    def test_free_mode_records_actual_cashflows_without_debt(self):
        base,pe,p=self.fixture();p['mode']='free';p['ladder']=[{'hi':100,'multiple':2}]
        result=engine.replay(base,pe,p)
        self.assertEqual(result['metrics']['totalContributed'],60000)
        self.assertEqual(result['metrics']['benchmarkContributed'],30000)
        self.assertTrue(all(row['cash']==0 for row in result['accountLedger']))
        self.assertTrue(all(row['amount']==20000 for row in result['cashFlows']))
        self.assertAlmostEqual(result['metrics']['moneyWeightedIrr'],0)
        self.assertEqual(result['comparisonPolicy'],'different_cashflows_use_separate_xirr_no_wealth_ranking')

    def test_nth_last_day_and_disabled_timing(self):
        base,pe,p=self.fixture();p.update(nth=-1,timingEnabled=False)
        result=engine.replay(base,pe,p)
        self.assertEqual([row['date'] for row in result['trades']],['2020-02-28','2020-03-31','2020-04-30'])
        self.assertTrue(all(row['accountValue']==row['benchmarkValue'] for row in result['accountLedger']))
        self.assertTrue(all(row['unitNav']==row['benchmarkNav'] for row in result['accountLedger']))
        self.assertTrue(all(row['pePercentile'] is None for row in result['accountLedger']))

    def test_costs_units_warmup_and_ladder_boundaries(self):
        base,pe,p=self.fixture();p.update(fee=.01,slippage=.02,timingEnabled=False)
        result=engine.replay(base,pe,p)
        self.assertAlmostEqual(result['accountLedger'][0]['unitNav'],1/(1.01*1.02))
        self.assertEqual(result['trades'][0]['sharesBought'],10000/(100*1.01*1.02))
        self.assertIsNone(result['accountLedger'][0]['ma200'])
        short={'D':pe['D'][-20:],**{key:pe[key][-20:] for key in ['TTM','LYR','MED']}}
        self.assertIsNone(engine.signal(short,20200601,'TTM',5))
        invalid=copy.deepcopy(p);invalid['ladder'][-1]['hi']=90
        with self.assertRaises(ValueError):engine.validate(invalid)
        invalid=copy.deepcopy(p);invalid['years']=True
        with self.assertRaises(ValueError):engine.validate(invalid)
        invalid=copy.deepcopy(p);invalid['unexpected']=1
        with self.assertRaises(ValueError):engine.validate(invalid)

    def test_purchase_day_price_jump_is_not_diluted_by_new_capital(self):
        base,pe,p=self.fixture();p['timingEnabled']=False
        for i,date in enumerate(base['D']):
            if date>=20200302:
                base['C'][i]=base['V'][i]=200.;base['A'][i]=400.
        result=engine.replay(base,pe,p)
        row=next(row for row in result['accountLedger'] if row['date']=='2020-03-02')
        self.assertEqual(row['accountValue'],30000)
        self.assertEqual(row['accountUnits'],15000)
        self.assertEqual(row['preFlowNav'],2)
        self.assertEqual(row['unitNav'],2)
        self.assertEqual(row['benchmarkNav'],2)
        p.update(mode='free',timingEnabled=True,ladder=[{'hi':100,'multiple':2}])
        free=engine.replay(base,pe,p)
        self.assertTrue(all(row['unitNav']==row['benchmarkNav'] for row in free['accountLedger']))
        self.assertTrue(all(row['timingExcessNav']==0 for row in free['accountLedger']))


if __name__ == '__main__': unittest.main()
