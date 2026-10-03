import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
test('custom factor AST dependencies windows scoring and industry accounting', async () => {
  const {stderr}=await promisify(execFile)('python3',['-B','-m','unittest','discover','-s','tests','-p','factor_expression_test.py'],{cwd:fileURLToPath(new URL('../',import.meta.url)),timeout:30000});
  assert.match(stderr,/Ran 15 tests/);assert.match(stderr,/OK/);
});
