import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('DCA engine separates cashflows returns costs and unsupported configurations', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_dca_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000,
  });
  assert.match(stderr, /Ran 8 tests/);
  assert.match(stderr, /OK/);
});
