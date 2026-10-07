import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeReport, parseCpuDiagnostics, renderPhaseMarkdown } from "../compose-proof-micro-report.mjs";
import { summarizeTelemetry } from "../summarize-proof-micro-telemetry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BENCH_|FIL_PROOFS_|DEVNET_|RAYON_NUM_THREADS$|EC_GPU_NUM_THREADS$)/.test(name)));
const settings = 'set -euo pipefail; devnet_die() { printf "%s\\n" "$*" >&2; exit 1; }; source "$1/scripts/zigzag-cpu-settings.sh"; zigzag_bench_cpu_environment';

function shell(code, env = {}, args = []) {
  return spawnSync("bash", ["-c", code, "test", root, ...args], { env: { ...cleanEnv, ...env }, encoding: "utf8" });
}

function environment(env = {}) {
  const result = shell(settings, env);
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=")));
}

test("defaults preserve encode settings and leave pool sizing to the container", () => {
  const env = environment();
  assert.equal(env.RAYON_NUM_THREADS, "auto");
  assert.equal(env.EC_GPU_NUM_THREADS, "auto");
  assert.equal(env.FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS, "2");
  assert.equal(env.FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE, "128");
  assert.equal(env.FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD, "4096");
  for (const name of ["PARENT_BUFFER_NODES", "PARENT_CACHE_DONTNEED", "TREE_R_DONTNEED"]) assert.equal(env[`FIL_PROOFS_ZIGZAG_${name}`], "0");
});

test("native variables and benchmark overrides reach explicit docker -e arguments", () => {
  const source = readFileSync(join(root, "scripts/bench-proof-micro.sh"), "utf8");
  const start = source.indexOf('if [[ "${backend}" == "zigzag" ]]; then\n  source');
  const end = source.indexOf('if [[ "${backend}" == "zigzag" &&', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  const code = 'set -euo pipefail; source "$1/scripts/devnet-common.sh"; backend="$2"; docker_common_args=(); ' + block + '\nif [[ "$backend" == zigzag ]]; then printf "%s\\0" "${docker_common_args[@]}"; fi';
  const result = shell(code, {
    RAYON_NUM_THREADS: "12", EC_GPU_NUM_THREADS: "8", BENCH_RAYON_NUM_THREADS: "6",
    BENCH_ZIGZAG_ENCODE_AFFINITY: "false", BENCH_ZIGZAG_ENCODE_PRODUCERS: "3",
    BENCH_ZIGZAG_ENCODE_STRIDE: "17", BENCH_ZIGZAG_ENCODE_LOOKAHEAD: "2048",
    BENCH_ZIGZAG_USE_PARENT_CACHE: "0", BENCH_ZIGZAG_PARENT_BUFFER_NODES: "32768",
    BENCH_ZIGZAG_TREE_R_DONTNEED: "true",
  }, ["zigzag"]);
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split("\0").filter(Boolean);
  for (const setting of ["RAYON_NUM_THREADS=6", "EC_GPU_NUM_THREADS=8", "FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_AFFINITY=0", "FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS=3", "FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE=17", "FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD=2048", "FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=0", "FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES=32768", "FIL_PROOFS_ZIGZAG_TREE_R_DONTNEED=1"]) {
    assert.ok(args.includes(setting), setting);
    assert.equal(args[args.indexOf(setting) - 1], "-e");
  }
  const stacked = shell(code, { RAYON_NUM_THREADS: "12", BENCH_ZIGZAG_TREE_R_DONTNEED: "1" }, ["stacked"]);
  assert.equal(stacked.status, 0, stacked.stderr);
  assert.equal(stacked.stdout.replaceAll("\0", ""), "");
});

test("invalid CPU settings fail before docker argv is constructed", () => {
  for (const env of [
    { BENCH_RAYON_NUM_THREADS: "0" }, { BENCH_EC_GPU_NUM_THREADS: "4097" },
    { BENCH_ZIGZAG_ENCODE_AFFINITY: "maybe" }, { BENCH_ZIGZAG_ENCODE_PRODUCERS: "0" },
    { BENCH_ZIGZAG_ENCODE_STRIDE: "-1" }, { BENCH_ZIGZAG_ENCODE_LOOKAHEAD: "1048576" },
    { BENCH_ZIGZAG_PARENT_BUFFER_NODES: "262145" },
  ]) {
    const result = shell(settings + '; printf "UNEXPECTED_SUCCESS"', env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"));
  }
  assert.equal(environment({ BENCH_ZIGZAG_PARENT_BUFFER_NODES: "262144" }).FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES, "262144");
});

test("compose applies CPU override only to ZigZag and passes settings to the Curio service", () => {
  const temporary = mkdtempSync(join(tmpdir(), "zigzag-cpu-compose-"));
  try {
    const docker = join(temporary, "docker");
    writeFileSync(docker, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const envPath = join(temporary, "compose.env");
    const code = 'set -euo pipefail; source "$1/scripts/devnet-common.sh"; DEVNET_COMPOSE_ENV="$2"; devnet_compose config';
    for (const backend of ["zigzag", "stacked"]) {
      writeFileSync(envPath, `DEVNET_PROOF_BACKEND=${backend}\n`);
      const result = shell(code, { PATH: `${temporary}:${cleanEnv.PATH}` }, [envPath]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("compose.zigzag-cpu.yaml"), backend === "zigzag");
    }
    const override = readFileSync(join(root, "docker/compose.zigzag-cpu.yaml"), "utf8");
    assert.match(override, /services:\n  curio:\n/);
    assert.match(override, /RAYON_NUM_THREADS: \$\{RAYON_NUM_THREADS:-auto\}/);
    assert.match(override, /EC_GPU_NUM_THREADS: \$\{EC_GPU_NUM_THREADS:-auto\}/);
    assert.ok(!override.includes("lotus:"));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("actual Curio launcher resolves auto inside its cpuset before executing the worker", () => {
  const temporary = mkdtempSync(join(tmpdir(), "zigzag-cpu-launcher-"));
  try {
    const bin = join(temporary, "bin");
    const share = join(temporary, "share/zigzag");
    mkdirSync(bin);
    mkdirSync(share, { recursive: true });
    writeFileSync(join(share, "cpu-settings.sh"), readFileSync(join(root, "scripts/zigzag-cpu-settings.sh")));
    writeFileSync(join(bin, "nproc"), '#!/usr/bin/env bash\nprintf "3\\n"\n', { mode: 0o755 });
    for (const program of ["curio", "sptool"]) {
      writeFileSync(join(bin, program), readFileSync(join(root, "source-overrides/zigzag/curio/curio-cpu-launcher.sh")), { mode: 0o755 });
      writeFileSync(join(bin, `${program}-zigzag`), '#!/usr/bin/env bash\nprintf "%s\\n" "$RAYON_NUM_THREADS" "$EC_GPU_NUM_THREADS" "$FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS" "$*"\n', { mode: 0o755 });
      const result = spawnSync(join(bin, program), ["--version"], { env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, RAYON_NUM_THREADS: "auto", EC_GPU_NUM_THREADS: "2", FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS: "3" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "3\n2\n3\n--version\n");
      const invalid = spawnSync(join(bin, program), [], { env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES: "262145" }, encoding: "utf8" });
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.stdout, "");
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("full benchmark enforces the 80 GiB ceiling and equal memory/swap limits", () => {
  const source = readFileSync(join(root, "scripts/bench-proof-micro.sh"), "utf8");
  const start = source.indexOf('if [[ "${backend}" == "zigzag" && ( "${sector_size}"');
  const end = source.indexOf("zigzag_setup_args=()", start);
  assert.ok(start > 0 && end > start);
  const code = 'set -euo pipefail; source "$1/scripts/devnet-common.sh"; backend=zigzag; sector_size=512mib; mode=full; docker_common_args=(--user 1); ' + source.slice(start, end) + '\nprintf "%s\\n" "${docker_common_args[@]}"';
  for (const bytes of ["85899345920", "42949672960"]) {
    const result = shell(code, { BENCH_ZIGZAG_FULL_MEMORY_BYTES: bytes });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`--memory\n${bytes}\n--memory-swap\n${bytes}\n`));
  }
  for (const bytes of ["110000000000", "85899345921", "0"]) assert.notEqual(shell(code, { BENCH_ZIGZAG_FULL_MEMORY_BYTES: bytes }).status, 0);
});

test("CPU configuration and affinity/fallback logs are preserved in JSON and Markdown", () => {
  const cpu = { rayon_num_threads: 6, ec_gpu_num_threads: 8, cpus_allowed_list: "4-9", encode_affinity: false, encode_producers: 3, encode_stride: 17, encode_lookahead: 2048, parent_cache: true, parent_cache_window_nodes: 32768, cache_policy: { parent_buffer_nodes: 2048, tree_r_dontneed: true } };
  // fil_logger's default formatter prints module_path even for custom targets.
  const logLines = [
    "2026-10-06T12:00:00.000 INFO storage_proofs_porep::zigzag::vanilla::vde > zigzag multicore encode L3 affinity: consumer CPU 4, producer CPUs [5, 6]",
    "2026-10-06T12:00:00.001 INFO storage_proofs_porep::zigzag::vanilla::vde > encode producers=2 stride=128 lookahead=4096 parent_cache=true reversed=false",
    "2026-10-06T12:00:00.002 INFO storage_proofs_porep::zigzag::vanilla::cores > encode affinity bound thread to CPU 4",
    "2026-10-06T12:00:00.003 INFO storage_proofs_porep::zigzag::vanilla::cores > encode affinity fallback: disabled or no workers; using OS scheduling",
    "2026-10-06T12:00:00.004 INFO storage_proofs_porep::zigzag::vanilla::cores > encode affinity restored prior thread mask before subsequent work",
    "2026-10-06T12:00:00.005 WARN storage_proofs_porep::zigzag::vanilla::cores > zigzag encode affinity: failed to restore thread mask: error",
    "2026-10-06T12:00:00.006 INFO storage_proofs_porep::zigzag::vanilla::parent_table > parent records mmap_window_nodes=32768 buffer_nodes=2048 max_buffer_bytes=114688",
    "2026-10-06T12:00:00.007 INFO storage_proofs_porep::zigzag::cache_policy > DONTNEED advised_bytes=8192; file retained; residency is not guaranteed",
    "2026-10-06T12:00:00.008 WARN storage_proofs_porep::zigzag::cache_policy > DONTNEED unavailable: unsupported; retaining pages",
    "2026-10-06T12:00:00.009 INFO storage_proofs_porep::zigzag::vanilla::proof > replicate",
    "2026-10-06T12:00:00.010 INFO storage_proofs_porep::zigzag::vanilla::vde > unrelated phase message",
    "2026-10-06T12:00:00.011 INFO other::cores > encode affinity fallback: unrelated module",
  ];
  const log = logLines.join("\r\n");
  const telemetry = summarizeTelemetry(JSON.stringify({ schema_version: 1, sequence: 0, pid: 1, elapsed_ms: 0, timestamp_unix_ms: 1, sampling_interval_ms: 100, trigger: "session_start", phase: "startup", process: {}, cgroup: {}, disk: { paths: [] }, warnings: [] }));
  const report = composeReport({ mode: "full", benchmark: { cpu_configuration: cpu, phases: [{ name: "pre_commit_phase1", wall_ms: 100, cpu_ms: 200 }] }, telemetry, provenance: { invocation: { outer_wall_ms: 100 } }, prewarm: null, prewarmTelemetry: null, measuredLog: log });
  assert.deepEqual(report.cpu_configuration, cpu);
  assert.deepEqual(report.cpu_diagnostics, logLines.slice(0, 9).map((message, index) => ({
    line_number: index + 1, source: "stderr.log", message,
  })));
  assert.equal(report.derived.sealing_wall_ms, 100);
  assert.equal(report.derived.sealing_cpu_ms, 200);
  report.pc1_suboperations = [{ ...report.phases[0], name: "encode", id: 9, layer: 0, completed: true }];
  const markdown = renderPhaseMarkdown(report);
  assert.ok(markdown.indexOf("`encode` id=9") > markdown.indexOf("## PC1 suboperations"));
  assert.ok(markdown.indexOf("`encode` id=9") < markdown.indexOf("## Auxiliary C2 timers"));
  assert.ok(markdown.indexOf("## CPU configuration") > markdown.indexOf("## Auxiliary C2 timers"));
  assert.match(markdown, /Rayon \*\*6\*\*, ec-gpu \*\*8\*\*/);
  assert.match(markdown, /4-9/);
  assert.match(markdown, /producers=3/);
  assert.match(markdown, /DONTNEED is advisory/);
});

test("CPU diagnostics accept target format and fil_logger JSON without changing source lines", () => {
  const lines = [
    "[INFO zigzag_cpu] encode affinity fallback: disabled",
    "[INFO zigzag_cache] DONTNEED advised_bytes=8192",
    JSON.stringify({ level: "INFO", target: "storage_proofs_porep::zigzag::vanilla::cores", message: "encode affinity restored prior thread mask before subsequent work" }),
    JSON.stringify({ level: "WARN", target: "storage_proofs_porep::zigzag::cache_policy", message: "DONTNEED unavailable: unsupported; retaining pages" }),
    "[INFO other] ignored",
  ];
  assert.deepEqual(parseCpuDiagnostics(lines.join("\n")), lines.slice(0, 4).map((message, index) => ({
    line_number: index + 1, source: "stderr.log", message,
  })));
});

test("microbench generic passes portable BLST to tree, build and the actual manifest", () => {
  const dockerfile = readFileSync(join(root, "docker/zigzag-microbench.Dockerfile"), "utf8");
  const cargoRun = dockerfile.match(/RUN set -eu; toolchain=.*?(?=\n\nFROM)/s)?.[0];
  assert.ok(cargoRun, "the actual Dockerfile Cargo RUN must be exercised");
  const buildScript = readFileSync(join(root, "scripts/devnet-build-zigzag-microbench.sh"), "utf8");
  const manifestStart = buildScript.indexOf("jq -n \\\n");
  const manifestEnd = buildScript.indexOf('\nmv -f -- "${temporary}"', manifestStart);
  assert.ok(manifestStart > 0 && manifestEnd > manifestStart);
  const manifestCommand = buildScript.slice(manifestStart, manifestEnd);
  const temporary = mkdtempSync(join(tmpdir(), "zigzag-portable-build-"));
  try {
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    mkdirSync(join(temporary, "extern/filecoin-ffi/rust"), { recursive: true });
    writeFileSync(join(bin, "rustup"), '#!/bin/sh\nprintf "stable (default)\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, "cargo"), '#!/bin/sh\nprintf "%s\\0" "$@" > "$CPU_TEST_CAPTURE_DIR/$1.argv"\nprintf "%s\\0" "${RUSTFLAGS-}" > "$CPU_TEST_CAPTURE_DIR/$1.env"\nprintf "mock cargo feature graph\\n"\n', { mode: 0o755 });
    // Exercise the Dockerfile shell with mock tools and a temporary graph path.
    // No Docker invocation or compilation takes place.
    const command = cargoRun.replace(/^RUN /, "").replace(/\\\r?\n\s*/g, " ")
      .replaceAll("/opt/zigzag-cargo-features.txt", '"${CPU_TEST_FEATURE_GRAPH}"');
    for (const target of ["default", "generic", "native"]) {
      for (const shaAsm of ["0", "1"]) {
        const env = { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, CPU_TEST_CAPTURE_DIR: temporary,
          CPU_TEST_FEATURE_GRAPH: join(temporary, "cargo-features.txt"), ZIGZAG_TARGET_CPU: target,
          ZIGZAG_SHA_ASM: shaAsm, ZIGZAG_LTO: "off", RUSTFLAGS: "" };
        const result = spawnSync("sh", ["-c", command], { cwd: temporary, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const expected = ["multicore-sdr", "zigzag-bench", "zigzag-setup-status"];
        if (target === "generic") expected.push("blst-portable");
        if (shaAsm === "1") expected.push("zigzag-sha-asm");
        for (const action of ["tree", "build"]) {
          const argv = readFileSync(join(temporary, `${action}.argv`), "utf8").split("\0").filter(Boolean);
          assert.ok(argv.includes("--locked"));
          assert.ok(argv.includes("--no-default-features"));
          assert.deepEqual(argv[argv.indexOf("--features") + 1].split(","), expected);
          const flags = readFileSync(join(temporary, `${action}.env`), "utf8").split("\0")[0];
          assert.equal(flags, target === "native" ? "-C target-cpu=native" : "");
        }
        assert.equal(readFileSync(join(temporary, "cargo-features.txt"), "utf8"), "mock cargo feature graph\n");
        const manifestPath = join(temporary, "manifest.json");
        const manifestResult = shell(manifestCommand, {
          platform: "linux/amd64", curio_commit: "a".repeat(40), lotus_commit: "b".repeat(40),
          blst_commit: "c".repeat(40), zigzag_source_commit: "d".repeat(40),
          zigzag_source_sha256: "e".repeat(64), zigzag_source_relative: ".cache/fixture",
          zigzag_toolchain_image: "fixture@sha256:" + "f".repeat(64),
          zigzag_overrides_sha256: "1".repeat(64), dockerfile_sha256: "2".repeat(64),
          image: "fixture:cpu", image_id: "sha256:" + "3".repeat(64),
          zigzag_target_cpu: target, zigzag_lto: "off", zigzag_sha_asm: shaAsm, temporary: manifestPath,
        });
        assert.equal(manifestResult.status, 0, manifestResult.stderr);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        assert.deepEqual(manifest.cargoFeatures, expected);
        assert.equal(manifest.cpuBuild.target_cpu, target);
        assert.equal(manifest.cpuBuild.sha_asm, shaAsm === "1");
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("build options have separate identities and reject unsupported values", () => {
  const code = 'set -euo pipefail; devnet_die() { printf "%s\\n" "$*" >&2; exit 1; }; source "$1/scripts/zigzag-build-settings.sh"; printf "%s" "$zigzag_build_settings_sha256"';
  const hashes = [{}, { DEVNET_ZIGZAG_TARGET_CPU: "generic" }, { DEVNET_ZIGZAG_TARGET_CPU: "native" }, { DEVNET_ZIGZAG_LTO: "thin" }, { DEVNET_ZIGZAG_SHA_ASM: "1" }].map((env) => {
    const result = shell(code, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^[a-f0-9]{64}$/);
    return result.stdout;
  });
  assert.equal(new Set(hashes).size, hashes.length);
  for (const env of [{ DEVNET_ZIGZAG_TARGET_CPU: "sha-ni" }, { DEVNET_ZIGZAG_LTO: "yes" }, { DEVNET_ZIGZAG_SHA_ASM: "true" }]) assert.notEqual(shell(code, env).status, 0);
});
