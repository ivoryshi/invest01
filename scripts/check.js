import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'var'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (file.endsWith('.js')) {
      if (file.includes(path.sep+'modules'+path.sep) && file.includes(path.sep+'public'+path.sep)) {
        new Script(await readFile(file,'utf8'), {filename:file});
        continue;
      }
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Syntax check failed: ${file}`);
    } else if (file.endsWith('.md')) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#)/.test(match[1])) continue;
        await readFile(path.resolve(path.dirname(file), match[1].replace(/^<|>$/g, '')));
      }
    }
  }
}
await walk(root);
console.log('JavaScript syntax and Markdown links passed');
