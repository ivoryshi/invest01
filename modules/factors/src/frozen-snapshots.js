import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const maxBytes = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 422) => Object.assign(new Error(message), { status });
export const frozenSnapshotIdValid = value => /^snapshot\.frozen\.[a-f0-9]{64}$/.test(value || '');

// Only these data files are eligible; scripts and live SQLite stores are excluded.
export const freezeBindings = {
  'snapshot.etf_smartbeta.three_bucket_execution.current': ['factors.etf_smartbeta.broad', 'factors.etf_smartbeta.bench', 'factors.etf_smartbeta.panel', 'factors.etf_smartbeta.investable', 'factors.etf_smartbeta.basis', 'factors.etf_smartbeta.macro_pmi', 'factors.etf_smartbeta.macro_m2', 'factors.etf_smartbeta.macro_shibor'],
  'snapshot.etf_smartbeta.industry_execution.current': ['factors.etf_smartbeta.panel', 'factors.etf_smartbeta.bench', 'factors.etf_smartbeta.investable'],
  'snapshot.fund_warehouse.wide_today.current': ['factors.fund_warehouse.wide_today'],
  'snapshot.etf_smartbeta.broad_panel.current': ['factors.etf_smartbeta.broad', 'factors.etf_smartbeta.bench'],
  'snapshot.etf_smartbeta.industry_panel.current': ['factors.etf_smartbeta.panel', 'factors.etf_smartbeta.bench'],
};

function contentId(baseSnapshotId, files) {
  const identity = { baseSnapshotId, files: files.map(({ assetId, sha256, bytes }) => ({ assetId, sha256, bytes })).sort((a, b) => a.assetId.localeCompare(b.assetId)) };
  return `snapshot.frozen.${hash(JSON.stringify(identity))}`;
}

export function createFrozenSnapshotStore({ root, candidates, assets }) {
  const byAsset = new Map(assets.map(item => [item.assetId, item]));
  const byCandidate = new Map(candidates.map(item => [item.snapshotId, item]));
  const directory = id => path.join(root, id);
  async function regularFile(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw fail('snapshot_file_not_regular');
    return info;
  }
  async function read(id) {
    if (!frozenSnapshotIdValid(id)) throw fail('invalid_frozen_snapshot_id', 400);
    try {
      const dirInfo = await lstat(directory(id));
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw fail('invalid_frozen_snapshot_directory');
      const manifestPath = path.join(directory(id), 'manifest.json');
      await regularFile(manifestPath);
      const item = JSON.parse(await readFile(manifestPath, 'utf8'));
      const expected = freezeBindings[item.baseSnapshotId];
      const candidate = byCandidate.get(item.baseSnapshotId);
      if (item.schemaVersion !== 1 || item.module !== 'factors' || typeof item.title !== 'string' || !item.title
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt
        || !candidate || item.universe !== candidate.universe || item.comparisonGroup !== candidate.comparisonGroup
        || item.frequency !== candidate.frequency || item.hashPolicy !== 'full_content_sha256') throw fail('invalid_frozen_snapshot_metadata');
      if (!expected || !byCandidate.has(item.baseSnapshotId) || item.snapshotId !== id || !Array.isArray(item.files)
        || item.files.length !== expected.length || new Set(item.files.map(file => file.assetId)).size !== expected.length
        || item.files.some(file => !expected.includes(file.assetId) || !/^[a-f0-9]{64}$/.test(file.sha256)
          || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.fileName !== path.basename(byAsset.get(file.assetId)?.storageRef || ''))
        || contentId(item.baseSnapshotId, item.files) !== id) throw fail('invalid_frozen_snapshot_manifest');
      if (item.totalBytes !== item.files.reduce((sum, file) => sum + file.bytes, 0) || item.totalBytes > maxBytes) throw fail('invalid_frozen_snapshot_manifest');
      return item;
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('frozen_snapshot_not_found', 404);
      if (error.status) throw error;
      throw fail('invalid_frozen_snapshot_manifest');
    }
  }
  async function verify(id) {
    const item = await read(id);
    for (const file of item.files) {
      try {
        const filePath = path.join(directory(id), file.fileName);
        const info = await regularFile(filePath);
        if (info.size !== file.bytes || hash(await readFile(filePath)) !== file.sha256) throw fail('frozen_snapshot_integrity_failed', 409);
      } catch (error) {
        if (error.status === 409) throw error;
        throw fail('frozen_snapshot_integrity_failed', 409);
      }
    }
    return { ...item, verification: 'sha256_verified' };
  }
  async function resolve(id, assetId) {
    const item = await verify(id);
    const file = item.files.find(file => file.assetId === assetId);
    if (!file) throw fail('snapshot_asset_not_bound');
    return { item, file, storageRef: path.join(directory(id), file.fileName) };
  }
  async function list() {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const items = [];
    for (const entry of entries.filter(item => frozenSnapshotIdValid(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      try { items.push({ ...await read(entry.name), status: 'frozen', verification: 'not_checked_this_read' }); }
      catch (error) { items.push({ snapshotId: entry.name, status: 'invalid', error: error.message }); }
    }
    return items;
  }
  async function freeze(baseSnapshotId, title = '') {
    const binding = freezeBindings[baseSnapshotId];
    const candidate = byCandidate.get(baseSnapshotId);
    if (!binding || !candidate) throw fail('unsupported_snapshot_freeze');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('invalid_frozen_snapshot_directory');
    const staging = path.join(root, `.pending-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const originals = [];
      let totalBytes = 0;
      for (const assetId of binding) {
        const asset = byAsset.get(assetId);
        if (!asset) throw fail('snapshot_source_unavailable', 404);
        let before;
        try { before = await regularFile(asset.storageRef); }
        catch (error) { if (error.code === 'ENOENT') throw fail('snapshot_source_unavailable', 404); throw error; }
        totalBytes += before.size;
        if (totalBytes > maxBytes) throw fail('snapshot_freeze_size_limit');
        const bytes = await readFile(asset.storageRef);
        const after = await regularFile(asset.storageRef);
        if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('snapshot_source_changed_retry', 409);
        const file = { assetId, fileName: path.basename(asset.storageRef), sha256: hash(bytes), bytes: bytes.length, sourceRef: asset.storageRef, sourceUpdatedAt: after.mtime.toISOString() };
        await writeFile(path.join(staging, file.fileName), bytes, { flag: 'wx', mode: 0o444 });
        originals.push(file);
      }
      // Recheck the entire bundle after copying, not only each file in isolation.
      for (const file of originals) {
        await regularFile(file.sourceRef);
        if (hash(await readFile(file.sourceRef)) !== file.sha256) throw fail('snapshot_source_changed_retry', 409);
      }
      const snapshotId = contentId(baseSnapshotId, originals);
      const item = {
        schemaVersion: 1, module: 'factors', snapshotId, baseSnapshotId, title: title || `${candidate.title} / frozen`, createdAt: new Date().toISOString(),
        universe: candidate.universe, comparisonGroup: candidate.comparisonGroup, frequency: candidate.frequency,
        asOfDate: null, periodStart: null, periodEnd: null, files: originals, assetIds: binding,
        totalBytes, hashPolicy: 'full_content_sha256', freezePolicy: 'explicit_local_copy_no_fetch_no_update',
        limitations: [...candidate.limitations, 'freeze_time_is_not_data_as_of_date', 'local_copy_not_external_backup'],
      };
      await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(item, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
      try { await rename(staging, directory(snapshotId)); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      return { item: await verify(snapshotId), snapshotId };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return { list, read, verify, resolve, freeze };
}
