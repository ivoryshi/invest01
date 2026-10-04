import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('selected fund snapshots preserve read transactions and replay independent of the changing live database', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_fund_snapshot_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30000,
  });
  assert.match(stderr, /Ran 8 tests/); assert.match(stderr, /OK/);
});
