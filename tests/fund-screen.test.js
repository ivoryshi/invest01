import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fundComparisonGroupValue, fundMetadataEditPayload, isCurrentFundEdit, refreshSnapshotChoices } from '../apps/web/fund-screen-state.js';

function selectStub(value) {
  return { value, options: [], replaceChildren(...items) { this.options = items; this.value = items[0]?.value || ''; }, append(item) { this.options.push(item); } };
}
const makeOption = (value, label) => ({ value, label });
const snapshot = value => ({ snapshotId: value, title: value, baseSnapshotId: 'current', createdAt: '2026-10-01T00:00:00.000Z', status: 'frozen' });

test('snapshot choice refresh preserves a selection made while its request is pending', async () => {
  const select = selectStub('current');
  let finish;
  const promise = refreshSnapshotChoices(select, { baseSnapshotId: 'current', makeOption, load: () => new Promise(resolve => { finish = resolve; }) });
  select.value = 'frozen_b';
  finish({ items: [snapshot('frozen_b'), { ...snapshot('invalid'), createdAt: null }] });
  await promise;
  assert.equal(select.value, 'frozen_b');
  assert.ok(!select.options.some(item => item.value === 'invalid'));
});

test('snapshot choice refresh ignores older requests that complete after a newer one', async () => {
  const select = selectStub('current');
  let oldFinish;
  const old = refreshSnapshotChoices(select, { baseSnapshotId: 'current', makeOption, load: () => new Promise(resolve => { oldFinish = resolve; }) });
  await refreshSnapshotChoices(select, { baseSnapshotId: 'current', makeOption, load: async () => ({ items: [snapshot('new')] }) });
  oldFinish({ items: [snapshot('old')] }); await old;
  assert.ok(select.options.some(item => item.value === 'new'));
  assert.ok(!select.options.some(item => item.value === 'old'));
});

test('metadata-only fund edits preserve unavailable source bindings and computation settings', () => {
  const loaded = { configId: 'config.old', snapshotId: 'snapshot.unavailable', title: 'old', strategySettings: { sourceSha256: 'original', rankFields: [{ field: 'old_field', weight: 1 }], comparisonGroup: { strategyType: 'old' } }, factorFamilyIds: ['original'], topN: 3 };
  const payload = fundMetadataEditPayload(loaded, { title: 'new', notes: 'updated' });
  assert.deepEqual(payload, { ...loaded, title: 'new', notes: 'updated' });
  assert.equal(payload.strategySettings, loaded.strategySettings);
  assert.equal(loaded.title, 'old');
});

test('fund edit response cannot replace a different or newly reloaded draft', () => {
  assert.equal(isCurrentFundEdit('A', 1, 'B', 2), false);
  assert.equal(isCurrentFundEdit('A', 1, 'A', 3), false);
  assert.equal(isCurrentFundEdit('A', 1, 'A', 1), true);
});

test('fund comparison group restoration ignores object key order but not comparison values', () => {
  const profileGroup = { strategyType: 'equity', frequency: 'D', benchmark: 'index', benchmarkBasis: 'total_return' };
  const savedGroup = { benchmarkBasis: 'total_return', benchmark: 'index', frequency: 'D', strategyType: 'equity' };
  assert.equal(fundComparisonGroupValue(savedGroup), fundComparisonGroupValue(profileGroup));
  assert.deepEqual(JSON.parse(fundComparisonGroupValue(savedGroup)), profileGroup);
  for (const key of Object.keys(profileGroup)) assert.notEqual(fundComparisonGroupValue({ ...profileGroup, [key]: 'other' }), fundComparisonGroupValue(profileGroup));
});

test('fund screening isolates groups and audits ranks missing data and source versions', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_fund_screen_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000,
  });
  assert.match(stderr, /Ran 11 tests/);
  assert.match(stderr, /OK/);
});
