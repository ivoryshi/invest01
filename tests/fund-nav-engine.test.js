import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('fund NAV histories bind selected sources without latest cross-section lookahead', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_fund_nav_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30000,
  });
  assert.match(stderr, /Ran 17 tests/); assert.match(stderr, /OK/);
});
