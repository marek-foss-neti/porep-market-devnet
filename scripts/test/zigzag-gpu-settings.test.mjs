import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readGpuSummary } from "../compose-proof-micro-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BENCH_|BELLMAN_|BELLPERSON_|EC_GPU_|DEVNET_)/.test(key)));
function settings(build, backend, required, extra = {}) {
  return spawnSync("bash", ["-c", 'set -euo pipefail; devnet_die() { echo "$*" >&2; exit 1; }; source "$1/scripts/zigzag-gpu-settings.sh"; zigzag_gpu_environment "$2" "$3" "$4"', "test", root, build, backend, required], { encoding: "utf8", env: { ...clean, ...extra } });
}

test("CPU-only and GPU-capable CPU controls disable Bellperson GPU explicitly", () => {
  for (const build of ["cpu", "cuda", "opencl"]) {
    const result = settings(build, "cpu", "0");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BELLMAN_NO_GPU=1\n/);
    assert.doesNotMatch(result.stdout, /EC_GPU_FRAMEWORK=|BELLPERSON_GPUS_PER_LOCK=/);
  }
});

test("explicit CUDA selects framework and shared priority lock directory", () => {
  const result = settings("cuda", "cuda", "1", { BENCH_ZIGZAG_GPU_CPU_UTILIZATION: "0.25" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BELLMAN_CPU_UTILIZATION=0.25/);
  assert.match(result.stdout, /EC_GPU_FRAMEWORK=cuda/);
  assert.match(result.stdout, /TMPDIR=\/var\/tmp\/filecoin-gpu-locks/);
  assert.match(result.stdout, /BELLMAN_NO_GPU=0/);
});

test("Curio rejects a CUDA image without the GPU Compose driver passthrough", () => {
  const result = spawnSync("bash", ["-c", 'source "$1/scripts/devnet-common.sh"; devnet_zigzag_curio_image fixture', "test", root], {
    encoding: "utf8", env: { ...clean, DEVNET_ZIGZAG_CURIO_GPU_BUILD: "cuda", DEVNET_ZIGZAG_CURIO_GPU_BACKEND: "cpu" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CUDA Curio requires the explicit GPU worker/);
});

test("unsupported backend, missing feature, absent trace support and invalid CPU shares fail", () => {
  for (const args of [["cpu", "cuda", "1"], ["cuda", "opencl", "0"], ["opencl", "opencl", "1"], ["cuda", "cuda", "yes"], ["cuda", "", "0"]]) {
    assert.notEqual(settings(...args).status, 0);
  }
  for (const extra of [{ BENCH_ZIGZAG_GPU_CPU_UTILIZATION: "1" }, { BELLMAN_CPU_UTILIZATION: "NaN" }, { BENCH_ZIGZAG_GPU_CPU_UTILIZATION: "-0.1" }, { BELLMAN_GPU_FRAMEWORK: "cuda" }, { BELLPERSON_GPUS_PER_LOCK: "1" }]) {
    assert.notEqual(settings("cuda", "cuda", "1", extra).status, 0);
  }
});

test("report keeps effective request and never treats configuration as execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "zigzag-gpu-report-"));
  try {
    assert.equal(readGpuSummary(directory), null);
    const request = { backend: "cuda", required: true, trace_requested: true };
    writeFileSync(join(directory, "gpu-request.json"), JSON.stringify(request));
    assert.equal(readGpuSummary(directory).gpu_execution_confirmed, false);
    assert.deepEqual(readGpuSummary(directory).request, request);
    writeFileSync(join(directory, "gpu-summary.json"), JSON.stringify({ gpu_execution_confirmed: true, fft_kernel_count: 2 }));
    assert.equal(readGpuSummary(directory).fft_kernel_count, 2);
    assert.deepEqual(readGpuSummary(directory).request, request);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
