import { readdirSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const moduleRoot = fileURLToPath(new URL('../../modules/', import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
export function moduleAssets(enabled = ['observatory', 'daily']) {
  const entries = new Map();
  for (const name of enabled) {
    const root = path.join(moduleRoot, name, 'public');
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && mime[path.extname(file)]) {
          const rel = path.relative(root, file).split(path.sep).join('/');
          const value = { file, root, type: mime[path.extname(file)] };
          entries.set(`/modules/${name}/${rel}`, value);
          if (rel === 'index.html') entries.set(`/modules/${name}/`, value);
        }
      }
    }
    try { walk(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return entries;
}
export function readPublicAsset(asset) {
  const file = realpathSync(asset.file);
  if (!file.startsWith(realpathSync(asset.root) + path.sep)) throw new Error('Asset escaped public root');
  return readFileSync(file);
}
export function modulePolicy(body, type) {
  // Original report bytes stay unchanged. Authorize only their exact inline scripts/handlers.
  const hashes = [];
  const hash = value => "'sha256-" + createHash('sha256').update(value).digest('base64') + "'";
  if (type.startsWith('text/html')) {
    const html = body.toString();
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) hashes.push(hash(match[1]));
    for (const match of html.matchAll(/\son(?:click|change|submit)="([^"]*)"/g)) hashes.push(hash(match[1]));
  }
  return `default-src 'self'; script-src 'self' 'unsafe-hashes' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'none'`;
}
