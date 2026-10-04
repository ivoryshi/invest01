import copy
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
import factor_expression as e
import custom_industry_engine as engine


class ExpressionTest(unittest.TestCase):
    def spec(self, expression='1 / value_input'):
        return {'dialect':e.DIALECT,'bindings':{'price':'close','value_input':'pb'},'nodes':[
            {'id':'score_value','expression':expression,'definition':'test definition','direction':'higher_is_better','weight':1}],
            'missingValuePolicy':'complete_case','normalization':'cross_section_zscore_clip_3'}

    def data(self):
        dates = pd.date_range('2019-12-01','2020-03-31')
        panel = pd.concat([pd.DataFrame({'date':dates,'ind':code,'ind_name':code,'close':100.,'pb':i+1.,'pe':10.,'turnover':1.,'amt_share':1.,'div_yield':0.}) for i,code in enumerate(['0001','0002','0003'])],ignore_index=True)
        bench = pd.DataFrame({'date':dates,'hs300_tr':100.})
        inv = pd.DataFrame({'ind_name':['0001','0002','0003'],'first_investable':pd.Timestamp('2018-01-01')})
        return panel,bench,inv

    def config(self,spec=None,**settings):
        spec = spec or self.spec(); inspected = engine.inspect(spec); family='library.custom.test'
        return {'strategyTemplateId':'strategy.custom_industry_expression','universe':'sw_industry_and_etf_proxy','factorFamilyIds':[family],
            'factorWeights':[{'factorFamilyId':family,'weight':1}],'benchmarkId':'hs300_total_return','portfolioRule':'monthly_topn_custom_complete_case','rebalanceCalendar':'monthly',
            'costModel':'commission=0;slippage=0;annual_fee=0','strategySettings':{'startDate':'2020-01-01','endDate':'2020-03-31','topN':1,'minInvestable':3,'signalLagDays':1,
            'weightingMethod':'equal_weight','missingValuePolicy':'complete_case','factorProgram':{'factorFamilyId':family,'revision':1,'executionSha256':inspected['executionSha256'],'executionSpec':spec},**settings}}

    def test_unsafe_syntax_and_forward_windows_rejected(self):
        for expression in ["__import__('os').system('x')",'price.iloc[-1]','price.__class__','[price]','price ** 99999','lambda x: x','lag(price,-1)','lag(price,0)','rolling_mean(price,99999)','rolling_mean(price,True)','lag(price,1.0)','sqrt(price,1)','unknown(price)','1e309','True','sum(price)','lag(price,window=1)']:
            with self.subTest(expression=expression),self.assertRaises(ValueError): e.validate(self.spec(expression))

    def test_unknown_fields_dependencies_cycles_and_reserved_names(self):
        s=self.spec();s['bindings']['price']='future_return'
        with self.assertRaisesRegex(ValueError,'bindings'):e.validate(s)
        with self.assertRaisesRegex(ValueError,'unknown_dependency'):e.validate(self.spec('unknown_field + price'))
        s=self.spec('score_value+1')
        with self.assertRaisesRegex(ValueError,'cycle'):e.validate(s)
        for reserved in ['ind','close','date','rolling_mean']:
            s=self.spec();s['nodes'][0]['id']=reserved
            with self.assertRaises(ValueError):e.validate(s)

    def test_dependency_order_and_intermediate_zero_weight(self):
        s=self.spec('intermediate_value*2');s['nodes'].append({'id':'intermediate_value','expression':'1/value_input','definition':'input','direction':'higher_is_better','weight':0})
        frame,audit=e.calculate(self.data()[0],s)
        self.assertEqual(audit['evaluationOrder'],['intermediate_value','score_value'])
        self.assertAlmostEqual(frame.loc[frame.ind=='0003','score_value'].iloc[0],2/3)

    def test_window_grouping_and_warmup_no_fill(self):
        panel=self.data()[0];panel.loc[panel.ind=='0002','close']=200.
        f,_=e.calculate(panel,self.spec('lag(price,2)+rolling_mean(price,3)'))
        for code,value in [('0001',200),('0002',400)]:
            values=f[f.ind==code].score_value
            self.assertTrue(values.iloc[:2].isna().all());self.assertEqual(values.iloc[2],value)

    def test_zero_division_domain_and_nonfinite_stay_missing(self):
        panel=self.data()[0];panel.loc[panel.ind=='0001','pb']=0
        f,_=e.calculate(panel,self.spec())
        self.assertTrue(f[f.ind=='0001'].score_value.isna().all())
        for expression in ['log(-value_input)','sqrt(-value_input)','price/(value_input-value_input)']:
            f,_=e.calculate(self.data()[0],self.spec(expression));self.assertTrue(f.score_value.isna().all())

    def test_scoring_direction_weights_ties_complete_case(self):
        s=self.spec();f,_=e.calculate(self.data()[0],s);score=e.scorer(s,'family')
        rows,_=score(f[f.date==f.date.min()],{})
        self.assertEqual(rows[0]['code'],'0001');self.assertAlmostEqual(rows[0]['score'],rows[0]['factorDetails'][0]['contribution'])
        s['nodes'][0]['direction']='lower_is_better';self.assertEqual(e.scorer(s,'family')(f[f.date==f.date.min()],{})[0][0]['code'],'0003')
        f.loc[f.ind=='0001','score_value']=np.nan;self.assertEqual(score(f[f.date==f.date.min()],{})[0],[])

    def test_large_finite_values_keep_normalized_ranking(self):
        panel=self.data()[0];panel['close']=panel['pb']
        s=self.spec('price / 1e-200');frame,_=e.calculate(panel,s)
        rows,_=e.scorer(s,'family')(frame[frame.date==frame.date.min()],{})
        self.assertEqual([r['code'] for r in rows],['0003','0002','0001'])
        np.testing.assert_allclose([r['score'] for r in rows],[np.sqrt(1.5),0,-np.sqrt(1.5)],atol=1e-14)

    def test_flat_account_prior_signal_and_irr_null(self):
        r=engine.run(*self.data(),self.config());self.assertEqual(r['metrics']['finalValue'],1)
        self.assertIsNone(r['metrics']['moneyWeightedIrr']);self.assertEqual(r['decisions'][0]['codes'],['0001'])
        self.assertTrue(all(d['signalDate']<d['date'] for d in r['decisions']))

    def test_future_changes_do_not_change_past_results(self):
        panel,bench,inv=self.data();config=self.config(endDate='2020-01-31')
        first=engine.run(panel,bench,inv,config)
        panel.loc[panel.date>'2020-01-31',['close','pb']]=[999999,.001]
        second=engine.run(panel,bench,inv,config)
        self.assertEqual(first['rows'],second['rows']);self.assertEqual(first['decisions'],second['decisions'])

    def test_purchase_close_does_not_earn_past_jump(self):
        panel,bench,inv=self.data();panel.loc[(panel.ind=='0001')&(panel.date>='2020-01-01'),'close']=200
        self.assertEqual(engine.run(panel,bench,inv,self.config(endDate='2020-01-02'))['metrics']['finalValue'],1)

    def test_fees_once_and_no_uninvestable_asset(self):
        config=self.config();config['costModel']='commission=.01;slippage=0;annual_fee=0'
        r=engine.run(*self.data(),config);self.assertAlmostEqual(r['metrics']['finalValue'],.99)
        panel,bench,inv=self.data();inv.loc[inv.ind_name=='0001','first_investable']=pd.Timestamp('2021-01-01')
        r=engine.run(panel,bench,inv,self.config(minInvestable=3));self.assertEqual(r['metrics']['cashMonths'],3)

    def test_hash_and_revision_settings_rejected(self):
        config=self.config();config['strategySettings']['factorProgram']['executionSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):engine.run(*self.data(),config)
        for settings in [{'signalLagDays':0},{'missingValuePolicy':'fill_zero'},{'extra':1},{'slotWeights':[]}]:
            with self.assertRaises(ValueError):engine.run(*self.data(),self.config(**settings))

    def test_selected_definition_copy_not_latest_library(self):
        spec=self.spec();config=self.config(copy.deepcopy(spec));spec['nodes'][0]['expression']='price'
        r=engine.run(*self.data(),config);self.assertEqual(r['factorProgram']['executionSpec']['nodes'][0]['expression'],'1 / value_input')

    def test_preview_is_not_trade_signal_or_saved_result(self):
        r=engine.run(*self.data(),self.config(),preview=True)
        self.assertEqual(r['previewDate'],'2020-03-31');self.assertNotIn('metrics',r)
        self.assertEqual(r['policy'],'same_date_calculation_preview_not_execution_signal')

    def test_parquet_bytes_hashes_and_current_copy_equivalence(self):
        with tempfile.TemporaryDirectory() as folder:
            paths=[]
            for i,frame in enumerate(self.data()):
                file=Path(folder)/f'{i}.parquet';frame.to_parquet(file,index=False);paths.append(str(file))
            r=engine.execute(paths,self.config());self.assertEqual(len(r['sourceVersions']),3)
            copied=[]
            for i,file in enumerate(paths):
                copyfile=Path(folder)/f'copy{i}.parquet';copyfile.write_bytes(Path(file).read_bytes());copied.append(str(copyfile))
            self.assertEqual(engine.execute(copied,self.config())['rows'],r['rows'])


if __name__=='__main__':unittest.main()
