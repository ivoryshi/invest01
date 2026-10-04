import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { dispatchRequest } from '../apps/api/server.js';
import { readLegacyArchive, verifyLegacyArchive } from '../modules/factors/src/legacy-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prefix = '/api/modules/factors/v1';
const probes = [
  ['library', data => data.count >= 12 && data.fieldCount >= 64],
  ['experiment-configs', data => Array.isArray(data.items) && data.templates?.length >= 5],
  ['assets', data => data.items?.length >= 16],
  ['snapshots', data => data.items?.length >= 6],
  ['snapshots/frozen', data => Array.isArray(data.items)],
  ['visual-lab', data => data.seriesMeta?.length === 7 && data.factorPositioning?.length === 4],
  ['experiment-comparison', data => data.items?.length === 13 && data.variants?.length === 8],
  ['industry-engine/options', data => data.families?.length === 7],
  ['legacy-dca/options', data => data.priceObservations === 3446 && data.peObservations === 5179 && data.temporalEligibility?.status === 'not_point_in_time_verified'],
  ['three-bucket-engine/options', data => !!data.defaults && !!data.defaults.startDate],
  ['custom-expression/options', data => Array.isArray(data.families)],
  ['fund-nav/catalog?q=014165', data => data.database?.storage === 'workbench_sqlite'],
  ['fund-screen/options', data => Array.isArray(data.fields)],
  ['backtest-tools', data => data.strategies?.length === 5 && data.commands?.includes('audit')],
  ['backtest-tools/skill', data => data.name === 'factor-backtest' && data.content?.includes('point_in_time_verified')],
  ['execution-plan', data => Array.isArray(data.configReadiness) && Array.isArray(data.runRequests)],
  ['run-requests', data => Array.isArray(data.items)],
  ['result-artifacts', data => Array.isArray(data.items)],
  ['data-layer', data => !!data.databaseMaintenance],
  ['legacy-archives', data => data.items?.length > 0 && !data.errors?.length],
];

async function stateIdentity() {
  const research = {};
  for (const name of ['library-submissions', 'experiment-configs', 'run-requests', 'result-artifacts']) {
    const bytes = await readFile(path.join(root, `var/factors/${name}.json`));
    research[name] = { sha256: sha(bytes), count: JSON.parse(bytes).items.length };
  }
  const db = await stat(path.join(root, 'var/factors/fund-history.sqlite'));
  return { research, database: { bytes: db.size, mtimeMs: db.mtimeMs, verification: 'size_mtime_only_not_full_content' } };
}

export async function auditMigration() {
  const before = await stateIdentity(), checks = [], results = new Map();
  for (const [endpoint, validate] of probes) {
    try {
      const response = await dispatchRequest({}, { url: `${prefix}/${endpoint}` });
      const data = JSON.parse(response.body); results.set(endpoint, data);
      checks.push({ id: endpoint, status: response.status === 200 && validate(data) ? 'passed' : 'failed', httpStatus: response.status });
    } catch (error) { checks.push({ id: endpoint, status: 'failed', error: error.message }); }
  }
  const archiveRoot = path.join(root, 'var/factors/legacy-archives'), archives = [];
  for (const row of results.get('legacy-archives')?.items || []) {
    try { archives.push(await verifyLegacyArchive(archiveRoot, row.archiveId)); }
    catch (error) { archives.push({ archiveId: row.archiveId, status: 'failed', error: error.message }); }
  }
  checks.push({ id: 'all_archive_bytes', status: archives.length && archives.every(row => row.status === 'all_archived_bytes_verified') ? 'passed' : 'failed' });
  const latest = results.get('legacy-archives')?.items?.[0], currentSource = [];
  if (latest) {
    const manifest = await readLegacyArchive(archiveRoot, latest.archiveId);
    for (const asset of manifest.assets) {
      try { const bytes = await readFile(path.join(manifest.sourceProject, asset.sourcePath)); currentSource.push({ sourcePath: asset.sourcePath, archivedSha256: asset.sha256, currentSha256: sha(bytes), status: sha(bytes) === asset.sha256 ? 'matched' : 'source_changed_recapture_required' }); }
      catch { currentSource.push({ sourcePath: asset.sourcePath, status: 'source_unavailable_archive_preserved' }); }
    }
  }
  checks.push({ id: 'current_source_captured', status: currentSource.length === 13 && currentSource.every(row => row.status === 'matched') ? 'passed' : 'failed' });
  const after = await stateIdentity();
  checks.push({ id: 'research_and_database_metadata_unchanged', status: JSON.stringify(before) === JSON.stringify(after) ? 'passed' : 'failed' });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    status: checks.every(row => row.status === 'passed') ? 'readonly_baseline_passed_acceptance_review_required' : 'failed',
    checks, archives, currentSource, state: after,
    scope: 'factor_v1_readonly_api_archive_baseline_not_full_product_acceptance',
    limitations: ['不执行新回测或浏览器交互，完整验收须另附自动回归与实际浏览器证据。', '数据库这里只比大小/mtime，不证明内容全量质量；归档逐字节SHA另行核验。', 'PIT/真实成交/缺失更早历史记录仍未验收；样式与架构后置V2，其他模块核心业务仍待迁入。'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('no_options_supported');
    const report = await auditMigration(), output = path.join(root, 'var/factors/migration-acceptance/latest.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks, archives: report.archives.length, output }, null, 2));
    if (report.status === 'failed') process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
