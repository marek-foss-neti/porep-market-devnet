#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { composeReport, parseParameterDiagnostics, renderPhaseMarkdown } from "./compose-proof-micro-report.mjs";
import { summarizeTelemetry } from "./summarize-proof-micro-telemetry.mjs";
import { buildProvenance } from "./write-proof-micro-provenance.mjs";

function writeJson(path, value) {
  const temporary = `${path}.temporary-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  renameSync(temporary, path);
}

export function interruptedTelemetry(raw) {
  const lines = [];
  const errors = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      lines.push(line);
    } catch (error) {
      errors.push(`telemetry stops at invalid JSON on line ${index + 1}: ${error.message}`);
      break;
    }
  }
  try {
    return { summary: summarizeTelemetry(lines.join("\n")), errors, complete: false };
  } catch (error) {
    return { summary: null, errors: [...errors, error.message], complete: false };
  }
}

export function writeFailureReport(options) {
  const mode = options.mode ?? "prewarm-only";
  const errors = [];
  const read = (path) => {
    try { return readFileSync(path, "utf8"); }
    catch (error) { errors.push(`${path}: ${error.message}`); return null; }
  };
  const parse = (path) => {
    const raw = read(path);
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch (error) { errors.push(`${path}: ${error.message}`); return null; }
  };
  const container = parse(options.containerPath);
  const telemetry = interruptedTelemetry(read(options.rawTelemetryPath) ?? "");
  const runDirectory = dirname(options.outputPath);
  const telemetrySummaryPath = join(runDirectory, mode === "full" ? "telemetry-summary.json" : "param-prewarm-telemetry-summary.json");
  writeJson(telemetrySummaryPath, telemetry.summary ?? {
    schema_version: 1, sample_count: 0, overall: null, errors: telemetry.errors,
  });
  let provenance;
  try {
    provenance = buildProvenance({
      ...options,
      mode,
      layers: "",
      telemetrySummaryPath,
      benchmarkSummaryPath: options.stdoutPath,
    });
  } catch (error) {
    errors.push(`provenance: ${error.message}`);
    // Even Docker startup or a failed diagnostic command must leave a report.
    provenance = {
      schema_version: 1,
      run_id: basename(runDirectory),
      invocation: {
        mode, backend: options.backend, sector_size: options.sectorSize,
        started_unix_ms: Number(options.startedUnixMs), finished_unix_ms: Number(options.finishedUnixMs),
        outer_wall_ms: Number(options.finishedUnixMs) - Number(options.startedUnixMs),
      },
      build: {
        image_manifest_path: options.imageManifestPath,
        manifest: parse(options.imageManifestPath),
        image: { reference: options.imageReference, id: null },
      },
      diagnostic_error: error.message,
    };
  }
  const measuredLog = read(options.stderrPath) ?? "";
  let cpu = null;
  const configuration = measuredLog.match(/ZigZag CPU configuration: (\{[^\n]*\})/);
  if (configuration) { try { cpu = JSON.parse(configuration[1]); } catch {} }
  provenance.invocation.parameter_loader = cpu?.parameter_loader ?? null;
  provenance.invocation.allocator_configuration = cpu?.allocator_configuration ?? null;
  provenance.invocation.memory_limit_bytes = container?.memory_limit_bytes ?? telemetry.summary?.overall.cgroup.memory_max_bytes ?? null;
  provenance.invocation.docker_memory_swap_limit_bytes = container?.memory_swap_limit_bytes ?? null;
  // Docker's MemorySwap is the combined RAM+swap budget, unlike memory.swap.max.
  const additionalSwap = container?.memory_limit_bytes > 0 && container?.memory_swap_limit_bytes > 0
    ? Math.max(0, container.memory_swap_limit_bytes - container.memory_limit_bytes) : null;
  provenance.invocation.swap_limit_bytes = telemetry.summary?.overall.cgroup.swap_max_bytes ?? additionalSwap;
  writeJson(join(runDirectory, "provenance.json"), provenance);
  const report = telemetry.summary ? composeReport({
    mode, benchmark: { cpu_configuration: cpu }, telemetry: telemetry.summary, provenance,
    prewarm: null, prewarmTelemetry: null,
    measuredLog,
  }) : {
    schema_version: 1, mode, telemetry: null, provenance,
    parameter_loader: cpu?.parameter_loader ?? null,
    allocator_configuration: cpu?.allocator_configuration ?? null,
    memory_budget: { memory_limit_bytes: provenance.invocation.memory_limit_bytes, swap_limit_bytes: provenance.invocation.swap_limit_bytes, scope: "Docker final configuration; cgroup samples unavailable" },
    groth16_parameters: parseParameterDiagnostics(measuredLog),
    prewarm: null, prewarm_telemetry: null,
    derived: {
      outer_wall_ms: provenance.invocation.outer_wall_ms,
      cgroup_memory_peak_bytes: null, oom_delta: null, oom_kill_delta: null,
    },
  };
  report.status = "failed";
  report.benchmark = null;
  report.failure = {
    kind: container?.state?.OOMKilled === true ? "container_oom" : "nonzero_exit",
    exit_code: Number(options.exitCode),
    container,
    last_setup_phase: mode === "prewarm-only" ? read(options.phasePath)?.trim() || null : null,
    raw_telemetry_path: options.rawTelemetryPath,
    stdout_path: options.stdoutPath,
    stderr_path: options.stderrPath,
  };
  // Docker's final state is independent of sampled cgroup event counters.
  report.derived.docker_oom_killed = container?.state?.OOMKilled ?? null;
  report.diagnostics = {
    errors: [...errors, ...telemetry.errors],
    telemetry_complete: false,
    container_state_available: container?.state != null,
  };
  writeJson(options.outputPath, report);
  if (mode === "full") {
    const phases = Array.isArray(report.phases) ? renderPhaseMarkdown(report) : "";
    writeFileSync(join(runDirectory, "summary.md"),
      "# Interrupted full ZigZag benchmark\n\nExit code: " + report.failure.exit_code +
      "; Docker OOMKilled: " + String(report.derived.docker_oom_killed) +
      ". No successful full proof/verify/unseal result or sealing total is claimed.\n\nSee [report.json](./report.json) and [stderr.log](./stderr.log).\n" + phases);
  }
  return report;
}

if (process.argv[1]?.endsWith("write-proof-micro-failure.mjs")) {
  const [outputPath, repositoryRoot, imageManifestPath, imageReference, backend, sectorSize,
    startedUnixMs, finishedUnixMs, exitCode, containerPath, rawTelemetryPath, stdoutPath,
    stderrPath, phasePath, mode = "prewarm-only"] = process.argv.slice(2);
  if (!phasePath || ![16, 17].includes(process.argv.length) || !["prewarm-only", "full"].includes(mode)) throw new Error("invalid failure report arguments");
  writeFailureReport({ outputPath, repositoryRoot, imageManifestPath, imageReference, backend,
    sectorSize, startedUnixMs, finishedUnixMs, exitCode, containerPath, rawTelemetryPath,
    stdoutPath, stderrPath, phasePath, mode });
}
