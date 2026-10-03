import { test } from 'node:test';
import assert from 'node:assert/strict';
import { industrySaveMethod, latestIndustryConfig, nextIndustryConfigId } from '../apps/web/industry-state.js';

test('new industry drafts choose an unoccupied ID including older default drafts', () => {
  const items = [{ configId: 'config.industry_parquet_manual' }, { configId: 'config.industry_parquet_manual_2' }];
  assert.equal(nextIndustryConfigId(items), 'config.industry_parquet_manual_3');
  assert.equal(nextIndustryConfigId([]), 'config.industry_parquet_manual');
});

test('new industry drafts never silently update an ID collision', () => {
  assert.equal(industrySaveMethod(null, 'config.industry_parquet_manual'), 'POST');
});

test('industry editing requires the explicitly loaded ID for PUT', () => {
  assert.equal(industrySaveMethod('config.a', 'config.a'), 'PUT');
  assert.equal(industrySaveMethod('config.a', 'config.b'), 'POST');
});

test('industry edit resolves current revision instead of the stale list object', () => {
  const current = { configId: 'config.a', revision: 2, strategyTemplateId: 'strategy.industry_parquet_monthly_topn', strategySettings: { topN: 7 } };
  assert.equal(latestIndustryConfig([current], 'config.a'), current);
  assert.equal(latestIndustryConfig([current], 'config.removed'), null);
  assert.equal(latestIndustryConfig([{ ...current, strategyTemplateId: 'strategy.fund_cross_section_screen' }], 'config.a'), null);
});
