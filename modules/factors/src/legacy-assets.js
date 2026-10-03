import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idValid = id => /^[a-f0-9]{64}$/.test(id);
const maxFileBytes = 64 * 1024 * 1024;
const roles = { 'report.json': 'backtest_report', 'app_data.json': 'chart_and_sensitivity', 'panel.json': 'monthly_factor_panel',
  'factor_study.json': 'factor_study', 'factor_loo.json': 'leave_one_out', 'lab_comps.json': 'comparison_curves',
  'turnover.json': 'cost_diagnostic', 'coverage_dataset.json': 'data_quality', 'coverage_report.json': 'data_quality', 'coverage_repair.json': 'data_quality' };
const legacyHtml = ['archive/factor-dca-lab.html', 'web/app.html', 'src/沪深300ETF_定投净值曲线.html'];
const identity = (assets, records) => hash(JSON.stringify({ assets, records }));

async function htmlRecords(captured, assets) {
  const records = [];
  for (const { relative, bytes } of captured.filter(item => item.relative.endsWith('.html'))) {
    const payload = await new Promise((resolve, reject) => {
      const child = execFile('python3', ['-B', fileURLToPath(new URL('./legacy_html_literals.py', import.meta.url))], { timeout: 10000, maxBuffer: 1024*1024 },
        (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); } } });
      child.stdin.on('error', reject); child.stdin.end(bytes);
    });
    const asset = assets.find(a => a.sourcePath === relative);
    if (payload.sourceSha256 !== asset.sha256) throw new Error('legacy_html_capture_hash_mismatch');
    for (const literal of payload.items) records.push({ recordId: hash(`${relative}:${literal.scriptIndex}:${literal.characterOffset}`),
      category: 'embedded_page_parameters', title: literal.literalName, sourcePath: relative, sourceAssetId: asset.assetId, sourceSha256: asset.sha256,
      jsonPointer: `script[${literal.scriptIndex}]:${literal.literalName}@${literal.characterOffset}`, literal,
      parameters: literal.parameters, parameterCompleteness: literal.parameters ? 'partial_embedded_json_only' : 'not_recovered', period: null, summary: {},
      comparisonPolicy: 'original_units_and_calendars_only_no_cross_record_aggregation', status: literal.status });
  }
  return records;
}

async function sourceBytes(root, relative) {
  const full = path.join(root, relative);
  if (await realpath(full) !== full) throw new Error('legacy_symlink_not_allowed');
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxFileBytes) throw new Error('legacy_file_size_or_type_not_allowed');
    const bytes = await file.readFile();
    if (bytes.length > maxFileBytes) throw new Error('legacy_file_size_or_type_not_allowed');
    return bytes;
  } finally { await file.close(); }
}

function recordsFor(assets, parsed) {
  const records = [];
  const add = (file, pointer, category, title, raw, parameters = null) => {
    const asset = assets.find(a => a.sourcePath === `out/${file}`);
    records.push({ recordId: hash(`${file}:${pointer}`), category, title: String(title), sourcePath: asset.sourcePath, sourceAssetId: asset.assetId,
      sourceSha256: asset.sha256, jsonPointer: pointer, parameters,
      parameterCompleteness: category === 'backtest_scenario' && raw.config ? 'exported_config_only' : parameters ? 'partial_weights_only' : 'not_exported',
      period: Array.isArray(raw.period) ? raw.period : null,
      summary: Object.fromEntries(['irr_strategy', 'irr_bench', 'final_strategy', 'final_bench_dca', 'total_cost', 'contributed', 'irr', 'excess', 'final', 'mdd', 'twr', 'solo_irr', 'solo_excess', 'marginal', 'weight'].filter(key => typeof raw[key] === 'number' && Number.isFinite(raw[key])).map(key => [key, raw[key]])),
      comparisonPolicy: 'original_units_and_calendars_only_no_cross_record_aggregation', status: 'readonly_imported_not_recomputed' });
  };
  const report = parsed.get('report.json');
  for (const key of ['base', 'stress', 'variant']) if (report?.[key] && typeof report[key] === 'object') add('report.json', `/${key}`, 'backtest_scenario', key, report[key], report[key].config ?? null);
  const arrays = [
    ['app_data.json', 'sensitivity', 'sensitivity_case', row => row.case],
    ['factor_study.json', 'decomp', 'factor_combination', row => row.name],
    ['factor_study.json', 'perturb', 'weight_perturbation', (_, i) => `权重扰动 ${i+1}`],
    ['factor_loo.json', 'cats', 'leave_one_out_diagnostic', row => row.cat],
  ];
  for (const [file, key, category, title] of arrays) {
    const values = parsed.get(file)?.[key];
    if (Array.isArray(values)) values.forEach((row, i) => { if (row && typeof row === 'object' && !Array.isArray(row)) add(file, `/${key}/${i}`, category, title(row, i) ?? `${key} ${i+1}`, row, row.weights ?? null); });
  }
  const comparisons = parsed.get('lab_comps.json');
  const variants = new Map((Array.isArray(comparisons?.b_variants) ? comparisons.b_variants : []).map(v => [`B_${v.key}`, v]));
  for (const [key, curve] of Object.entries(comparisons?.comps ?? {})) {
    if (!Array.isArray(curve)) continue;
    const variant = variants.get(key);
    add('lab_comps.json', `/comps/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, 'comparison_curve', variant?.label || key, {}, variant?.weights ?? null);
    records.at(-1).curve = { observations: curve.length, first: curve[0] ?? null, last: curve.at(-1) ?? null, dates: 'not_exported_in_this_file', unit: 'legacy_curve_original_not_inferred' };
  }
  return records;
}

function validateManifest(manifest, id) {
  if (manifest?.schemaVersion !== 1 || manifest.archiveId !== id || !Array.isArray(manifest.assets) || !Array.isArray(manifest.records) || identity(manifest.assets, manifest.records) !== id
    || new Set(manifest.assets.map(a => a.sourcePath)).size !== manifest.assets.length
    || manifest.assets.some(a => !/^(out\/[A-Za-z0-9_.-]+\.json|archive\/factor-dca-lab\.html|web\/app\.html|src\/沪深300ETF_定投净值曲线\.html)$/.test(a.sourcePath)
      || a.storagePath !== `files/${a.sourcePath}` || !idValid(a.sha256) || !Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > maxFileBytes)) throw new Error('invalid_legacy_archive_manifest');
  return manifest;
}

export async function readLegacyArchive(archiveRoot, id) {
  if (!idValid(id)) throw new Error('invalid_legacy_archive_id');
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, 'versions', id, 'manifest.json'), 'utf8'));
  return validateManifest(manifest, id);
}

export async function listLegacyArchives(archiveRoot) {
  let names;
  try { names = await readdir(path.join(archiveRoot, 'versions')); } catch (error) { if (error.code === 'ENOENT') return { items: [], errors: [] }; throw error; }
  const items = [], errors = [];
  for (const name of names.filter(idValid).sort()) {
    try {
      const m = await readLegacyArchive(archiveRoot, name);
      items.push({ archiveId: name, createdAt: m.createdAt, sourceProject: m.sourceProject, assetCount: m.assets.length, recordCount: m.records.length,
        categories: [...new Set(m.records.map(r => r.category))], verification: 'manifest_identity_only_not_file_integrity' });
    } catch { errors.push({ archiveId: name, error: 'invalid_legacy_archive_manifest' }); }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.archiveId.localeCompare(b.archiveId));
  return { items, errors };
}

export async function verifyLegacyArchive(archiveRoot, id) {
  const manifest = await readLegacyArchive(archiveRoot, id);
  const versionRoot = path.join(archiveRoot, 'versions', id);
  for (const asset of manifest.assets) {
    const bytes = await sourceBytes(versionRoot, asset.storagePath);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error('legacy_archive_integrity_failed');
  }
  return { archiveId: id, status: 'all_archived_bytes_verified', files: manifest.assets.length, records: manifest.records.length };
}

export async function captureLegacyArchive({ sourceRoot, archiveRoot }) {
  sourceRoot = path.resolve(sourceRoot); archiveRoot = path.resolve(archiveRoot);
  if (await realpath(sourceRoot) !== sourceRoot) throw new Error('legacy_symlink_not_allowed');
  const out = path.join(sourceRoot, 'out');
  if (await realpath(out) !== out) throw new Error('legacy_symlink_not_allowed');
  const names = (await readdir(out)).sort();
  if (names.length > 100) throw new Error('legacy_inventory_limit_exceeded');
  const paths = names.filter(name => /^[A-Za-z0-9_.-]+\.json$/.test(name)).map(name => `out/${name}`);
  for (const relative of legacyHtml) {
    try { await stat(path.join(sourceRoot, relative)); paths.push(relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  paths.sort();
  const captured = [], parsed = new Map();
  for (const relative of paths) {
    const bytes = await sourceBytes(sourceRoot, relative);
    if (bytes.length + captured.reduce((total, item) => total+item.bytes.length, 0) > 128*1024*1024) throw new Error('legacy_inventory_total_size_exceeded');
    if (relative.endsWith('.json')) parsed.set(path.basename(relative), JSON.parse(bytes.toString('utf8')));
    captured.push({ relative, bytes });
  }
  if (!captured.length) throw new Error('legacy_inventory_empty');
  const assets = captured.map(({ relative, bytes }) => ({ assetId: hash(relative+':'+hash(bytes)), sourcePath: relative, sha256: hash(bytes), bytes: bytes.length,
    role: roles[path.basename(relative)] || (relative.endsWith('.html') ? 'readonly_original_page_not_executed' : 'unmapped_export_preserved'), storagePath: `files/${relative}` }));
  const records = [...recordsFor(assets, parsed), ...await htmlRecords(captured, assets)], archiveId = identity(assets, records);
  const manifest = { schemaVersion: 1, archiveId, createdAt: new Date().toISOString(), sourceProject: sourceRoot, assets, records,
    inventory: { directories: ['out', 'archive', 'web', 'src'], outFiles: names, notCapturedOutFiles: names.filter(name => !/^[A-Za-z0-9_.-]+\.json$/.test(name)) },
    limitations: ['only_available_export_state_not_all_historical_runs', 'original_bytes_preserved_no_metric_recompute', 'missing_parameters_dates_and_units_not_invented', 'html_archived_as_data_never_embedded_or_executed', 'local_copy_not_external_backup'] };
  // Refuse a moving export set; every original is checked again before publishing.
  for (let i=0; i<captured.length; i++) if (hash(await sourceBytes(sourceRoot, captured[i].relative)) !== assets[i].sha256) throw new Error('legacy_source_changed_retry');
  if (JSON.stringify((await readdir(out)).sort()) !== JSON.stringify(names)) throw new Error('legacy_source_changed_retry');
  const versions = path.join(archiveRoot, 'versions'); await mkdir(versions, { recursive: true });
  const target = path.join(versions, archiveId), staging = path.join(versions, `.tmp-${randomUUID()}`);
  try {
    let exists = false;
    try { await stat(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) { await verifyLegacyArchive(archiveRoot, archiveId); return { archiveId, reused: true, assets: assets.length, records: manifest.records.length }; }
    await mkdir(staging);
    for (const { relative, bytes } of captured) { const destination = path.join(staging, 'files', relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' }); }
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2)+'\n', { flag: 'wx' });
    try { await rename(staging, target); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; await verifyLegacyArchive(archiveRoot, archiveId); }
    await verifyLegacyArchive(archiveRoot, archiveId);
    return { archiveId, reused: false, assets: assets.length, records: manifest.records.length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function queryLegacyRecords(manifest, { q = '', category = '', sourcePath = '', offset = 0, limit = 50 } = {}) {
  if (typeof q !== 'string' || q.length > 100 || typeof category !== 'string' || typeof sourcePath !== 'string'
    || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_legacy_archive_query');
  const matching = manifest.records.filter(row => (!category || row.category === category) && (!sourcePath || row.sourcePath === sourcePath)
    && (!q || `${row.recordId} ${row.title} ${row.category} ${row.jsonPointer}`.toLowerCase().includes(q.toLowerCase())));
  return { archiveId: manifest.archiveId, total: matching.length, offset, limit, items: matching.slice(offset, offset+limit), hasMore: offset+limit < matching.length };
}
