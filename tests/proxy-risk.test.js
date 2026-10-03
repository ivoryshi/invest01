import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('proxy risk and custom sensitivity use actual calculations and refuse unidentified models', async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'factor_proxy_risk_test.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 60000,
  });
  assert.match(stderr, /OK/);
});
