"""Reuse engine validators without simulating returns or writing research assets."""
import json
import sys


def preflight(config, paths):
    kind = config['strategyTemplateId']
    if kind == 'strategy.legacy_510300_pe_dca':
        import hashlib
        from pathlib import Path
        import legacy_dca_engine as engine
        source = paths[0]
        raw = Path(source['storageRef']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != source['expectedSha256']:
            raise ValueError('legacy_archive_integrity_failed')
        base, pe = engine.load(raw)
        p = engine.validate_config(config, source['expectedSha256'], source['snapshot']['selection'])
        engine.validate_period(base, p)
        return {'parameterValidation': 'engine_validator_passed', 'profile': {'priceObservations': len(base['D']), 'peObservations': len(pe['D'])}}
    if kind == 'strategy.fund_nav_fixed_dca':
        import fund_nav_engine as engine
        settings, start, end, _ = engine.validate(config)
        profile = engine.profile(paths[0]['storageRef'], [s['shareCode'] for s in settings['shares']], config['benchmarkId'], paths[0]['expectedSha256'])
        if settings['sourceVersions'] != profile['sourceVersions']:
            raise ValueError('fund_nav_source_version_changed_reload_profile')
        if start.date().isoformat() < profile['commonStartDate'] or end.date().isoformat() > profile['commonEndDate']:
            raise ValueError('fund_nav_period_outside_common_coverage')
        return {'parameterValidation': 'engine_validator_passed', 'profile': profile}
    if kind == 'strategy.industry_parquet_monthly_topn':
        import industry_engine as engine
        engine.validate(config)
    elif kind == 'strategy.custom_industry_expression':
        import custom_industry_engine as engine
        engine.parameters(config)
    elif kind == 'strategy.legacy_three_bucket_monthly':
        import three_bucket_engine as engine
        engine.validate(config)
    elif kind == 'strategy.monthly_dca_three_bucket':
        import dca_engine as engine
        engine.parameters(config)
    else:
        raise ValueError('strategy_not_supported_by_guarded_backtest')
    return {'parameterValidation': 'engine_validator_passed', 'profile': None}


if __name__ == '__main__':
    try:
        result = preflight(json.loads(sys.argv[1]), json.loads(sys.argv[2]))
    except (ValueError, KeyError, TypeError, OSError) as error:
        result = {'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
