import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(moduleRoot, 'public');
const catalog = JSON.parse(await readFile(path.join(moduleRoot, 'data/catalog.json'), 'utf8'));
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'catalog.json'), JSON.stringify({
  schemaVersion: 1,
  indexedAt: catalog.indexedAt,
  reports: catalog.reports.map(report => ({
    archiveKey: report.archiveKey,
    sha256: report.sha256,
    mode: report.mode,
    date: report.report.report_date,
    title: report.report.title,
    summary: report.report.summary,
    edition: report.report.edition,
    cutoffAt: report.report.cutoff_at,
    qualityStatus: report.report.qa?.status || 'UNKNOWN',
    publicationKind: report.report.publication?.kind || (report.early ? 'early' : 'scheduled'),
    htmlUrl: report.htmlPath ? './' + report.htmlPath.replace(/^daily\//, '') : null,
    jsonUrl: report.jsonPath ? './' + report.jsonPath.replace(/^daily\//, '') : null,
    missing: report.report.qa?.missing || [],
    objects: report.report.objects || [],
    sources: report.report.sources || [],
  })),
}, null, 2));
console.log(`Built daily catalog: ${catalog.reports.length} reports`);
