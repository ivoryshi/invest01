import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executePinnedPython } from '../modules/factors/src/pinned-python.js';

test('Python calculation fingerprint describes captured source despite in-flight edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinned-engine-'));
  const source = path.join(root, 'engine.py');
  const ready = path.join(root, 'ready');
  const text = 'import sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text("ready")\ntime.sleep(0.25)\nprint("A:"+sys.argv[2])\n';
  let running;
  try {
    await writeFile(source, text);
    running = executePinnedPython(source, [ready, 'preserved_arg'], { timeout: 5000 });
    let observed = false;
    for (let i = 0; i < 100 && !observed; i += 1) {
      try { observed = (await readFile(ready, 'utf8')) === 'ready'; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(observed, 'captured source has started');
    await writeFile(source, 'print("B")\n');
    const result = await running;
    assert.equal(result.stdout.trim(), 'A:preserved_arg');
    assert.equal(result.sha256, createHash('sha256').update(text).digest('hex'));
    assert.notEqual(result.sha256, createHash('sha256').update(await readFile(source)).digest('hex'));
  } finally {
    if (running) await running.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('Python dependency fingerprints describe imported captured bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinned-modules-'));
  const source = path.join(root, 'engine.py'), dependency = path.join(root, 'calculator.py'), ready = path.join(root, 'ready');
  const depText = 'VALUE="captured"\n';
  let running;
  try {
    await writeFile(source, 'import sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text("ready")\ntime.sleep(.25)\nimport calculator\nprint(calculator.VALUE)\n');
    await writeFile(dependency, depText);
    running = executePinnedPython(source, [ready], { timeout: 5000, modules: [{ name: 'calculator', path: dependency }] });
    let observed = false;
    for (let i = 0; i < 100 && !observed; i += 1) {
      try { observed = (await readFile(ready, 'utf8')) === 'ready'; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(observed);
    await writeFile(dependency, 'VALUE="changed"\n');
    const result = await running;
    assert.equal(result.stdout.trim(), 'captured');
    assert.equal(result.sourceHashes[1].sha256, createHash('sha256').update(depText).digest('hex'));
    assert.equal(result.sourceHashes[1].moduleName, 'calculator');
    await assert.rejects(executePinnedPython(source, [], { modules: [{ name: '../escape', path: dependency }] }), /invalid_pinned_module_name/);
  } finally {
    if (running) await running.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
