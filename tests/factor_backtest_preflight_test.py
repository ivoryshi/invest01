import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'modules/factors/src'))
import backtest_preflight as preflight
import fund_history_snapshot as snapshot
import factor_industry_test as industry
import factor_expression_test as expression
import factor_three_bucket_test as three
import factor_dca_test as dca
import factor_fund_nav_test as fund


class BacktestPreflightTest(unittest.TestCase):
    def test_five_parameter_validators_and_no_simulation(self):
        configs = [industry.IndustryTest().config(), expression.ExpressionTest().config(), three.ThreeBucketTest().config(),
                   {**dca.DcaEngineTest().config(), 'strategyTemplateId': 'strategy.monthly_dca_three_bucket'}]
        modules = ['industry_engine', 'custom_industry_engine', 'three_bucket_engine', 'dca_engine']
        for config, name in zip(configs, modules):
            with patch(name+'.run', side_effect=AssertionError('must_not_simulate')):
                self.assertEqual(preflight.preflight(config, [])['parameterValidation'], 'engine_validator_passed')

    def test_unsafe_or_incomplete_parameters_rejected(self):
        for config in [industry.IndustryTest().config(signalLagDays=0), three.ThreeBucketTest().config(shiborLagMonths=0),
                       {**dca.DcaEngineTest().config(amount=0), 'strategyTemplateId': 'strategy.monthly_dca_three_bucket'}]:
            with self.assertRaises(ValueError):
                preflight.preflight(config, [])
        config = expression.ExpressionTest().config()
        config['strategySettings']['factorProgram']['executionSpec']['nodes'][0]['expression'] = 'lag(price,-1)'
        with self.assertRaises(ValueError):
            preflight.preflight(config, [])

    def test_fund_frozen_profile_versions_coverage_without_execution(self):
        fixture = fund.FundNavTest(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        config = fixture.config(); output = fixture.root/'frozen.sqlite'
        captured = snapshot.capture(fixture.database, output, {'codes':['000001','000002'],'benchmarkId':'CSI300','sourceVersions':config['strategySettings']['sourceVersions']})
        config['snapshotId'] = 'snapshot.frozen.'+'a'*64
        paths=[{'storageRef':str(output),'expectedSha256':captured['sha256']}]
        with patch('fund_nav_engine.run', side_effect=AssertionError('must_not_simulate')):
            result=preflight.preflight(config,paths)
        self.assertEqual(result['profile']['temporalEligibility']['status'],'not_point_in_time_verified')
        changed=copy.deepcopy(config);changed['strategySettings']['sourceVersions'][1]['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'source_version_changed'):preflight.preflight(changed,paths)
        changed=copy.deepcopy(config);changed['strategySettings']['endDate']='2030-01-01'
        with self.assertRaisesRegex(ValueError,'outside_common_coverage'):preflight.preflight(changed,paths)


if __name__ == '__main__': unittest.main()
