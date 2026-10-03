import { fileURLToPath } from 'node:url';
import { captureLegacyArchive, listLegacyArchives, verifyLegacyArchive } from '../modules/factors/src/legacy-assets.js';

const archiveRoot = fileURLToPath(new URL('../var/factors/legacy-archives', import.meta.url));
if (process.argv[2] === '--verify') {
  const { items, errors } = await listLegacyArchives(archiveRoot);
  if (errors.length) throw new Error('invalid_legacy_archive_manifest');
  if (!items.length) throw new Error('legacy_archive_not_found');
  for (const item of items) console.log(JSON.stringify(await verifyLegacyArchive(archiveRoot, item.archiveId)));
} else {
  console.log(JSON.stringify(await captureLegacyArchive({ sourceRoot: '/Users/samshi/Desktop/My Claude/etf-smartbeta', archiveRoot })));
}
