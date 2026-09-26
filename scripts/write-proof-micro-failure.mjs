#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { composeReport } from "./compose-proof-micro-report.mjs";
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
  const telemetrySummaryPath = join(runDirectory, "param-prewarm-telemetry-summary.json");
  writeJson(telemetrySummaryPath, telemetry.summary ?? {
    schema_version: 1, sample_count: 0, overall: null, errors: telemetry.errors,
  });
  let provenance;
  try {
    provenance = buildProvenance({
      ...options,
      mode: "prewarm-only",
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
        mode: "prewarm-only", backend: options.backend, sector_size: options.sectorSize,
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
  writeJson(join(runDirectory, "provenance.json"), provenance);
  const report = telemetry.summary ? composeReport({
    mode: "prewarm-only", benchmark: {}, telemetry: telemetry.summary, provenance,
    prewarm: null, prewarmTelemetry: null,
  }) : {
    schema_version: 1, mode: "prewarm-only", telemetry: null, provenance,
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
    last_setup_phase: read(options.phasePath)?.trim() || null,
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
  return report;
}

if (process.argv[1]?.endsWith("write-proof-micro-failure.mjs")) {
  const [outputPath, repositoryRoot, imageManifestPath, imageReference, backend, sectorSize,
    startedUnixMs, finishedUnixMs, exitCode, containerPath, rawTelemetryPath, stdoutPath,
    stderrPath, phasePath] = process.argv.slice(2);
  if (!phasePath || process.argv.length !== 16) throw new Error("invalid prewarm failure report arguments");
  writeFailureReport({ outputPath, repositoryRoot, imageManifestPath, imageReference, backend,
    sectorSize, startedUnixMs, finishedUnixMs, exitCode, containerPath, rawTelemetryPath,
    stdoutPath, stderrPath, phasePath });
}
