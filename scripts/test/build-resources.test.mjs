import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = join(root, "scripts/build-resources.sh");
const GiB = 1073741824;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DEVNET_BUILD_|CARGO_BUILD_JOBS$|GOMAXPROCS$|GOFLAGS$)/.test(key)));

function shell(code, args = [], env = {}) {
  return spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; shift; ' + code, "test", helper, ...args], {
    encoding: "utf8", env: { ...cleanEnv, ...env }, timeout: 10000,
  });
}
function select(cpus, gib, branches, jobs = "auto", procs = "auto") {
  return shell('build_available_cpus="$1"; build_available_memory_bytes="$2"; build_resources_select "$3" "$4" "$5"; printf "%s\\n" "$build_resources_json"',
    [String(cpus), String(gib * GiB), String(branches), jobs, procs]);
}
function passed(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("auto build jobs scale with CPU, RAM and concurrent branches", () => {
  assert.equal(passed(select(128, 480, 3)).cargo_build_jobs, 42);
  assert.equal(passed(select(128, 480, 1)).cargo_build_jobs, 127);
  assert.equal(passed(select(32, 100, 3)).cargo_build_jobs, 10);
  assert.equal(passed(select(32, 100, 1)).go_max_procs, 31);
  assert.equal(passed(select(96, 18, 1)).cargo_build_jobs, 8);
  assert.equal(passed(select(96, 18, 3)).cargo_build_jobs, 2);
  assert.equal(passed(select(1, 1, 3)).cargo_build_jobs, 1);
  assert.equal(passed(select(512, 1024, 1)).cargo_build_jobs, 128);
});

test("explicit per-branch overrides are independent and malformed settings fail", () => {
  const plan = passed(select(8, 16, 3, "6", "auto"));
  assert.equal(plan.cargo_build_jobs, 6);
  assert.equal(plan.go_max_procs, 2);
  assert.equal(passed(select(8, 16, 3, "auto", "5")).go_max_procs, 5);
  for (const invalid of ["", "0", "-1", "01", "4097", "AUTO", "2 extra"]) {
    assert.notEqual(select(8, 16, 1, invalid).status, 0, invalid);
    assert.notEqual(select(8, 16, 1, "auto", invalid).status, 0, invalid);
  }
  const child = shell('build_available_cpus=8; build_available_memory_bytes=17179869184; build_resources_select 1 3 4; bash -c \'printf "%s|%s|%s" "$CARGO_BUILD_JOBS" "$GOMAXPROCS" "$GOFLAGS"\'', [], { GOFLAGS: "-trimpath" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "3|4|-trimpath -p=4");
});

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "build-resources-"));
  const write = (path, text) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${text}\n`);
  };
  write("proc/self/status", "Cpus_allowed_list:\t2-5,10,16-18");
  write("proc/meminfo", `MemAvailable: ${64 * GiB / 1024} kB`);
  const run = () => shell('build_resources_detect "$1/proc" "$1/fs"; printf "%s %s" "$build_available_cpus" "$build_available_memory_bytes"', [dir]);
  try { fn({ dir, write, run }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function counters(write, path, cpu = "max 100000", memory = "max", used = "0") {
  write(`${path}/cpu.max`, cpu);
  write(`${path}/memory.max`, memory);
  write(`${path}/memory.current`, used);
}

test("v2 walks ancestors and keeps finite limits when the real root has no counters", () => fixture(({ dir, write, run }) => {
  write("proc/self/cgroup", "0::/parent/job");
  write("proc/self/mountinfo", "1 2 0:1 / /cg rw - cgroup2 cgroup rw");
  counters(write, "fs/cg/parent/job", "max 100000", String(20 * GiB), String(2 * GiB));
  counters(write, "fs/cg/parent", "350000 100000", String(12 * GiB), String(5 * GiB));
  assert.equal(run().stdout, `3 ${7 * GiB}`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(dir, "fs/cg/parent/cpu.max"));
  assert.notEqual(run().status, 0, "a missing non-root counter must fail");
}));

test("namespaced v2 root and escaped mount paths retain their limits", () => fixture(({ write, run }) => {
  write("proc/self/cgroup", "0::/parent/job");
  write("proc/self/mountinfo", "1 2 0:1 /parent /custom\\040mount rw - cgroup2 cgroup rw");
  counters(write, "fs/custom mount/job");
  counters(write, "fs/custom mount", "150000 100000", String(4 * GiB), String(GiB));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `1 ${3 * GiB}`);
}));

test("v1 takes precedence on hybrid hosts and recognizes its unlimited sentinel", () => fixture(({ write, run }) => {
  write("proc/self/cgroup", "0::/unified\n2:cpu,cpuacct:/service/job\n3:memory:/job");
  write("proc/self/mountinfo", "1 2 0:1 / /cg rw - cgroup2 cgroup rw\n2 3 0:2 / /cpu rw - cgroup cgroup rw,cpu,cpuacct\n3 4 0:3 / /mem rw - cgroup cgroup rw,memory");
  for (const path of ["fs/cpu", "fs/cpu/service", "fs/cpu/service/job"]) {
    write(`${path}/cpu.cfs_quota_us`, path.endsWith("/service") ? "400000" : "-1");
    write(`${path}/cpu.cfs_period_us`, "100000");
  }
  write("fs/mem/memory.limit_in_bytes", "9223372036854771712");
  write("fs/mem/job/memory.limit_in_bytes", String(8 * GiB));
  write("fs/mem/job/memory.usage_in_bytes", String(3 * GiB));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `4 ${5 * GiB}`);
}));

test("affinity, host availability and zero headroom constrain unlimited cgroups", () => fixture(({ write, run }) => {
  write("proc/self/cgroup", "0::/");
  write("proc/self/mountinfo", "1 2 0:1 / /cg rw - cgroup2 cgroup rw");
  counters(write, "fs/cg");
  assert.equal(run().stdout, `8 ${64 * GiB}`);
  counters(write, "fs/cg", "max 100000", "1024", "2048");
  assert.equal(run().stdout, "8 0");
  write("fs/cg/cpu.max", "100000 0");
  assert.notEqual(run().status, 0);
  write("proc/self/cgroup", "0::/../../escape");
  assert.notEqual(run().status, 0);
}));

test("all build entry points forward validated overrides to compilation-only helpers", () => {
  const common = join(root, "scripts/devnet-common.sh");
  const command = 'source "$1"; devnet_build_parallelism; printf "%s\\n" "${devnet_build_parallelism_args[@]}"';
  const defaults = shell(command, [common]);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.match(defaults.stdout, /DEVNET_BUILD_JOBS=auto/);
  const manual = shell(command, [common], { DEVNET_BUILD_JOBS: "12", DEVNET_BUILD_GO_PROCS: "8" });
  assert.match(manual.stdout, /DEVNET_BUILD_JOBS=12/);
  assert.match(manual.stdout, /DEVNET_BUILD_GO_PROCS=8/);
  for (const invalid of ["", "0", "4097", "2 words"]) {
    assert.notEqual(shell(command, [common], { DEVNET_BUILD_JOBS: invalid }).status, 0);
  }
  for (const name of ["devnet-build", "devnet-build-zigzag-microbench", "devnet-build-zigzag-curio"]) {
    const script = readFileSync(join(root, `scripts/${name}.sh`), "utf8");
    assert.match(script, /devnet_build_parallelism\n/);
    assert.match(script, /"\$\{devnet_build_parallelism_args\[@\]\}"/);
  }
  for (const [name, branches] of [["curio-all-in-one", 3], ["zigzag-microbench", 1], ["zigzag-curio", 1]]) {
    const dockerfile = readFileSync(join(root, `docker/${name}.Dockerfile`), "utf8");
    assert.doesNotMatch(dockerfile, /CARGO_BUILD_JOBS=2|GOMAXPROCS=2/);
    assert.match(dockerfile, new RegExp(`/usr/local/bin/devnet-build-exec ${branches} (?:make|cargo|go)`));
    assert.doesNotMatch(dockerfile, /ENV (?:CARGO_BUILD_JOBS|GOMAXPROCS|GOFLAGS)=/);
  }
});
