import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// Execute the exact captured bytes, even if the editable source changes in flight.
const shim = `import base64,json,sys,types
bundle=json.loads(base64.b64decode(sys.argv[1]))
sys.argv=[bundle["main"]["path"]]+sys.argv[2:]
for item in bundle["modules"]:
    module=types.ModuleType(item["name"])
    module.__file__=item["path"]
    sys.modules[item["name"]]=module
    exec(compile(base64.b64decode(item["source"]),item["path"],"exec"),module.__dict__)
item=bundle["main"]
exec(compile(base64.b64decode(item["source"]),item["path"],"exec"),{"__name__":"__main__","__file__":item["path"]})`;
export async function executePinnedPython(sourcePath, args, options = {}) {
  const { modules = [], ...executionOptions } = options;
  if (new Set(modules.map(item => item.name)).size !== modules.length || modules.some(item => !/^[a-z][a-z0-9_]*$/.test(item.name))) throw new Error('invalid_pinned_module_name');
  const bytes = await readFile(sourcePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const captured = [];
  const sourceHashes = [{ moduleName: '__main__', sha256 }];
  for (const item of modules) {
    const source = await readFile(item.path);
    captured.push({ name: item.name, path: item.path, source: source.toString('base64') });
    sourceHashes.push({ moduleName: item.name, sha256: createHash('sha256').update(source).digest('hex') });
  }
  const bundle = Buffer.from(JSON.stringify({ main: { path: sourcePath, source: bytes.toString('base64') }, modules: captured })).toString('base64');
  const result = await promisify(execFile)('python3', ['-B', '-c', shim, bundle, ...args], { timeout: 60000, maxBuffer: 32 * 1024 * 1024, ...executionOptions });
  return { ...result, sha256, sourceHashes };
}
