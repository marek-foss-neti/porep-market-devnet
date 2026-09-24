#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  throw new Error(`proof microbenchmark provenance: ${message}`);
}

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${commandName} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function gitState(path) {
  if (!existsSync(resolve(path, ".git"))) return null;
  const head = command("git", ["rev-parse", "HEAD"], path);
  const branch = command("git", ["branch", "--show-current"], path) || null;
  const status = command("git", ["status", "--porcelain=v2", "--branch"], path);
  const trackedPatch = command("git", ["diff", "--binary"], path);
  const stagedPatch = command("git", ["diff", "--cached", "--binary"], path);
  const changedTrackedPaths = command("git", ["diff", "--name-only", "HEAD"], path)
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    path,
    head,
    branch,
    clean: changedTrackedPaths.length === 0 && !status.split(/\r?\n/).some((line) => /^[12u?] /.test(line)),
    status_porcelain_v2: status,
    changed_tracked_paths: changedTrackedPaths,
    tracked_patch_sha256: sha256Bytes(trackedPatch),
    staged_patch_sha256: sha256Bytes(stagedPatch),
  };
}

function filteredDockerInfo(repositoryRoot) {
  const info = JSON.parse(command("docker", ["info", "--format", "{{json .}}"], repositoryRoot));
  return {
    server_version: info.ServerVersion,
    operating_system: info.OperatingSystem,
    kernel_version: info.KernelVersion,
    architecture: info.Architecture,
    cpu_count: info.NCPU,
    memory_bytes: info.MemTotal,
    storage_driver: info.Driver,
    cgroup_driver: info.CgroupDriver,
    cgroup_version: info.CgroupVersion,
    default_runtime: info.DefaultRuntime,
  };
}

function filteredImageInspect(repositoryRoot, imageReference) {
  const inspect = JSON.parse(
    command("docker", ["image", "inspect", imageReference, "--format", "{{json .}}"], repositoryRoot),
  );
  return {
    reference: imageReference,
    id: inspect.Id,
    repo_digests: inspect.RepoDigests ?? [],
    created: inspect.Created,
    os: inspect.Os,
    architecture: inspect.Architecture,
    size_bytes: inspect.Size,
    labels: inspect.Config?.Labels ?? {},
  };
}

function filesystemSnapshot(repositoryRoot) {
  const lines = command("df", ["-Pk", repositoryRoot], repositoryRoot).split(/\r?\n/);
  const fields = lines.at(-1).trim().split(/\s+/);
  if (fields.length < 6) fail("unexpected df -Pk output");
  return {
    filesystem: fields[0],
    total_bytes: Number(fields[1]) * 1024,
    used_bytes: Number(fields[2]) * 1024,
    available_bytes: Number(fields[3]) * 1024,
    capacity: fields[4],
    mount: fields.slice(5).join(" "),
  };
}

function toolVersions(repositoryRoot) {
  return {
    docker: command("docker", ["version", "--format", "client={{.Client.Version}} server={{.Server.Version}}"], repositoryRoot),
    git: command("git", ["--version"], repositoryRoot),
    node: process.version,
    jq: command("jq", ["--version"], repositoryRoot),
    just: command("just", ["--version"], repositoryRoot),
  };
}

function selectedEnvironment() {
  const names = [
    "BENCH_PARENT_CACHE_WINDOW_NODES",
    "BENCH_PROOF_MICRO_LAYERS",
    "BENCH_PROOF_MICRO_PROFILE",
    "BENCH_PROOF_PARAMETERS_DIR",
    "BENCH_STACKED_PARENT_CACHE_DIR",
    "BENCH_STACKED_USE_MULTICORE_SDR",
    "BENCH_TELEMETRY_INTERVAL_MS",
    "BENCH_ZIGZAG_PARENT_CACHE_DIR",
    "FIL_PROOFS_USE_MULTICORE_SDR",
    "POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS",
    "RAYON_NUM_THREADS",
  ];
  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
}

export function buildProvenance({
  repositoryRoot,
  imageManifestPath,
  imageReference,
  mode,
  backend,
  sectorSize,
  layers,
  startedUnixMs,
  finishedUnixMs,
  telemetrySummaryPath,
  benchmarkSummaryPath,
}) {
  const imageManifest = JSON.parse(readFileSync(imageManifestPath, "utf8"));
  const siblingRustFilProofs = resolve(repositoryRoot, "..", "rust-fil-proofs");
  const runnerPath = resolve(repositoryRoot, "scripts", "bench-proof-micro.sh");
  const telemetrySourcePath = resolve(
    repositoryRoot,
    "source-overrides",
    "filecoin-ffi",
    "rust",
    "src",
    "bin",
    "support",
    "porep_microbench_telemetry.rs",
  );
  const microbenchSourcePath = resolve(
    repositoryRoot,
    "source-overrides",
    "filecoin-ffi",
    "rust",
    "src",
    "bin",
    "porep-proof-microbench.rs",
  );
  const ioSourcePath = resolve(dirname(microbenchSourcePath), "support", "porep_microbench_io.rs");
  const summarizerPath = resolve(repositoryRoot, "scripts", "summarize-proof-micro-telemetry.mjs");
  const provenanceWriterPath = resolve(repositoryRoot, "scripts", "write-proof-micro-provenance.mjs");
  const reportComposerPath = resolve(repositoryRoot, "scripts", "compose-proof-micro-report.mjs");
  const runDirectory = dirname(benchmarkSummaryPath);
  return {
    schema_version: 1,
    run_id: basename(runDirectory),
    captured_at_unix_ms: Date.now(),
    invocation: {
      mode,
      backend,
      sector_size: sectorSize,
      porep_layers: layers.length === 0 ? null : Number(layers),
      started_unix_ms: Number(startedUnixMs),
      finished_unix_ms: Number(finishedUnixMs),
      outer_wall_ms: Number(finishedUnixMs) - Number(startedUnixMs),
      environment: selectedEnvironment(),
    },
    workspaces: {
      porep_market_devnet: gitState(repositoryRoot),
      rust_fil_proofs: gitState(siblingRustFilProofs),
    },
    build: {
      image_manifest_path: imageManifestPath,
      image_manifest_sha256: sha256File(imageManifestPath),
      manifest: {
        schema_version: imageManifest.schemaVersion,
        platform: imageManifest.platform,
        curio_commit: imageManifest.curioCommit,
        lotus_commit: imageManifest.lotusCommit,
        blst_commit: imageManifest.blstCommit,
        rust_fil_proofs_commit: imageManifest.rustFilProofsCommit,
        dockerfile_sha256: imageManifest.dockerfileSha256,
        zigzag_source_overrides_sha256: imageManifest.zigzagSourceOverridesSha256,
        zigzag_rust_fil_proofs_api_sha256: imageManifest.zigzagRustFilProofsApiSha256,
      },
      image: filteredImageInspect(repositoryRoot, imageReference),
      benchmark_binary: {
        container_path: "/usr/local/bin/porep-proof-microbench",
        build_workdir: "/opt/curio/extern/filecoin-ffi/rust",
        source_override_path: microbenchSourcePath,
        io_source_override_path: ioSourcePath,
        telemetry_source_override_path: telemetrySourcePath,
        cargo_profile: "release",
        cargo_default_features: false,
        cargo_features: ["multicore-sdr", "zigzag-bench"],
      },
    },
    machine: {
      host: {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        cpu_model: os.cpus()[0]?.model ?? null,
        cpu_count: os.cpus().length,
        memory_bytes: os.totalmem(),
      },
      docker: filteredDockerInfo(repositoryRoot),
      filesystem_after_run: filesystemSnapshot(repositoryRoot),
    },
    tools: toolVersions(repositoryRoot),
    instrumentation: {
      runner_sha256: sha256File(runnerPath),
      microbench_source_sha256: sha256File(microbenchSourcePath),
      rust_io_sha256: sha256File(ioSourcePath),
      rust_telemetry_sha256: sha256File(telemetrySourcePath),
      telemetry_summarizer_sha256: sha256File(summarizerPath),
      provenance_writer_sha256: sha256File(provenanceWriterPath),
      report_composer_sha256: sha256File(reportComposerPath),
      telemetry_summary_sha256: sha256File(telemetrySummaryPath),
      benchmark_summary_sha256: sha256File(benchmarkSummaryPath),
    },
  };
}

function main() {
  const [
    outputPath,
    repositoryRoot,
    imageManifestPath,
    imageReference,
    mode,
    backend,
    sectorSize,
    layers,
    startedUnixMs,
    finishedUnixMs,
    telemetrySummaryPath,
    benchmarkSummaryPath,
  ] = process.argv.slice(2);
  if (!benchmarkSummaryPath || process.argv.length !== 14) {
    fail(
      "usage: write-proof-micro-provenance.mjs OUTPUT REPO IMAGE_MANIFEST IMAGE MODE BACKEND SECTOR LAYERS START_MS FINISH_MS TELEMETRY_SUMMARY BENCHMARK_SUMMARY",
    );
  }
  const provenance = buildProvenance({
    repositoryRoot,
    imageManifestPath,
    imageReference,
    mode,
    backend,
    sectorSize,
    layers,
    startedUnixMs,
    finishedUnixMs,
    telemetrySummaryPath,
    benchmarkSummaryPath,
  });
  const temporary = `${outputPath}.temporary-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  renameSync(temporary, outputPath);
}

if (process.argv[1]?.endsWith("write-proof-micro-provenance.mjs")) main();
