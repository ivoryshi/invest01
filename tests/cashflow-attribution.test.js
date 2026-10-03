import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('cashflow attribution closes same-flow wealth without adding IRR or counting deposits as return', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_cashflow_attribution_test.py'], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30000 });
  assert.match(stderr, /Ran 15 tests/); assert.match(stderr, /OK/);
});
