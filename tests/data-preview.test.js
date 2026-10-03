import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('factor dataset reader validates bounded CSV and parquet queries', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_data_preview_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000,
  });
  assert.match(stderr, /Ran 5 tests/);
  assert.match(stderr, /OK/);
});
