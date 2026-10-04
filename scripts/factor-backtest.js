import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const [mode, ...args] = argv;
  if (!['catalog', 'preflight', 'run', 'audit'].includes(mode)) throw new Error('usage: factor:backtest catalog|preflight|run|audit --port 4311 --config-id config.id | --artifact-id result.id');
  const options = { mode, port: '4311', researchMode: 'assumption_simulation' };
  const keys = { '--port': 'port', '--config-id': 'configId', '--artifact-id': 'artifactId', '--research-mode': 'researchMode', '--preflight-sha256': 'preflightSha256', '--acknowledge': 'acknowledge' };
  const seen = new Set();
  const allowed = new Set(['--port', ...(['preflight', 'run'].includes(mode) ? ['--config-id', '--research-mode'] : []), ...(mode === 'audit' ? ['--artifact-id'] : []), ...(mode === 'run' ? ['--preflight-sha256', '--acknowledge', '--confirm-execution'] : [])]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag)) throw new Error('option_not_applicable_to_command');
    if (seen.has(flag)) throw new Error('duplicate_option'); seen.add(flag);
    if (flag === '--confirm-execution') { options.confirmExecution = true; continue; }
    if (!keys[flag] || !args[i+1] || args[i+1].startsWith('--')) throw new Error('invalid_option_or_value');
    options[keys[flag]] = args[++i];
  }
  if (!/^[0-9]{1,5}$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error('invalid_local_port');
  if (!['assumption_simulation', 'point_in_time_verified'].includes(options.researchMode)) throw new Error('invalid_research_mode');
  if (['preflight', 'run'].includes(mode) && !/^config\.[a-z0-9_.-]+$/.test(options.configId || '')) throw new Error('config_id_required');
  if (mode === 'audit' && !/^result\.[a-z0-9_.-]+$/.test(options.artifactId || '')) throw new Error('artifact_id_required');
  if (mode !== 'run' && (options.confirmExecution || options.acknowledge || options.preflightSha256)) throw new Error('execution_flags_only_for_run');
  if (mode === 'run' && (!options.confirmExecution || !/^[a-f0-9]{64}$/.test(options.preflightSha256 || '') || !options.acknowledge)) throw new Error('explicit_execution_receipt_and_acknowledgements_required');
  return options;
}

export async function runTool(argv, fetcher = fetch) {
  const options = parseArgs(argv), prefix = `http://127.0.0.1:${options.port}/api/modules/factors/v1/backtest-tools`;
  let url = prefix, init = { redirect: 'error', signal: AbortSignal.timeout(120000) };
  if (options.mode === 'preflight') url += '/preflight?' + new URLSearchParams({ configId: options.configId, researchMode: options.researchMode });
  if (options.mode === 'audit') url += '/audit?' + new URLSearchParams({ artifactId: options.artifactId });
  if (options.mode === 'run') {
    url += '/run'; init = { ...init, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      configId: options.configId, researchMode: options.researchMode, preflightSha256: options.preflightSha256, acknowledgements: options.acknowledge.split(',') }) };
  }
  const response = await fetcher(url, init), data = await response.json();
  if (!response.ok) return { exitCode: 1, output: { httpStatus: response.status, ...data } };
  if (options.mode === 'run') return { exitCode: data.audit?.status === 'incomplete' ? 2 : 0, output: { reused: data.reused,
    requestId: data.item.requestId, artifactId: data.resultArtifact.artifactId, metrics: data.resultArtifact.metrics, audit: data.audit } };
  return { exitCode: data.ready === false || data.status === 'incomplete' ? 2 : 0, output: data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await runTool(process.argv.slice(2)); console.log(JSON.stringify(result.output, null, 2)); process.exitCode = result.exitCode; }
  catch (error) { console.error(JSON.stringify({ error: error.message, action: 'stop_and_review_no_automatic_retry' })); process.exitCode = 1; }
}
