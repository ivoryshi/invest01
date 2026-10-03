"""Explicit custom programs use the existing monthly industry accounting engine."""
import hashlib
import copy
import io
import json
import sys
from pathlib import Path

import pandas as pd

import factor_expression as expressions
import industry_engine as industry

VERSION = 'custom-industry-expression-v1'
DEFAULT_SPEC = {'dialect': expressions.DIALECT, 'bindings': {'price': 'close', 'value_input': 'bm'},
    'nodes': [{'id': 'momentum_value', 'expression': 'pct_change(price, 21)', 'definition': '近21个本行业观测的价格涨幅', 'direction': 'higher_is_better', 'weight': .5},
              {'id': 'valuation_value', 'expression': 'value_input', 'definition': '正PB的倒数；缺失或非正PB不参与排序', 'direction': 'higher_is_better', 'weight': .5}],
    'missingValuePolicy': 'complete_case', 'normalization': 'cross_section_zscore_clip_3'}


def inspect(spec):
    plan = expressions.validate(spec)
    sha = hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    return {'executionSha256': sha, 'evaluationOrder':plan['order'],'dependencies':plan['dependencies'],'executionSpec':spec}


def parameters(config):
    if config.get('strategyTemplateId') != 'strategy.custom_industry_expression' or config.get('portfolioRule') != 'monthly_topn_custom_complete_case':
        raise ValueError('unsupported_custom_industry_strategy')
    s = config.get('strategySettings')
    if not isinstance(s,dict) or 'factorProgram' not in s or s.get('missingValuePolicy') != 'complete_case':
        raise ValueError('custom_industry_program_required')
    program = s['factorProgram']
    if not isinstance(program,dict) or set(program) != {'factorFamilyId','revision','executionSha256','executionSpec'} or isinstance(program['revision'],bool) or not isinstance(program['revision'],int) or program['revision'] < 1:
        raise ValueError('custom_industry_bound_program_required')
    family = program['factorFamilyId']
    if config.get('factorFamilyIds') != [family] or config.get('factorWeights') != [{'factorFamilyId':family,'weight':1}]:
        raise ValueError('custom_industry_single_program_binding_required')
    checked = inspect(program['executionSpec'])
    if checked['executionSha256'] != program['executionSha256']:
        raise ValueError('custom_industry_program_hash_mismatch')
    adapted = {**config,'strategyTemplateId':'strategy.industry_parquet_monthly_topn', 'portfolioRule':'monthly_topn_equal_weight_prior_signal',
        'factorFamilyIds':['library.industry.value'],'factorWeights':[{'factorFamilyId':'library.industry.value','weight':1}],
        'strategySettings':{key:value for key,value in s.items() if key != 'factorProgram'}}
    adapted['strategySettings']['missingValuePolicy'] = 'neutral_with_coverage'
    return industry.validate(adapted), program


def run(panel, bench, investable, config, preview=False):
    p, program = parameters(config)
    data, benchmark, inv = industry.prepare(panel,bench,investable)
    data, audit = expressions.calculate(data,program['executionSpec'])
    data['previousDate'] = data.groupby('ind')['date'].shift(1)
    score_fn = expressions.scorer(program['executionSpec'],program['factorFamilyId'])
    if preview:
        dates = sorted(data.loc[data.date <= p['end'],'date'].unique())
        if not dates or p['end'] > data.date.max() or p['start'] < data.date.min():
            raise ValueError('industry_period_outside_data_coverage')
        date = pd.Timestamp(dates[-1]); ranked, coverage = score_fn(data[data.date==date],p['weights'])
        return {'previewDate':date.date().isoformat(),'ranked':ranked[:50],'fieldCoverage':coverage,'formulaAudit':audit,'factorProgram':program,
                'policy':'same_date_calculation_preview_not_execution_signal','eligiblePreviewCount':len(ranked)}
    context = industry.simulation_context(data,benchmark,p)
    result = industry.simulate(data,benchmark,inv,p,score_fn=score_fn,context=context)
    result.update({'factorProgram':program,'formulaAudit':audit,'calculationVersion':VERSION,'signalLagDays':p['lag'],'costRates':p['rates'],
        'factorDefinitions':[{'familyId':program['factorFamilyId'],'revision':program['revision'],'executionSha256':program['executionSha256'],'weight':1,
            'slots':[{'field':n['id'],'formula':n['expression'],'definition':n['definition'],'weight':n['weight']/sum(x['weight'] for x in program['executionSpec']['nodes']),
                      'sign':1 if n['direction']=='higher_is_better' else -1} for n in program['executionSpec']['nodes']]}],
        'sourceAudit':{'signalPolicy':'global_panel_observation_lag_before_rebalance_close','missingPolicy':'all_positive_weight_nodes_complete; >=3_finite_per_node',
                       'normalization':'same_date_all_panel_industries_population_std_clip_3_before_investability_filter'},
        'sensitivity':[], 'warnings':['custom_formula_not_validated_investment_alpha','historical_constituents_and_disclosure_dates_unverified','industry_index_proxy_not_real_etf_execution',
                                      'dividend_reconstruction_approximation','benchmark_gross_index_vs_net_strategy','alpha_smart_beta_attribution_not_computed']})
    result['sensitivity'] = industry.sensitivity_runs(data,benchmark,inv,p,result,score_fn,context=context)
    outputs = [n for n in program['executionSpec']['nodes'] if n['weight']>0]
    proxies, failures = {}, []
    for node in outputs if len(outputs)<=8 else []:
        spec = copy.deepcopy(program['executionSpec'])
        for n in spec['nodes']: n['weight'] = 1. if n['id']==node['id'] else 0.
        try:
            proxies[node['id']] = result['rows'] if len(outputs)==1 else industry.simulate(data,benchmark,inv,p,expressions.scorer(spec,program['factorFamilyId']),context=context,audit=False)['rows']
        except ValueError as error: failures.append({'proxy':node['id'],'error':str(error)})
    result['riskModel'] = {'status':'not_identifiable','reason':'proxy_budget_exceeded' if len(outputs)>8 else 'proxy_unavailable',
        'basis':[n['id'] for n in outputs],'observations':len(result['rows']),'failures':failures,'maxProxyOutputs':8,
        'warning':'超过8个输出代理或代理重跑失败；保留主回测，未使用部分列拟合。'} if failures or len(outputs)>8 else industry.proxy_risk_model(result['rows'],proxies)
    if len(outputs)>1:
        spec = copy.deepcopy(program['executionSpec'])
        for node in spec['nodes']:
            if node['id']==outputs[0]['id']: node['weight'] *= .9
        change = {'nodeWeights':{n['id']:n['weight'] for n in spec['nodes']},'variantExecutionSha256':inspect(spec)['executionSha256']}
        try:
            variant = industry.simulate(data,benchmark,inv,p,expressions.scorer(spec,program['factorFamilyId']),context=context,audit=False)
            result['sensitivity'].append({'case':'first_output_weight_minus_10pct','status':'recomputed_same_captured_inputs', 'parameterChanges':change,
                **variant['metrics'],'finalValueDelta':variant['metrics']['finalValue']-result['metrics']['finalValue']})
        except ValueError as error:
            result['sensitivity'].append({'case':'first_output_weight_minus_10pct','status':'unavailable','parameterChanges':change,'error':str(error)})
    return result


def execute(paths, config, preview=False):
    parameters(config)
    if len(paths) != 3: raise ValueError('custom_industry_three_sources_required')
    frames, versions = [], []
    for file in paths:
        path = Path(file)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 32*1024*1024:
            raise ValueError('custom_industry_source_unavailable_or_limit')
        raw = path.read_bytes()
        if len(raw)>32*1024*1024: raise ValueError('custom_industry_source_size_limit')
        frames.append(pd.read_parquet(io.BytesIO(raw))); versions.append({'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
    result = run(*frames,config,preview=preview)
    if any(hashlib.sha256(Path(file).read_bytes()).hexdigest()!=v['sha256'] for file,v in zip(paths,versions)):
        raise ValueError('custom_industry_source_changed_retry')
    result['sourceVersions'] = versions
    return result


if __name__ == '__main__':
    try:
        mode = sys.argv[1]
        if mode == 'options':
            result = {'dialect':expressions.DIALECT,'fields':[{'field':key,'name':name,'definition':definition} for key,(name,definition) in expressions.FIELDS.items()],
                'functions':expressions.FUNCTIONS,'defaultSpec':DEFAULT_SPEC,'limits':{'bindings':16,'nodes':16,'expressionLength':512,'window':756}}
        elif mode == 'validate': result = inspect(json.loads(sys.argv[2]))
        elif mode == 'preflight':
            parameters(json.loads(sys.argv[2])); result = {'valid':True}
        else: result = execute(json.loads(sys.argv[2]),json.loads(sys.argv[3]),preview=mode=='preview') if mode in ['preview','execute'] else {'error':'unsupported_expression_mode'}
    except (ValueError,KeyError,TypeError,OSError,OverflowError) as error:
        result = {'error':str(error)}
    print(json.dumps(result,ensure_ascii=False,allow_nan=False))
