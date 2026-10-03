import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureLegacyArchive, listLegacyArchives, queryLegacyRecords, readLegacyArchive, verifyLegacyArchive } from '../modules/factors/src/legacy-assets.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'factor-legacy-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'old'), archiveRoot = path.join(root, 'new'); await mkdir(path.join(sourceRoot, 'out'), { recursive: true });
  const values = {
    'report.json': { base: { config: { top_n: 3 }, period: ['2020-01', '2021-01'], irr_strategy: .1 }, stress: { config: { cost: .01 } }, variant: { config: { gate: true } } },
    'app_data.json': { sensitivity: [{ case: '<script>not executable</script>', irr: .1 }] },
    'factor_study.json': { decomp: [{ name: 'baseline', weights: { value: .4 } }], perturb: [{ weights: { value: .5 } }] },
    'factor_loo.json': { cats: [{ cat: 'value', weight: .4, marginal: .01 }] },
    'lab_comps.json': { comps: { B_base: [1, 1.2], A_hs300_gate: [1, 1.1] }, b_variants: [{ key: 'base', label: 'base variant', weights: { value: .4 } }] },
    'coverage_repair.json': { summary: 'historical network counts not executed' },
    'unmapped.json': { original: 'kept exactly' },
  };
  for (const [name, value] of Object.entries(values)) await writeFile(path.join(sourceRoot, 'out', name), JSON.stringify(value));
  await mkdir(path.join(sourceRoot, 'archive')); await writeFile(path.join(sourceRoot, 'archive', 'factor-dca-lab.html'), '<html><script>not run</script></html>');
  return { sourceRoot, archiveRoot, values };
}

test('legacy capture preserves exact bytes and standardizes all available record families', async t => {
  const f = await fixture(t), result = await captureLegacyArchive(f), manifest = await readLegacyArchive(f.archiveRoot, result.archiveId);
  assert.equal(result.assets, 8); assert.equal(result.records, 9);
  assert.equal(manifest.assets.find(a => a.sourcePath === 'out/unmapped.json').role, 'unmapped_export_preserved');
  for (const asset of manifest.assets) {
    const original = await readFile(path.join(f.sourceRoot, asset.sourcePath));
    assert.deepEqual(await readFile(path.join(f.archiveRoot, 'versions', result.archiveId, asset.storagePath)), original);
    assert.equal(asset.sha256, createHash('sha256').update(original).digest('hex'));
  }
  assert.equal(manifest.records.find(r => r.category === 'comparison_curve').curve.dates, 'not_exported_in_this_file');
  assert.equal(manifest.records.find(r => r.category === 'sensitivity_case').parameters, null);
  assert.equal((await verifyLegacyArchive(f.archiveRoot, result.archiveId)).status, 'all_archived_bytes_verified');
});
test('capture is idempotent, new content produces another version and old records remain available', async t => {
  const f = await fixture(t), first = await captureLegacyArchive(f);
  assert.equal((await captureLegacyArchive(f)).reused, true);
  await writeFile(path.join(f.sourceRoot, 'out', 'report.json'), JSON.stringify({ base: { config: { top_n: 4 } } }));
  const second = await captureLegacyArchive(f); assert.notEqual(second.archiveId, first.archiveId);
  const old = await readLegacyArchive(f.archiveRoot, first.archiveId);
  assert.equal(old.records.find(r => r.jsonPointer === '/base').parameters.top_n, 3);
  assert.equal((await listLegacyArchives(f.archiveRoot)).items.length, 2);
});
test('archive queries filter categories, source and text with bounded paging', async t => {
  const f = await fixture(t), capture = await captureLegacyArchive(f), m = await readLegacyArchive(f.archiveRoot, capture.archiveId);
  const filtered = queryLegacyRecords(m, { category: 'backtest_scenario', sourcePath: 'out/report.json', limit: 2 });
  assert.equal(filtered.total, 3); assert.equal(filtered.items.length, 2); assert.equal(filtered.hasMore, true);
  assert.equal(queryLegacyRecords(m, { q: 'base', category: 'comparison_curve' }).total, 1);
  assert.equal(queryLegacyRecords(m, { offset: 9 }).items.length, 0);
  for (const params of [{ limit: 101 }, { offset: -1 }, { q: 'a'.repeat(101) }]) assert.throws(() => queryLegacyRecords(m, params), /invalid.*query/);
  await assert.rejects(readLegacyArchive(f.archiveRoot, '../out'), /invalid.*id/);
});
test('original deletion does not remove archives and changed archived bytes are never silently repaired', async t => {
  const f = await fixture(t), capture = await captureLegacyArchive(f), m = await readLegacyArchive(f.archiveRoot, capture.archiveId);
  const file = path.join(f.archiveRoot, 'versions', capture.archiveId, m.assets[0].storagePath);
  await writeFile(file, 'corrupted');
  await assert.rejects(verifyLegacyArchive(f.archiveRoot, capture.archiveId), /integrity_failed/);
  await assert.rejects(captureLegacyArchive(f), /integrity_failed/);
  assert.equal(await readFile(file, 'utf8'), 'corrupted');
  await rm(f.sourceRoot, { recursive: true });
  assert.equal((await readLegacyArchive(f.archiveRoot, capture.archiveId)).records.length, 9);
});
test('metadata identity includes standardized records and corrupt versions are isolated', async t => {
  const f = await fixture(t), capture = await captureLegacyArchive(f), manifest = await readLegacyArchive(f.archiveRoot, capture.archiveId);
  manifest.records[0].parameters.top_n = 999;
  await writeFile(path.join(f.archiveRoot, 'versions', capture.archiveId, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(readLegacyArchive(f.archiveRoot, capture.archiveId), /invalid.*manifest/);
  const list = await listLegacyArchives(f.archiveRoot); assert.equal(list.items.length, 0); assert.equal(list.errors.length, 1);
});
test('symlinks and malformed JSON are rejected before publishing', async t => {
  const f = await fixture(t); const file = path.join(f.sourceRoot, 'out', 'report.json');
  await rm(file); await symlink(path.join(f.sourceRoot, 'out', 'unmapped.json'), file);
  await assert.rejects(captureLegacyArchive(f), /symlink_not_allowed/);
  await rm(file); await writeFile(file, '{'); await assert.rejects(captureLegacyArchive(f), SyntaxError);
  await assert.rejects(readdir(path.join(f.archiveRoot, 'versions')), { code: 'ENOENT' });
});
test('concurrent same-content captures publish one complete version', async t => {
  const f = await fixture(t); const results = await Promise.all([captureLegacyArchive(f), captureLegacyArchive(f)]);
  assert.equal(results[0].archiveId, results[1].archiveId);
  assert.equal((await listLegacyArchives(f.archiveRoot)).items.length, 1);
  assert.equal((await verifyLegacyArchive(f.archiveRoot, results[0].archiveId)).files, 8);
});

test('embedded page JSON is recovered with provenance, dynamic JavaScript is not executed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, 'archive', 'factor-dca-lab.html'), `<script>
const BASE = {"cfg":{"top_n":3,"commission":0.001},"D":[20200101,20200102]};
const UNSAFE = { top: (() => { throw new Error('must not execute'); })() };
const PREFIX = {"top":9} + maliciousCall();
// const BASE = {"top_n":99};
/* const BASE = {"top_n":98}; */
const text = ` + "`const BASE = {\"top_n\":97};`" + `;
const regex = /const BASE = {"top_n":96};/;
const nested = ` + "`outer ${`const BASE = {\"top_n\":95};`}`" + `;
</script><input type="number" id="amount" value="5000" step="500"><input type="checkbox" id="gate" checked>
<select id="frequency"><option value="monthly">Month</option><option value="weekly" selected>Week</option></select>`);
  const c = await captureLegacyArchive(f), m = await readLegacyArchive(f.archiveRoot,c.archiveId);
  const items = queryLegacyRecords(m,{category:'embedded_page_parameters'}).items;
  assert.equal(items.length,4);
  assert.deepEqual(items[0].parameters,{cfg:{top_n:3,commission:.001}});
  assert.equal(items[0].literal.arrays.D.observations,2);
  assert.match(items[0].sourceSha256,/^[a-f0-9]{64}$/);
  assert.equal(items[1].status,'unsupported_javascript_literal_not_evaluated');
  assert.equal(items[2].parameters,null);
  assert.equal(items[3].status,'static_html_defaults_not_runtime_state');
  assert.equal(items[3].parameters.controls[0].value,'5000');
  assert.equal(items[3].parameters.controls[1].checked,true);
  assert.equal(items[3].parameters.controls[2].staticValue,'weekly');
  assert.equal((await verifyLegacyArchive(f.archiveRoot,c.archiveId)).files,8);
});
