import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const phaseNames = ['prepare_input', 'sdr', 'tree_d', 'tree_rc', 'vanilla_c1', 'groth16_c2', 'verify_seal', 'finalize', 'unseal_sdr', 'unseal_decode', 'verify_unsealed'];
const readJSON = (path) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
function writeJSON(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

// A killed process cannot write its final summary. Recover completed phases
// and the last partial phase from append-only telemetry, never mark it passed.
export function recoverPhases(text) {
  const phases = new Map();
  const lines = text.trimEnd().split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch (e) { if (i === lines.length - 1) break; throw e; }
    if (!phaseNames.includes(event.phase)) throw new Error(`unknown phase ${event.phase}`);
    const state = phases.get(event.phase) ?? { first: event.sample, last: event.sample, result: null };
    state.last = event.sample;
    if (event.result) state.result = structuredClone(event.result);
    phases.set(event.phase, state);
  }
  return [...phases.entries()].map(([name, { first, last, result }]) => {
    if (result?.status === 'complete' || result?.status === 'failed') return result;
    const wall = Math.max(0, Date.parse(last.at) - Date.parse(first.at));
    const cpu = last.cpu_source === first.cpu_source ? Math.max(0, last.cpu_usec - first.cpu_usec) / 1000 : null;
    return { ...result, name, status: 'interrupted', wall_ms: wall, cpu_ms: cpu, average_cpu_cores: wall > 0 && cpu !== null ? cpu / wall : null, duration_is_lower_bound: true };
  });
}

export function validate(summary, config, phases, exitCode) {
  const expectedProof = config.sector_size_bytes === 34359738368 ? 8 : 6;
  return exitCode === 0 && summary?.status === 'complete'
    && summary.kind === 'curio-seal-unseal'
    && summary.sector_size_bytes === config.sector_size_bytes
    && summary.registered_seal_proof === expectedProof
    && summary.verify_seal === true && summary.unseal_matches_source === true
    && summary.proof_bytes > 0
    && /^[0-9a-f]{64}$/.test(summary.source_sha256 ?? '')
    && summary.source_sha256 === summary.unsealed_sha256
    && phases.length === phaseNames.length
    && phases.every((p, i) => p.name === phaseNames[i] && p.status === 'complete');
}

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function init(dir, args) {
  const [size, image, memory, cpus, interval, window, retain, parameters, parents] = args;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = {
    schema_version: 1, kind: 'curio-seal-unseal', sector_size_bytes: Number(size), backend: 'stacked', cpu_only: true,
    network: 'none-during-measurement', chain: false, contracts: false, harmony_scheduler: false,
    image, memory_limit_bytes: Number(memory) || null, cpu_quota_cores: Number(cpus) || null, oom_score_adj: 1000,
    telemetry_interval_ms: Number(interval), multicore_sdr: true, parent_cache_window_nodes: Number(window),
    retain_work_on_success: retain === '1', parameter_cache: parameters, parent_cache: parents,
    repository_commit: git(root, ['rev-parse', 'HEAD']), working_tree_dirty: git(root, ['status', '--porcelain']) !== '',
    created_at: new Date().toISOString(),
  };
  writeJSON(join(dir, 'provenance.json'), config);
}

function finish(dir, code, stoppedAt) {
  const config = readJSON(join(dir, 'provenance.json'));
  const summary = readJSON(join(dir, 'summary.json'));
  const telemetryPath = join(dir, 'telemetry.ndjson');
  const phases = existsSync(telemetryPath) ? recoverPhases(readFileSync(telemetryPath, 'utf8')) : summary?.phases ?? [];
  const verified = validate(summary, config, phases, code);
  const benchmark = readJSON(join(dir, 'benchmark-container.json'));
  const parameters = readJSON(join(dir, 'parameters-container.json'));
  const sum = names => phases.filter(p => names.includes(p.name)).reduce((a, p) => a + (p.wall_ms ?? 0), 0);
  const sealing = ['sdr', 'tree_d', 'tree_rc', 'vanilla_c1', 'groth16_c2', 'verify_seal'];
  const report = {
    schema_version: 1, kind: 'curio-seal-unseal', status: verified ? 'complete' : 'failed', exit_code: code,
    stopped_at: stoppedAt, correctness_passed: verified, config, summary, phases,
    containers: { parameters, benchmark },
    totals: { sealing_ms: phases.filter(p => sealing.includes(p.name) && p.status === 'complete').length === sealing.length ? sum(sealing) : null,
      unsealing_ms: phases.filter(p => ['unseal_sdr', 'unseal_decode'].includes(p.name) && p.status === 'complete').length === 2 ? sum(['unseal_sdr', 'unseal_decode']) : null },
  };
  writeJSON(join(dir, 'report.json'), report);
  const seconds = v => v == null ? 'unavailable' : `${(v / 1000).toFixed(3)} s`;
  const gib = v => v == null ? 'unavailable' : `${(v / 2 ** 30).toFixed(3)} GiB`;
  const lines = [
    '# Curio offline seal–unseal benchmark', '',
    `Status: **${report.status}**; process exit: ${code}; correctness: **${verified ? 'PASS' : 'NOT PASSED'}**.`, '',
    `SDR sector: ${gib(config.sector_size_bytes)}. CPU only. No chain, contracts, wallet, deployment or Harmony scheduler.`, '',
    `CPU: ${summary?.host?.cpu_model || 'unavailable'}; logical CPUs: ${summary?.host?.logical_cpus ?? 'unavailable'}; host RAM: ${gib(summary?.host?.mem_total_bytes)}.`, '',
    `Sealing: ${seconds(report.totals.sealing_ms)}. Unsealing (SDR key + native decode): ${seconds(report.totals.unsealing_ms)}.`, '',
    '| Phase | Status | Wall time | CPU time | Average cores | Sampled process-tree RSS | Sampled container memory |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...phases.map(p => `| ${p.name} | ${p.status}${p.duration_is_lower_bound ? ' (lower bound)' : ''} | ${seconds(p.wall_ms)} | ${seconds(p.cpu_ms)} | ${p.average_cpu_cores?.toFixed(2) ?? 'unavailable'} | ${gib(p.process_tree_rss_peak_bytes)} | ${gib(p.cgroup_memory_sampled_peak_bytes)} |`), '',
    'TreeRC includes Curio’s sealed-file copy, TreeC/TreeR and its three C1 sanity checks. C2 uses the same ffiselect subprocess as Curio. CPU and memory include FFI children. RSS sums processes and may double-count shared pages; container memory also includes filesystem cache. Sampled peaks can miss short spikes.', '',
    'Preparation, parameter download/verification, finalization and recovered-data verification are excluded from sealing/unsealing totals. This measures one sector’s computation and local storage, not chain inclusion, scheduler admission, queueing or production throughput.', '',
    `Memory limit: ${config.memory_limit_bytes === null ? 'no explicit Docker limit' : gib(config.memory_limit_bytes)}. CPU quota: ${config.cpu_quota_cores ?? 'unlimited'}. Multicore SDR: enabled. GPU builders and GPU Groth16: disabled.`, '',
    `Seal proof verified: ${summary?.verify_seal ?? false}. Recovered full input SHA-256 matches: ${summary?.unseal_matches_source ?? false}.`, '',
    `Container OOM killed: ${benchmark?.OOMKilled ?? 'unavailable'}. Parameter fetch OOM killed: ${parameters?.OOMKilled ?? 'unavailable'}.`, '',
    'Reports: `summary.json`, `report.json`, `provenance.json`, `build-manifest.json`, `telemetry.ndjson`, and container state JSON. Logs: `parameters.stderr.log`, `benchmark.stderr.log`.', '',
    verified && !config.retain_work_on_success ? 'The launcher removes this run’s work directory after successful validation; shared parameter and parent caches remain.' : 'Work artifacts are retained for inspection.', '',
  ];
  if (summary?.error) lines.push(`Failure: ${summary.error.replaceAll('\n', ' ')}`, '');
  writeFileSync(join(dir, 'summary.md'), lines.join('\n'));
  if (!verified) throw new Error(`Curio benchmark did not pass; see ${join(dir, 'summary.md')}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, dir, ...args] = process.argv.slice(2);
    if (mode === 'init') init(dir, args);
    else if (mode === 'finish') finish(dir, Number(args[0]), args[1]);
    else throw new Error('expected init or finish');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
