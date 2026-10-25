import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { phaseNames, recoverPhases, validate } from '../curio-bench-report.mjs';

const config = { sector_size_bytes: 34359738368 };
const phases = phaseNames.map(name => ({ name, status: 'complete' }));
const summary = { kind: 'curio-seal-unseal', status: 'complete', sector_size_bytes: 34359738368,
  registered_seal_proof: 8, verify_seal: true, unseal_matches_source: true, proof_bytes: 1920,
  source_sha256: 'a'.repeat(64), unsealed_sha256: 'a'.repeat(64) };

test('success requires geometry, complete ordered phases, proof and full recovered-data verification', () => {
  assert.equal(validate(summary, config, phases, 0), true);
  for (const bad of [{ status: 'running' }, { verify_seal: false }, { unseal_matches_source: false },
    { sector_size_bytes: 8388608 }, { registered_seal_proof: 6 }, { source_sha256: '' },
    { unsealed_sha256: 'b'.repeat(64) }, { proof_bytes: 0 }]) {
    assert.equal(validate({ ...summary, ...bad }, config, phases, 0), false);
  }
  assert.equal(validate(summary, config, phases.slice(0, -1), 0), false);
  assert.equal(validate(summary, config, [...phases].reverse(), 0), false);
  assert.equal(validate(summary, config, phases, 137), false);
});

test('OOM recovers the in-flight C2 lower bound without turning it into a completed phase', () => {
  const sample = (s, cpu) => ({ at: `2026-10-25T12:00:${s}.000Z`, cpu_usec: cpu, cpu_source: 'cgroup-v2' });
  const log = [
    { kind: 'phase_end', phase: 'vanilla_c1', sample: sample('01', 2000), result: { name: 'vanilla_c1', status: 'complete', wall_ms: 1000 } },
    { kind: 'phase_start', phase: 'groth16_c2', sample: sample('02', 3000), result: { name: 'groth16_c2', status: 'running' } },
    { kind: 'sample', phase: 'groth16_c2', sample: sample('05', 6003000), result: { name: 'groth16_c2', status: 'running', process_tree_rss_peak_bytes: 123 } },
  ].map(JSON.stringify).join('\n') + '\n{"incomplete';
  const result = recoverPhases(log);
  assert.equal(result[0].status, 'complete');
  assert.equal(result[1].status, 'interrupted');
  assert.equal(result[1].wall_ms, 3000);
  assert.equal(result[1].cpu_ms, 6000);
  assert.equal(result[1].average_cpu_cores, 2);
  assert.equal(result[1].process_tree_rss_peak_bytes, 123);
  assert.equal(result[1].duration_is_lower_bound, true);
});

test('malformed telemetry in the middle is rejected rather than silently skipped', () => {
  assert.throws(() => recoverPhases('not json\n{}\n'));
  assert.throws(() => recoverPhases(JSON.stringify({ phase: 'pretend-phase' })));
});

function launcher(t, failure, limited = true) {
  const root = mkdtempSync(join(tmpdir(), 'curio-bench-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const dir of ['scripts', 'bin', '.runtime/devnet/build']) mkdirSync(join(root, dir), { recursive: true });
  for (const name of ['bench-curio.sh', 'curio-bench-report.mjs']) copyFileSync(join(source, name), join(root, 'scripts', name));
  writeFileSync(join(root, '.runtime/devnet/build/images.json'), '{}');
  writeFileSync(join(root, 'scripts/devnet-common.sh'), `
DEVNET_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_BUILD_DIR="\${DEVNET_ROOT}/.runtime/devnet/build"
DEVNET_PROOF_PARAMETERS_DIR="\${DEVNET_ROOT}/parameters"
devnet_require_command() { command -v "$1" >/dev/null; }
devnet_die() { printf '%s\\n' "$*" >&2; exit 1; }
devnet_require_safe_write_path() { :; }
devnet_proof_microbench_image_for_backend() { printf 'fixture-image\\n'; }
devnet_parent_cache_dir_for_backend() { printf '%s/parents\\n' "\${DEVNET_ROOT}"; }
devnet_parent_cache_window_nodes() { printf '2048\\n'; }
devnet_progress() { :; }
devnet_format_duration_seconds() { printf '%s' "$1"; }
`);
  writeFileSync(join(root, 'bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const root = process.env.CURIO_LAUNCHER_FIXTURE, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'docker.jsonl'), JSON.stringify(args)+'\\n');
const out = x => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const state = id => path.join(root, id+'.json');
switch(args[0]) {
case 'info': out({NCPU:8,MemTotal:68719476736}); break;
case 'run': if(args.includes('sh')) out('1099511627776'); break;
case 'create': {
  const id = args.includes('--fetch-params-only') ? 'parameters' : 'benchmark';
  const mount = args.find(x => x.startsWith('type=bind,src=') && x.endsWith('dst=/bench-run'));
  const run = mount.slice('type=bind,src='.length, -',dst=/bench-run'.length);
  fs.writeFileSync(state(id), JSON.stringify({run,Status:'created',Running:false,ExitCode:0,OOMKilled:false})); out(id); break;
}
case 'start': {
  const id = args.at(-1), s = JSON.parse(fs.readFileSync(state(id)));
  s.Status='exited';
  if(process.env.CURIO_LAUNCHER_FAILURE === id) { s.ExitCode=137; s.OOMKilled=true; }
  if(id === 'benchmark') {
    fs.mkdirSync(path.join(s.run,'work')); fs.writeFileSync(path.join(s.run,'work','owned-artifact'),'fixture');
    if(s.ExitCode === 0) {
      const summary = ${JSON.stringify({ ...summary, sector_size_bytes: 8388608, registered_seal_proof: 6, phases })};
      fs.writeFileSync(path.join(s.run,'summary.json'), JSON.stringify(summary));
    }
  }
  fs.writeFileSync(state(id), JSON.stringify(s)); break;
}
case 'inspect': out(JSON.parse(fs.readFileSync(state(args.at(-1))))); break;
case 'stop': case 'rm': break;
default: process.exitCode=1;
}
`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BENCH_')));
  const result = spawnSync('bash', [join(root, 'scripts/bench-curio.sh'), '8mib'], {
    env: { ...env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CURIO_LAUNCHER_FIXTURE: root,
      CURIO_LAUNCHER_FAILURE: failure, BENCH_CURIO_CPUS: limited ? '4' : '0', BENCH_CURIO_MEMORY_BYTES: limited ? '8589934592' : '0' },
    encoding: 'utf8', timeout: 30000,
  });
  const run = join(root, '.runtime/runs', readdirSync(join(root, '.runtime/runs'))[0]);
  const calls = readFileSync(join(root, 'docker.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(existsSync(join(run, 'report.json')), result.stderr || result.stdout);
  return { root, run, calls, result, report: JSON.parse(readFileSync(join(run, 'report.json'))) };
}

test('launcher uses an offline measured container and cleans only verified run artifacts', t => {
  const { root, run, calls, result, report } = launcher(t, '');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.correctness_passed, true);
  assert.equal(existsSync(join(run, 'work')), false);
  assert.equal(existsSync(join(root, 'parameters')), true);
  assert.equal(existsSync(join(root, 'parents')), true);
  const measured = calls.find(a => a[0] === 'create' && !a.includes('--fetch-params-only'));
  assert.equal(measured[measured.indexOf('--network')+1], 'none');
  assert.equal(measured[measured.indexOf('--memory')+1], '8589934592');
  assert.equal(measured[measured.indexOf('--memory-swap')+1], '8589934592');
  assert.equal(measured[measured.indexOf('--oom-score-adj')+1], '1000');
  assert.ok(measured.includes('FIL_PROOFS_USE_ZIGZAG=0'));
  assert.ok(measured.includes('BELLMAN_NO_GPU=1'));
  assert.equal(calls.some(a => a.includes('prune') || a.includes('compose')), false);
});

test('launcher preserves artifacts and reports Docker exit 137 even when attach exits zero', t => {
  const { run, result, report } = launcher(t, 'benchmark');
  assert.notEqual(result.status, 0);
  assert.equal(report.exit_code, 137);
  assert.equal(report.containers.benchmark.OOMKilled, true);
  assert.equal(report.correctness_passed, false);
  assert.equal(existsSync(join(run, 'work', 'owned-artifact')), true);
});

test('failed parameter fetching produces a report and never starts sealing', t => {
  const { calls, result, report } = launcher(t, 'parameters');
  assert.notEqual(result.status, 0);
  assert.equal(report.stopped_at, 'parameters');
  assert.equal(report.containers.parameters.OOMKilled, true);
  assert.equal(calls.filter(a => a[0] === 'create').length, 1);
});

test('default resource settings work with empty optional Docker arrays', t => {
  const { calls, result, report } = launcher(t, '', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.config.memory_limit_bytes, null);
  assert.equal(report.config.cpu_quota_cores, null);
  assert.equal(calls.some(a => a.includes('--memory') || a.includes('--cpus')), false);
});
