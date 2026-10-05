import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePinnedPython } from './pinned-python.js';
import { readLegacyDcaSource } from './legacy-assets.js';

const maxBytes = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 422) => Object.assign(new Error(message), { status });
export const frozenSnapshotIdValid = value => /^snapshot\.frozen\.[a-f0-9]{64}$/.test(value || '');

export const fundNavSnapshotId = 'snapshot.fund_warehouse.nav_db.current';
export const legacyDcaSnapshotId = 'snapshot.legacy.510300.archive';
function legacySelection(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'archiveId,sourceSha256'
    || !/^[a-f0-9]{64}$/.test(value.archiveId || '') || !/^[a-f0-9]{64}$/.test(value.sourceSha256 || '')) throw fail('legacy_dca_archive_selection_required');
  return { archiveId: value.archiveId, sourceSha256: value.sourceSha256 };
}
// The SQLite binding exports a selected transaction, never copies the live database file.
export const freezeBindings = {
  [legacyDcaSnapshotId]: ['factors.legacy.510300'],
  [fundNavSnapshotId]: ['factors.fund_warehouse.nav_db'],
  'snapshot.etf_smartbeta.three_bucket_execution.current': ['factors.etf_smartbeta.broad', 'factors.etf_smartbeta.bench', 'factors.etf_smartbeta.panel', 'factors.etf_smartbeta.investable', 'factors.etf_smartbeta.basis', 'factors.etf_smartbeta.macro_pmi', 'factors.etf_smartbeta.macro_m2', 'factors.etf_smartbeta.macro_shibor'],
  'snapshot.etf_smartbeta.industry_execution.current': ['factors.etf_smartbeta.panel', 'factors.etf_smartbeta.bench', 'factors.etf_smartbeta.investable'],
  'snapshot.fund_warehouse.wide_today.current': ['factors.fund_warehouse.wide_today'],
  'snapshot.etf_smartbeta.broad_panel.current': ['factors.etf_smartbeta.broad', 'factors.etf_smartbeta.bench'],
  'snapshot.etf_smartbeta.industry_panel.current': ['factors.etf_smartbeta.panel', 'factors.etf_smartbeta.bench'],
};

function normalizedSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'benchmarkId,codes,sourceVersions'
    || !Array.isArray(value.codes) || value.codes.length < 1 || value.codes.length > 10 || value.codes.some(code => !/^[0-9]{6}$/.test(code))
    || value.codes.some(code => typeof code !== 'string') || new Set(value.codes).size !== value.codes.length
    || typeof value.benchmarkId !== 'string' || !/^[A-Z][A-Z0-9_]{1,20}$/.test(value.benchmarkId) || !Array.isArray(value.sourceVersions)) throw fail('fund_snapshot_selection_required');
  const codes = [...value.codes].sort();
  const ids = ['universe_master', ...value.codes.map(code => 'nav.'+code), 'benchmark.'+value.benchmarkId];
  if (value.sourceVersions.length !== ids.length || value.sourceVersions.some((row,i) => !row || row.sourceId !== ids[i]
    || Object.keys(row).sort().join(',') !== 'bytes,sha256,sourceId' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)) throw fail('fund_snapshot_selection_required');
  const versions = new Map(value.sourceVersions.map(row => [row.sourceId, row]));
  return { codes, benchmarkId: value.benchmarkId, sourceVersions: ['universe_master', ...codes.map(code => 'nav.'+code), 'benchmark.'+value.benchmarkId].map(id => {
    const row = versions.get(id); return { sourceId: row.sourceId, sha256: row.sha256, bytes: row.bytes };
  }) };
}

function normalizedCaptureSources(value) {
  const names = ['__main__', 'fund_history_store'];
  if (!Array.isArray(value) || value.length !== names.length || value.some((row, i) => !row || row.moduleName !== names[i]
    || Object.keys(row).sort().join(',') !== 'moduleName,sha256' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256))) throw fail('invalid_fund_snapshot_capture_sources');
  return value.map(({ moduleName, sha256 }) => ({ moduleName, sha256 }));
}

function contentId(baseSnapshotId, files, selection, captureSources) {
  const identity = { baseSnapshotId, files: files.map(({ assetId, sha256, bytes }) => ({ assetId, sha256, bytes })).sort((a, b) => a.assetId.localeCompare(b.assetId)) };
  if (baseSnapshotId === fundNavSnapshotId) { identity.selection = normalizedSelection(selection); identity.captureSources = normalizedCaptureSources(captureSources); }
  if (baseSnapshotId === legacyDcaSnapshotId) identity.selection = legacySelection(selection);
  return `snapshot.frozen.${hash(JSON.stringify(identity))}`;
}

export function createFrozenSnapshotStore({ root, candidates, assets, legacyArchiveRoot }) {
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
        || (![fundNavSnapshotId, legacyDcaSnapshotId].includes(item.baseSnapshotId) && item.selection !== undefined)
        || (item.baseSnapshotId === legacyDcaSnapshotId && item.files[0].sha256 !== item.selection?.sourceSha256)
        || contentId(item.baseSnapshotId, item.files, item.selection, item.captureSources) !== id) throw fail('invalid_frozen_snapshot_manifest');
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
  async function freeze(baseSnapshotId, title = '', selection) {
    const binding = freezeBindings[baseSnapshotId];
    const candidate = byCandidate.get(baseSnapshotId);
    if (!binding || !candidate) throw fail('unsupported_snapshot_freeze');
    if (baseSnapshotId === fundNavSnapshotId) normalizedSelection(selection);
    else if (baseSnapshotId === legacyDcaSnapshotId) legacySelection(selection);
    else if (selection !== undefined) throw fail('unexpected_snapshot_selection');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('invalid_frozen_snapshot_directory');
    const staging = path.join(root, `.pending-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const originals = [];
      let totalBytes = 0;
      let capturedSelection;
      let captureSources;
      for (const assetId of binding) {
        const asset = byAsset.get(assetId);
        if (!asset) throw fail('snapshot_source_unavailable', 404);
        if (baseSnapshotId === legacyDcaSnapshotId) {
          if (!legacyArchiveRoot) throw fail('legacy_archive_root_unavailable');
          const chosen = legacySelection(selection);
          const source = await readLegacyDcaSource(legacyArchiveRoot, chosen.archiveId);
          if (source.sha256 !== chosen.sourceSha256) throw fail('legacy_dca_source_version_mismatch', 409);
          const bytes = await readFile(source.storageRef);
          if (bytes.length > maxBytes) throw fail('snapshot_freeze_size_limit');
          if (hash(bytes) !== chosen.sourceSha256) throw fail('snapshot_source_changed_retry', 409);
          await readLegacyDcaSource(legacyArchiveRoot, chosen.archiveId);
          const file = { assetId, fileName: path.basename(asset.storageRef), sha256: hash(bytes), bytes: bytes.length };
          await writeFile(path.join(staging, file.fileName), bytes, { flag: 'wx', mode: 0o444 });
          originals.push(file); totalBytes = bytes.length; capturedSelection = chosen;
          continue;
        }
        if (baseSnapshotId === fundNavSnapshotId) {
          const source = fileURLToPath(new URL('./fund_history_snapshot.py', import.meta.url));
          const result = await executePinnedPython(source, [asset.storageRef, path.join(staging, path.basename(asset.storageRef)), JSON.stringify(selection)],
            { modules: [{ name: 'fund_history_store', path: fileURLToPath(new URL('./fund_history_store.py', import.meta.url)) }], timeout: 60000, maxBuffer: 1024*1024 });
          const captured = JSON.parse(result.stdout);
          if (captured.error) throw fail(captured.error, /source_version_changed/.test(captured.error) ? 409 : 422);
          capturedSelection = captured.selection; captureSources = result.sourceHashes;
          const bytes = await readFile(path.join(staging, path.basename(asset.storageRef)));
          if (bytes.length > maxBytes || bytes.length !== captured.bytes || hash(bytes) !== captured.sha256) throw fail('snapshot_freeze_size_limit');
          totalBytes += bytes.length;
          originals.push({ assetId, fileName: path.basename(asset.storageRef), sha256: captured.sha256, bytes: captured.bytes, sourceRef: asset.storageRef });
          continue;
        }
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
        if ([fundNavSnapshotId, legacyDcaSnapshotId].includes(baseSnapshotId)) continue;
        await regularFile(file.sourceRef);
        if (hash(await readFile(file.sourceRef)) !== file.sha256) throw fail('snapshot_source_changed_retry', 409);
      }
      const snapshotId = contentId(baseSnapshotId, originals, capturedSelection, captureSources);
      const item = {
        schemaVersion: 1, module: 'factors', snapshotId, baseSnapshotId, title: title || `${candidate.title} / frozen`, createdAt: new Date().toISOString(),
        universe: candidate.universe, comparisonGroup: candidate.comparisonGroup, frequency: candidate.frequency,
        asOfDate: null, periodStart: null, periodEnd: null, files: originals, assetIds: binding,
        totalBytes, hashPolicy: 'full_content_sha256', freezePolicy: 'explicit_local_copy_no_fetch_no_update',
        ...(capturedSelection ? { selection: capturedSelection, ...(captureSources ? {captureSources} : {}), capturePolicy: baseSnapshotId === legacyDcaSnapshotId ? 'whitelisted_archive_content_copy' : 'selected_full_history_sqlite_read_transaction' } : {}),
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
