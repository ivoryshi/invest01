import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFrozenSnapshotStore } from '../modules/factors/src/frozen-snapshots.js';
import { factorDataAssets, factorSnapshotCandidates } from '../packages/contracts/factors.js';
import { createServer } from '../apps/api/server.js';
import { request } from './helpers.js';

const fundId = 'snapshot.fund_warehouse.wide_today.current';
const broadId = 'snapshot.etf_smartbeta.broad_panel.current';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'factor-freeze-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const csv = path.join(dir, 'wide_today.csv');
  await writeFile(csv, 'share_code,value\n000001,10\n');
  const assets = factorDataAssets.map(item => ({ ...item, storageRef: item.assetId === 'factors.fund_warehouse.wide_today' ? csv : path.join(dir, path.basename(item.storageRef)) }));
  const root = path.join(dir, 'frozen');
  return { dir, csv, root, store: createFrozenSnapshotStore({ root, candidates: factorSnapshotCandidates, assets }) };
}

test('frozen data preserves original bytes and reuses content identities', async t => {
  const { store, csv, root } = await fixture(t);
  const first = await store.freeze(fundId, 'first');
  const second = await store.freeze(fundId, 'second');
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(second.item.title, 'first');
  assert.equal((await store.list()).length, 1);
  assert.equal(first.item.asOfDate, null);
  assert.equal(first.item.files.length, 1);
  assert.deepEqual(await readdir(root), [first.snapshotId]);
  await writeFile(csv, 'share_code,value\n000001,99\n');
  const next = await store.freeze(fundId);
  assert.notEqual(next.snapshotId, first.snapshotId);
  const resolved = await store.resolve(first.snapshotId, 'factors.fund_warehouse.wide_today');
  assert.match(await readFile(resolved.storageRef, 'utf8'), /000001,10/);
  await rm(csv);
  assert.equal((await store.verify(first.snapshotId)).verification, 'sha256_verified');
});

test('concurrent same-content freezes publish a single complete version', async t => {
  const { store, root } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => store.freeze(fundId)));
  assert.equal(new Set(results.map(item => item.snapshotId)).size, 1);
  assert.equal((await readdir(root)).length, 1);
  assert.equal((await store.verify(results[0].snapshotId)).files.length, 1);
});

test('new industry execution bundles include investability without invalidating legacy bundles', async t => {
  const { store, dir } = await fixture(t);
  await writeFile(path.join(dir, 'panel.parquet'), 'panel');
  await writeFile(path.join(dir, 'bench.parquet'), 'bench');
  const legacy = await store.freeze('snapshot.etf_smartbeta.industry_panel.current');
  assert.equal(legacy.item.files.length, 2);
  await assert.rejects(store.freeze('snapshot.etf_smartbeta.industry_execution.current'), /snapshot_source_unavailable/);
  await writeFile(path.join(dir, 'investable.parquet'), 'investable');
  const current = await store.freeze('snapshot.etf_smartbeta.industry_execution.current');
  assert.equal(current.item.files.length, 3);
  assert.notEqual(current.snapshotId, legacy.snapshotId);
  assert.equal((await store.verify(legacy.snapshotId)).files.length, 2);
  await rm(path.join(dir, 'investable.parquet'));
  assert.equal((await store.verify(current.snapshotId)).files.length, 3);
});

test('three bucket freeze binds all eight files and cannot reuse smaller bundles', async t => {
  const { store, dir } = await fixture(t);
  const names = ['broad', 'bench', 'panel', 'investable', 'basis', 'macro_pmi', 'macro_m2', 'macro_shibor'];
  for (const name of names.slice(0, -1)) await writeFile(path.join(dir, `${name}.parquet`), name);
  await assert.rejects(store.freeze('snapshot.etf_smartbeta.three_bucket_execution.current'), /snapshot_source_unavailable/);
  const old = await store.freeze('snapshot.etf_smartbeta.industry_execution.current');
  await writeFile(path.join(dir, 'macro_shibor.parquet'), 'shibor');
  const next = await store.freeze('snapshot.etf_smartbeta.three_bucket_execution.current');
  assert.equal(next.item.files.length, 8); assert.notEqual(next.snapshotId, old.snapshotId);
  await rm(path.join(dir, 'macro_shibor.parquet'));
  assert.equal((await store.verify(next.snapshotId)).files.length, 8);
  assert.equal((await store.verify(old.snapshotId)).files.length, 3);
});

test('tampered frozen bytes are rejected but metadata listings do not claim verification', async t => {
  const { store } = await fixture(t);
  const result = await store.freeze(fundId);
  const { storageRef } = await store.resolve(result.snapshotId, 'factors.fund_warehouse.wide_today');
  await chmod(storageRef, 0o600);
  await writeFile(storageRef, 'corrupt');
  await assert.rejects(store.verify(result.snapshotId), error => error.status === 409 && error.message === 'frozen_snapshot_integrity_failed');
  assert.equal((await store.list())[0].verification, 'not_checked_this_read');
  await assert.rejects(store.resolve(result.snapshotId, 'factors.fund_warehouse.wide_today'), /frozen_snapshot_integrity_failed/);
});

test('snapshot allowlist size limit and failed bundle leave no published files', async t => {
  const { store, root, csv } = await fixture(t);
  await assert.rejects(store.freeze('factors.fund_warehouse.monthly_update'), /unsupported_snapshot_freeze/);
  await assert.rejects(store.freeze(broadId), /snapshot_source_unavailable/);
  assert.deepEqual(await readdir(root), []);
  await truncate(csv, 64 * 1024 * 1024 + 1);
  await assert.rejects(store.freeze(fundId), /snapshot_freeze_size_limit/);
  assert.deepEqual(await readdir(root), []);
});

test('manifest identity and symlink data cannot redirect frozen reads', async t => {
  const { store, root, csv } = await fixture(t);
  await assert.rejects(store.read('../../outside'), /invalid_frozen_snapshot_id/);
  const result = await store.freeze(fundId);
  const manifest = path.join(root, result.snapshotId, 'manifest.json');
  await chmod(manifest, 0o600);
  const data = JSON.parse(await readFile(manifest, 'utf8'));
  data.files[0].fileName = '../wide_today.csv';
  await writeFile(manifest, JSON.stringify(data));
  await assert.rejects(store.verify(result.snapshotId), /invalid_frozen_snapshot_manifest/);
  await writeFile(manifest, JSON.stringify(result.item));
  const resolved = await store.resolve(result.snapshotId, 'factors.fund_warehouse.wide_today');
  await rm(resolved.storageRef);
  await symlink(csv, resolved.storageRef);
  await assert.rejects(store.verify(result.snapshotId), /frozen_snapshot_integrity_failed/);
});

test('frozen snapshot HTTP boundary rejects arbitrary files and mutation methods', async t => {
  const { store } = await fixture(t);
  const server = createServer({ snapshotStore: store });
  const route = '/api/modules/factors/v1/snapshots/frozen';
  assert.equal((await request(server, route)).json().count, 0);
  for (const payload of [null, [], { sourcePath: '/etc/passwd' }]) assert.equal((await request(server, route, { method: 'POST', body: JSON.stringify(payload) })).status, 422);
  assert.equal((await request(server, route, { method: 'POST', body: '{' })).status, 400);
  const created = await request(server, route, { method: 'POST', body: JSON.stringify({ baseSnapshotId: fundId }) });
  assert.equal(created.status, 201);
  const id = created.json().snapshotId;
  assert.equal((await request(server, `${route}/${id}/verify`, { method: 'POST' })).json().item.verification, 'sha256_verified');
  assert.equal((await request(server, `${route}/${id}`, { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await request(server, `${route}/${id}`, { method: 'HEAD' })).bytes().length, 0);
  assert.equal((await request(server, `/var/factors/frozen-snapshots/${id}/wide_today.csv`)).status, 404);
});

test('incomplete metadata is isolated from usable snapshot choices', async t => {
  const { store, root } = await fixture(t);
  const result = await store.freeze(fundId);
  const manifest = path.join(root, result.snapshotId, 'manifest.json');
  const data = JSON.parse(await readFile(manifest, 'utf8'));
  delete data.createdAt;
  await chmod(manifest, 0o600); await writeFile(manifest, JSON.stringify(data));
  assert.equal((await store.list())[0].status, 'invalid');
  await assert.rejects(store.verify(result.snapshotId), /invalid_frozen_snapshot_metadata/);
});
