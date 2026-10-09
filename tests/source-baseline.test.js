import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createServer } from '../apps/api/server.js';
import { request } from './helpers.js';

const missingExport = async () => { throw Object.assign(new Error('private/path/not/for/client'), { code: 'ENOENT' }); };
test('missing private exports do not break source-only metadata or health', async () => {
  const server = createServer({ legacyExportReader: missingExport });
  for (const route of ['visual-lab', 'experiment-comparison', 'product-state']) {
    const response = await request(server, `/api/modules/factors/v1/${route}`);
    assert.equal(response.status, 503);
    assert.deepEqual(response.json(), { error: 'data_source_unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await request(server, '/api/modules/factors/v1/visual-lab', { method: 'HEAD' })).text(), '');
  for (const route of ['/', '/app.js', '/api/workspaces', '/api/modules/factors/v1/library', '/api/modules/factors/v1/lab-framework']) {
    assert.equal((await request(server, route)).status, 200, route);
  }
  assert.equal((await request(server, '/api/health')).json().version, '0.5.6');
});
test('unexpected export failure is sanitized and subsequent requests still work', async () => {
  const server = createServer({ legacyExportReader: async () => { throw new SyntaxError('private malformed JSON'); } });
  const response = await request(server, '/api/modules/factors/v1/visual-lab');
  assert.equal(response.status, 500);
  assert.deepEqual(response.json(), { error: 'request_failed' });
  assert.equal((await request(server, '/api/health')).status, 200);
});
test('HTTP callback contains request-stream failures without an unhandled rejection', async () => {
  const server = createServer();
  const req = { method: 'POST', url: '/', async *[Symbol.asyncIterator]() { throw new Error('private stream failure'); } };
  let status, body;
  const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
  await server.listeners('request')[0](req, res);
  assert.equal(status, 500);
  assert.deepEqual(JSON.parse(body), { error: 'request_failed' });
});
test('HTTP callback returns the same missing-data contract as direct dispatch', async () => {
  const server = createServer({ legacyExportReader: missingExport });
  const req = { method: 'GET', url: '/api/modules/factors/v1/visual-lab', async *[Symbol.asyncIterator]() {} };
  let status, body;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(value) { body = value; } };
  await server.listeners('request')[0](req, res);
  assert.equal(status, 503);
  assert.deepEqual(JSON.parse(body), { error: 'data_source_unavailable' });
});

const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
function element(tag, text, className) {
  return { tag, text, className, children: [], append(...nodes) { this.children.push(...nodes); } };
}
const reported = [];
const context = vm.createContext({ element, showError: error => reported.push(error.message) });
vm.runInContext(source.slice(source.indexOf('async function appendWorkspacePanels('), source.indexOf('async function researchPanel(')), context);
test('one failed factor panel does not suppress later functional panels', async () => {
  const target = element('main');
  await context.appendWorkspacePanels(target, [
    ['Missing export', missingExport], ['Library', async () => element('section', 'available')],
  ], () => true);
  assert.equal(target.children.length, 2);
  assert.equal(target.children[0].children[0].text, 'Missing export');
  assert.equal(target.children[1].text, 'available');
  assert.ok(!JSON.stringify(target).includes('private/path'));
});
test('departed workspace does not receive a pending panel or load later panels', async () => {
  const target = element('main');
  let current = true, release, later = false;
  const pending = context.appendWorkspacePanels(target, [
    ['Pending', () => new Promise(resolve => { release = resolve; })],
    ['Later', async () => { later = true; return element('section'); }],
  ], () => current);
  current = false;
  release(element('section'));
  await pending;
  assert.equal(target.children.length, 0);
  assert.equal(later, false);
});
test('late request and JSON errors from a departed render cannot overwrite the new workspace', async () => {
  for (const error of [new Error('fetch rejected'), new SyntaxError('JSON rejected')]) {
    let reject, current = true;
    const pending = context.runWorkspaceRender(() => new Promise((resolve, fail) => { reject = fail; }), () => current);
    current = false;
    reject(error);
    await pending;
  }
  assert.deepEqual(reported, []);
  await context.runWorkspaceRender(async () => { throw new Error('current error'); }, () => true);
  assert.deepEqual(reported, ['current error']);
  assert.ok(!source.includes('render().catch(showError)'));
});
test('late industry construction cannot replace current edit and refresh callbacks', async () => {
  let current = true, release, calls = 0;
  const sentinel = () => 'current panel';
  const panelContext = vm.createContext({ element, editIndustryConfig: sentinel, refreshIndustrySnapshotChoices: sentinel,
    fetch: async () => {
      calls += 1;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => ({ families: [], templates: [], items: [] }) };
    } });
  vm.runInContext(source.slice(source.indexOf('async function industryConfigPanel('), source.indexOf('async function threeBucketConfigPanel(')), panelContext);
  const pending = panelContext.industryConfigPanel({}, () => current);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  current = false;
  release();
  await pending;
  assert.equal(panelContext.editIndustryConfig, sentinel);
  assert.equal(panelContext.refreshIndustrySnapshotChoices, sentinel);
});
test('unsupported SQLite deserialize fails explicitly without substituting live data', async () => {
  const { stdout } = await promisify(execFile)('python3', ['-B', '-c', `
import sys, tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, 'modules/factors/src')
import fund_history_store as store
with tempfile.TemporaryDirectory() as directory:
    file = Path(directory) / 'frozen.sqlite'
    file.write_bytes(b'not a database')
    with patch.object(store.sqlite3, 'Connection', object):
        try:
            store.open_reader(file, '0' * 64)
        except ValueError as error:
            assert str(error) == 'frozen_fund_history_requires_sqlite_deserialize'
        else:
            raise AssertionError('missing capability accepted')
print('capability guard passed')
`], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 10000 });
  assert.match(stdout, /capability guard passed/);
});
