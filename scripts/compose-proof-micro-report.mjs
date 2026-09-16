#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";

function fail(message) {
  throw new Error(`proof microbenchmark report: ${message}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

function optionalJson(path) {
  return path === "-" ? null : readJson(path);
}

export function composeReport({
  mode,
  benchmark,
  telemetry,
  provenance,
  prewarm,
  prewarmTelemetry,
}) {
  const phases = Array.isArray(benchmark.phases) ? benchmark.phases : [];
  const measuredPhaseWallMs = phases.reduce((sum, phase) => sum + Number(phase.wall_ms ?? 0), 0);
  const sealingWallMs =
    mode === "full"
      ? phases
          .filter((phase) => !String(phase.name).startsWith("raw_unseal"))
          .reduce((sum, phase) => sum + Number(phase.wall_ms ?? 0), 0)
      : null;
  return {
    schema_version: 1,
    mode,
    benchmark,
    telemetry,
    prewarm,
    prewarm_telemetry: prewarmTelemetry,
    provenance,
    derived: {
      measured_phase_wall_ms: measuredPhaseWallMs,
      sealing_wall_ms: sealingWallMs,
      outer_wall_ms: provenance.invocation.outer_wall_ms,
      unattributed_outer_wall_ms: Math.max(
        0,
        provenance.invocation.outer_wall_ms - measuredPhaseWallMs,
      ),
      cgroup_memory_peak_bytes: telemetry.overall.cgroup.kernel_memory_peak_bytes,
      sampled_process_rss_peak_bytes: telemetry.overall.process_peak.rss_bytes,
      sampled_process_anon_peak_bytes: telemetry.overall.process_peak.rss_anon_bytes,
      sampled_process_file_peak_bytes: telemetry.overall.process_peak.rss_file_bytes,
      sampled_disk_allocated_peak_bytes: telemetry.overall.disk.sampled_total_allocated_peak_bytes,
      swap_peak_bytes: telemetry.overall.cgroup.sampled_swap_current_peak_bytes,
      oom_delta: telemetry.overall.cgroup.memory_events_delta.oom ?? null,
      oom_kill_delta: telemetry.overall.cgroup.memory_events_delta.oom_kill ?? null,
      cpu_quota_cores:
        telemetry.overall.cgroup.cpu_quota_usec === null ||
        telemetry.overall.cgroup.cpu_period_usec === null
          ? null
          : telemetry.overall.cgroup.cpu_quota_usec / telemetry.overall.cgroup.cpu_period_usec,
      cpu_throttled_usec: telemetry.overall.cgroup.cpu_stat_delta.throttled_usec ?? null,
    },
  };
}

function main() {
  const [outputPath, mode, benchmarkPath, telemetryPath, provenancePath, prewarmPath, prewarmTelemetryPath] =
    process.argv.slice(2);
  if (!prewarmTelemetryPath || process.argv.length !== 9) {
    fail(
      "usage: compose-proof-micro-report.mjs OUTPUT MODE BENCHMARK TELEMETRY PROVENANCE PREWARM|- PREWARM_TELEMETRY|-",
    );
  }
  const report = composeReport({
    mode,
    benchmark: readJson(benchmarkPath),
    telemetry: readJson(telemetryPath),
    provenance: readJson(provenancePath),
    prewarm: optionalJson(prewarmPath),
    prewarmTelemetry: optionalJson(prewarmTelemetryPath),
  });
  const temporary = `${outputPath}.temporary-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  renameSync(temporary, outputPath);
}

if (process.argv[1]?.endsWith("compose-proof-micro-report.mjs")) main();
