import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/api/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, 'var/registry');
const oldResearchRoot = '/Users/samshi/dev/投研工具';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileHash(relative) {
  return sha256(await readFile(path.join(root, relative)));
}

async function researchReportIndexHash() {
  const dir = path.join(oldResearchRoot, 'reports');
  const rows = [];
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.md')).sort()) {
    const info = await stat(path.join(dir, name));
    rows.push([name, info.size, info.mtime.toISOString()].join('|'));
  }
  return { hash: sha256(rows.join('\n')), count: rows.length };
}

async function getJson(server, url) {
  const response = await server.dispatch({ url });
  if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
  return JSON.parse(String(response.body));
}

const server = createServer();
const [sources, artifacts, entities, tasks, reportIndex] = await Promise.all([
  getJson(server, '/api/registry/v1/sources'),
  getJson(server, '/api/registry/v1/artifacts?limit=100'),
  getJson(server, '/api/registry/v1/entities?limit=200'),
  getJson(server, '/api/registry/v1/tasks'),
  researchReportIndexHash(),
]);
const factorAssets = await getJson(server, '/api/modules/factors/v1/assets');
const factorSnapshots = await getJson(server, '/api/modules/factors/v1/snapshots');
const factorFrozenSnapshots = await getJson(server, '/api/modules/factors/v1/snapshots/frozen');
const factorDefinitions = await getJson(server, '/api/modules/factors/v1/definitions');
const factorLibrary = await getJson(server, '/api/modules/factors/v1/library');
const factorArtifacts = await getJson(server, '/api/modules/factors/v1/artifact-candidates');
const factorExperimentConfigs = await getJson(server, '/api/modules/factors/v1/experiment-configs');
const factorLabFramework = await getJson(server, '/api/modules/factors/v1/lab-framework');
const factorVisualLab = await getJson(server, '/api/modules/factors/v1/visual-lab');
const factorExperimentComparison = await getJson(server, '/api/modules/factors/v1/experiment-comparison');
const factorProductState = await getJson(server, '/api/modules/factors/v1/product-state');
const factorExecutionPlan = await getJson(server, '/api/modules/factors/v1/execution-plan');
const factorBacktestEngine = await getJson(server, '/api/modules/factors/v1/backtest-engine');
const factorRunRequests = await getJson(server, '/api/modules/factors/v1/run-requests');
const factorResultArtifacts = await getJson(server, '/api/modules/factors/v1/result-artifacts');
const factorDataLayer = await getJson(server, '/api/modules/factors/v1/data-layer');
const factorDataSchema = await getJson(server, '/api/modules/factors/v1/data-layer/schema');
const factorDataQuality = await getJson(server, '/api/modules/factors/v1/data-quality');
const factorLegacyExperiments = await getJson(server, '/api/modules/factors/v1/legacy-experiments');
const factorLegacyArchives = await getJson(server, '/api/modules/factors/v1/legacy-archives');

const generatedAt = new Date().toISOString();
const snapshot = {
  schemaVersion: 1,
  apiVersion: 'v1',
  generatedAt,
  generator: 'scripts/snapshot-registry.js',
  mode: 'readonly_snapshot',
  inputs: {
    observatoryConfig: {
      path: 'modules/observatory/public/research-config.json',
      sha256: await fileHash('modules/observatory/public/research-config.json'),
    },
    factorContract: {
      path: 'packages/contracts/factors.js',
      sha256: await fileHash('packages/contracts/factors.js'),
    },
    researchReportsIndex: {
      path: `${oldResearchRoot}/reports`,
      sha256: reportIndex.hash,
      count: reportIndex.count,
      note: 'hash covers file names, byte sizes, and mtimes; report bodies are not read',
    },
  },
  registries: {
    sources,
    artifacts,
    entities,
    tasks,
    factorAssets,
    factorSnapshots,
    factorFrozenSnapshots,
    factorDefinitions,
    factorLibrary,
    factorArtifacts,
    factorExperimentConfigs,
    factorLabFramework,
    factorVisualLab,
    factorExperimentComparison,
    factorProductState,
    factorExecutionPlan,
    factorBacktestEngine,
    factorRunRequests,
    factorResultArtifacts,
    factorDataLayer,
    factorDataSchema,
    factorDataQuality,
    factorLegacyExperiments,
    factorLegacyArchives,
  },
  counts: {
    sources: sources.count,
    artifacts: artifacts.count,
    entities: entities.count,
    tasks: tasks.count,
    factorAssets: factorAssets.count,
    factorSnapshots: factorSnapshots.count,
    factorFrozenSnapshots: factorFrozenSnapshots.count,
    factorDefinitions: factorDefinitions.count,
    factorDefinitionSlots: factorDefinitions.slotCount,
    factorLibraryFamilies: factorLibrary.count,
    factorLibraryFields: factorLibrary.fieldCount,
    factorArtifacts: factorArtifacts.count,
    factorExperimentConfigs: factorExperimentConfigs.count,
    factorLabCapabilities: factorLabFramework.capabilityCount,
    factorLabStrategies: factorLabFramework.strategyTemplates.length,
    factorLabResultViews: factorLabFramework.resultViews.length,
    factorVisualSeries: Object.keys(factorVisualLab.series).length,
    factorVisualAccountSeries: Object.keys(factorVisualLab.account).length,
    factorVisualSensitivityCases: factorVisualLab.sensitivity.length,
    factorVisualPositioningPoints: factorVisualLab.factorPositioning.length,
    factorExperimentComparisonItems: factorExperimentComparison.count,
    factorExperimentComparisonVariants: factorExperimentComparison.variants.length,
    factorProductWorkflowSteps: factorProductState.workflow.length,
    factorProductStrategyTools: factorProductState.strategyTools.length,
    factorProductErrorModels: factorProductState.errorModel.length,
    factorExecutionStages: factorExecutionPlan.executionStages.length,
    factorExecutionEngineCandidates: factorExecutionPlan.engineCandidates.length,
    factorBacktestEngineModes: 1 + factorBacktestEngine.nextEngines.length,
    factorBacktestAuditChecks: factorBacktestEngine.auditChecklist.length,
    factorRunRequests: factorRunRequests.count,
    factorResultArtifacts: factorResultArtifacts.count,
    factorDataLayerUpdateJobs: factorDataLayer.updateJobCount,
    factorDataLayerLegacyExports: factorDataLayer.legacyExportCount,
    factorDataSchemaAssets: factorDataSchema.count,
    factorDataQualityChecks: factorDataQuality.preBacktestChecks.length,
    factorDataQualityIssues: factorDataQuality.coverage.issues.length,
    factorTurnoverAuditItems: factorDataQuality.turnoverAudit.count,
    factorLegacyExperiments: factorLegacyExperiments.count,
    factorLegacyExperimentAssets: factorLegacyExperiments.assetCount,
    factorLegacyArchiveVersions: factorLegacyArchives.items.length,
    factorLegacyArchivedRecords: factorLegacyArchives.items.reduce((total, item) => total+item.recordCount, 0),
    factorLegacyArchiveManifestErrors: factorLegacyArchives.errors.length,
  },
};

await mkdir(outDir, { recursive: true });
// Readers continue using the previous complete snapshot until replacement.
const temporaryFile = path.join(outDir, `.snapshot-${randomUUID()}.tmp`);
try {
  await writeFile(temporaryFile, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryFile, path.join(outDir, 'latest.json'));
} finally {
  await rm(temporaryFile, { force: true });
}
console.log(`registry snapshot written: ${path.relative(root, path.join(outDir, 'latest.json'))}`);
console.log(JSON.stringify(snapshot.counts));
