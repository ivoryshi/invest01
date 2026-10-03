"""Bounded AST interpreter. User expressions are data, never executable Python."""
import ast
import math
import re

import numpy as np
import pandas as pd

DIALECT = 'industry_expression_v1'
FIELDS = {
    'close': ('价格', '指数价格点'), 'pe': ('PE', '倍；原始缺失保留'), 'pb': ('PB', '倍；原始缺失保留'),
    'turnover': ('换手率', '源数值单位不换算'), 'amt_share': ('成交占比', '流动性代理，不是市值规模'), 'div_yield': ('股息率', '百分数点'),
    'bm': ('账面市值比', '正PB倒数'), 'ep': ('盈利收益率', '正PE倒数'),
    'mom6': ('半年动量', 'close.shift(21)/close.shift(126)-1'), 'mom12': ('年度动量', 'close.shift(21)/close.shift(252)-1'),
    'vol60': ('60日波动率', '40个最少观测，ddof=1，sqrt(244)年化'),
}
FUNCTIONS = {'lag': 2, 'rolling_mean': 2, 'rolling_std': 2, 'pct_change': 2, 'abs': 1, 'log': 1, 'sqrt': 1}


def identifier(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[a-z][a-z0-9_]{0,39}', value)) and value not in FUNCTIONS


def parse(expression):
    if not isinstance(expression, str) or not 1 <= len(expression) <= 512:
        raise ValueError('expression_length_limit')
    try:
        tree = ast.parse(expression, mode='eval')
    except (SyntaxError, RecursionError) as error:
        raise ValueError('expression_invalid_syntax') from error
    if sum(1 for _ in ast.walk(tree)) > 128:
        raise ValueError('expression_complexity_limit')
    names = set()
    def visit(node, depth=0):
        if depth > 24: raise ValueError('expression_depth_limit')
        if isinstance(node, ast.Name): names.add(node.id)
        elif isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int,float)) or not math.isfinite(node.value) or abs(node.value) > 1e6:
                raise ValueError('expression_numeric_constant_required')
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add,ast.Sub,ast.Mult,ast.Div)):
            visit(node.left, depth+1); visit(node.right, depth+1)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd,ast.USub)): visit(node.operand, depth+1)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords and len(node.args) == FUNCTIONS[node.func.id]:
            visit(node.args[0], depth+1)
            if len(node.args) == 2:
                arg = node.args[1]
                if not isinstance(arg, ast.Constant) or isinstance(arg.value,bool) or not isinstance(arg.value,int) or not 1 <= arg.value <= 756:
                    raise ValueError('expression_window_positive_integer_max_756')
        else: raise ValueError('expression_unsupported_syntax_or_function')
    visit(tree.body)
    return tree.body, names


def validate(spec):
    if not isinstance(spec,dict) or set(spec) != {'dialect','bindings','nodes','missingValuePolicy','normalization'} or spec['dialect'] != DIALECT:
        raise ValueError('expression_complete_spec_required')
    if spec['missingValuePolicy'] != 'complete_case' or spec['normalization'] != 'cross_section_zscore_clip_3':
        raise ValueError('expression_unsupported_scoring_policy')
    bindings, nodes = spec['bindings'], spec['nodes']
    if not isinstance(bindings,dict) or not 1 <= len(bindings) <= 16 or any(not identifier(alias) or field not in FIELDS for alias,field in bindings.items()):
        raise ValueError('expression_invalid_field_bindings')
    if not isinstance(nodes,list) or not 1 <= len(nodes) <= 16:
        raise ValueError('expression_nodes_limit')
    ids, parsed, dependencies = set(), {}, {}
    for node in nodes:
        if not isinstance(node,dict) or set(node) != {'id','expression','definition','direction','weight'} or not identifier(node['id']) or node['id'] in ids or node['id'] in bindings or node['id'] in set(FIELDS) | {'date','ind','ind_name','previous_date','total_return'}:
            raise ValueError('expression_duplicate_or_invalid_node')
        if not isinstance(node['definition'],str) or not node['definition'].strip() or len(node['definition']) > 2000 or node['direction'] not in ['higher_is_better','lower_is_better']:
            raise ValueError('expression_node_definition_and_direction_required')
        weight = node['weight']
        if isinstance(weight,bool) or not isinstance(weight,(int,float)) or not math.isfinite(weight) or not 0 <= weight <= 100:
            raise ValueError('expression_invalid_weight')
        ids.add(node['id']); parsed[node['id']], dependencies[node['id']] = parse(node['expression'])
    if sum(node['weight'] for node in nodes) <= 0: raise ValueError('expression_positive_output_weight_required')
    if any(names - ids - set(bindings) for names in dependencies.values()): raise ValueError('expression_unknown_dependency')
    order, visiting, visited = [], set(), set()
    def walk(key):
        if key in visiting: raise ValueError('expression_dependency_cycle')
        if key in visited: return
        visiting.add(key)
        for dep in sorted(dependencies[key] & ids): walk(dep)
        visiting.remove(key); visited.add(key); order.append(key)
    for key in sorted(ids): walk(key)
    return {'order': order, 'dependencies': {key: sorted(dependencies[key]) for key in sorted(ids)}, 'trees': parsed}


def calculate(data, spec):
    plan = validate(spec)
    frame = data.sort_values(['ind','date']).reset_index(drop=True)
    env = {alias: frame[field].astype(float).replace([np.inf,-np.inf],np.nan) for alias,field in spec['bindings'].items()}
    def series(value):
        return (value if isinstance(value,pd.Series) else pd.Series(value,index=frame.index)).replace([np.inf,-np.inf],np.nan)
    def evaluate(node):
        if isinstance(node,ast.Name): return env[node.id]
        if isinstance(node,ast.Constant): return float(node.value)
        if isinstance(node,ast.UnaryOp): return evaluate(node.operand) * (-1 if isinstance(node.op,ast.USub) else 1)
        if isinstance(node,ast.BinOp):
            left,right = series(evaluate(node.left)),series(evaluate(node.right))
            if isinstance(node.op,ast.Add): return left+right
            if isinstance(node.op,ast.Sub): return left-right
            if isinstance(node.op,ast.Mult): return left*right
            return left / right.where(right != 0)
        value = series(evaluate(node.args[0])); name = node.func.id
        if name == 'abs': return value.abs()
        if name == 'log': return np.log(value.where(value>0))
        if name == 'sqrt': return np.sqrt(value.where(value>=0))
        window = node.args[1].value
        grouped = value.groupby(frame['ind'],sort=False)
        if name == 'lag': return grouped.shift(window)
        if name == 'pct_change': return value / grouped.shift(window).where(lambda x:x!=0)-1
        return grouped.transform(lambda s: s.rolling(window,min_periods=window).mean() if name == 'rolling_mean' else s.rolling(window,min_periods=window).std(ddof=1))
    for key in plan['order']: env[key] = series(evaluate(plan['trees'][key])); frame[key] = env[key]
    audit = {'dialect': DIALECT, 'evaluationOrder': plan['order'], 'dependencies': plan['dependencies'],
             'fieldBindings': spec['bindings'], 'nodeCoverage': {key: {'finiteRows': int(env[key].notna().sum()),'missingRows': int(env[key].isna().sum())} for key in plan['order']},
             'windowPolicy': 'per_industry_trailing_observations_full_window_no_fill', 'divisionPolicy': 'zero_or_nonfinite_to_missing', 'missingValuePolicy': spec['missingValuePolicy']}
    return frame, audit


def scorer(spec, family_id):
    outputs = [node for node in spec['nodes'] if node['weight'] > 0]
    total = sum(node['weight'] for node in outputs)
    def score(day, unused_weights):
        day = day.set_index('ind').sort_index(); eligible = pd.Series(True,index=day.index)
        combined = pd.Series(0.,index=day.index); details = {code: [] for code in day.index}; coverage = {}
        for node in outputs:
            raw = day[node['id']].replace([np.inf,-np.inf],np.nan); count = int(raw.notna().sum())
            # Positive scaling leaves z-scores unchanged and avoids overflowing variance.
            scale = raw.abs().max()
            scaled = raw / scale if scale > 0 else raw
            sd = scaled.std(ddof=0)
            z = ((scaled-scaled.mean())/sd).clip(-3,3) if count>=3 and sd>0 else pd.Series(0. if count>=3 else np.nan,index=day.index).where(raw.notna())
            sign = 1 if node['direction']=='higher_is_better' else -1; weight = node['weight']/total
            contribution = z.fillna(0)*sign*weight; combined += contribution; eligible &= z.notna(); coverage[node['id']] = count
            for code in day.index:
                details[code].append({'familyId':family_id,'field':node['id'],'rawValue':float(raw[code]) if pd.notna(raw[code]) else None,
                    'zScore':float(z[code]) if pd.notna(z[code]) else None,'sign':sign,'slotWeight':weight,'familyWeight':1.,'contribution':float(contribution[code])})
        ranked = [{'code':code,'name':str(day.loc[code,'ind_name']),'score':float(combined[code]),'coverage':1.,'factorDetails':details[code]} for code in day.index if eligible[code]]
        ranked.sort(key=lambda row:(-row['score'],row['code']))
        return ranked, coverage
    return score
