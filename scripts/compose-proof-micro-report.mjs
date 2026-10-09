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

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumMetrics(phases, field) {
  if (phases.length === 0 || phases.some((phase) => numeric(phase[field]) === null)) return null;
  return phases.reduce((sum, phase) => sum + phase[field], 0);
}

function averageCores(cpu, wall) {
  return cpu !== null && wall > 0 ? cpu / wall : null;
}

function memoryMetrics(window, maxRss = null, interval = null) {
  const sampling = window?.sampling ?? (window ? {
    sampling_interval_ms: interval,
    sample_count: window.sample_count ?? null,
    interval_sample_count: window.trigger_counts ? window.trigger_counts.interval ?? 0 : null,
    boundary_sample_count: window.trigger_counts
      ? Object.entries(window.trigger_counts).filter(([trigger]) => /^(phase|operation)_(start|end)$/.test(trigger)).reduce((sum, [, count]) => sum + count, 0)
      : null,
    maximum_observed_sample_gap_ms: null,
    gaps_exceeding_interval_count: null,
    sampled_peak_may_miss_short_spikes: true,
  } : null);
  return {
    sampled_phase_peak: {
      cgroup_memory_current_bytes: window?.cgroup?.sampled_memory_current_peak_bytes ?? null,
      process_rss_bytes: window?.process_peak?.rss_bytes ?? null,
      process_rss_anon_bytes: window?.process_peak?.rss_anon_bytes ?? null,
      process_rss_file_bytes: window?.process_peak?.rss_file_bytes ?? null,
    },
    cumulative_high_water_marks: {
      process_ru_maxrss_bytes: maxRss,
      cgroup_memory_peak_bytes: window?.cgroup?.kernel_memory_peak_bytes ?? null,
    },
    sampling,
  };
}

export function parseBellpersonTimings(raw) {
  const factors = { ns: 0.000001, us: 0.001, "µs": 0.001, "μs": 0.001, ms: 1, s: 1000 };
  return raw.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/bellperson::groth16::prover(?:::\w+)*\b.*?\b(synthesis|prover) time:\s*([0-9]+(?:\.[0-9]+)?)(ns|µs|μs|us|ms|s)\b/);
    return match ? [{
      name: match[1], wall_ms: Number(match[2]) * factors[match[3]],
      cpu_ms: null, average_cpu_cores: null, sampled_phase_peak: null,
      source: "stderr.log", line_number: index + 1,
      measurement_scope: "auxiliary_bellperson_timer_do_not_add_to_sealing",
    }] : [];
  });
}

export function parseCpuDiagnostics(raw) {
  // fil_logger 0.1.7 renders module_path, not the custom log target. Match
  // diagnostic messages from their actual modules, retaining target-based logs
  // from other formatters without collecting unrelated ZigZag phase messages.
  const module = /\bstorage_proofs_porep::zigzag::(?:cache_policy|vanilla::(?:cores|parent_table|vde))\b/;
  const diagnostic = /\b(?:encode (?:affinity|producers=)|zigzag (?:encode affinity|multicore encode L3 affinity)|parent records mmap_window_nodes=|DONTNEED (?:advised_bytes=|unavailable:))/;
  return raw.split(/\r?\n/).flatMap((line, index) => {
    const matches = /\bzigzag_(cpu|cache)\b/.test(line) || (module.test(line) && diagnostic.test(line));
    return matches ? [{ line_number: index + 1, source: "stderr.log", message: line }] : [];
  });
}

export function parseParameterDiagnostics(raw) {
  return raw.split(/\r?\n/).flatMap((line, index) => {
    let message = line;
    try {
      const envelope = JSON.parse(line);
      message = envelope.message ?? envelope.msg ?? line;
    } catch {}
    const match = String(message).match(/\bzigzag_parameters (\{.*\})\s*$/);
    if (!match) return [];
    try {
      return [{ ...JSON.parse(match[1]), source: "stderr.log", line_number: index + 1 }];
    } catch { return []; }
  });
}

export function composeReport({
  mode,
  benchmark,
  telemetry,
  provenance,
  prewarm,
  prewarmTelemetry,
  measuredLog = null,
}) {
  const nativePhases = Array.isArray(benchmark.phases) ? benchmark.phases : [];
  const phases = nativePhases.map((phase) => {
    const window = phase.phase_id != null
      ? telemetry.phase_intervals?.find((entry) => entry.phase_id === phase.phase_id && entry.phase === phase.name)
      : telemetry.phases.find((entry) => entry.phase === phase.name);
    const cpu = numeric(phase.cpu_ms);
    const wall = numeric(phase.wall_ms);
    return {
      ...phase, wall_ms: wall, cpu_ms: cpu, average_cpu_cores: averageCores(cpu, wall),
      start_elapsed_ms: phase.start_elapsed_ms ?? window?.start_elapsed_ms ?? null,
      end_elapsed_ms: phase.end_elapsed_ms ?? window?.end_elapsed_ms ?? null,
      completed: phase.completed ?? window?.completed ?? null,
      measurement_scope: "whole_process_during_interval",
      boundary_snapshots: window?.boundary_snapshots ?? null,
      ...memoryMetrics(window, numeric(phase.max_rss_bytes), telemetry.sampling_interval_ms),
    };
  });
  const sealingPhases = phases.filter((phase) => !String(phase.name).startsWith("raw_unseal") && phase.name !== "parameter_prewarm");
  const measuredPhaseWallMs = sumMetrics(phases, "wall_ms");
  const sealingWallMs = mode === "full" ? sumMetrics(sealingPhases, "wall_ms") : null;
  const sealingCpuMs = mode === "full" ? sumMetrics(sealingPhases, "cpu_ms") : null;
  const pc1Suboperations = (telemetry.operations ?? []).filter((operation) => operation.parent_phase === "pre_commit_phase1")
    .map((operation) => ({ ...operation, ...memoryMetrics(operation) }));
  const auxiliary = mode === "full" && measuredLog !== null ? parseBellpersonTimings(measuredLog) : [];
  return {
    schema_version: 1,
    mode,
    benchmark,
    cpu_configuration: benchmark.cpu_configuration ?? null,
    cpu_diagnostics: measuredLog === null ? [] : parseCpuDiagnostics(measuredLog),
    parameter_loader: benchmark.cpu_configuration?.parameter_loader ?? provenance.invocation.parameter_loader ?? null,
    allocator_configuration: benchmark.cpu_configuration?.allocator_configuration ?? provenance.invocation.allocator_configuration ?? null,
    memory_budget: {
      memory_limit_bytes: telemetry.overall.cgroup.memory_max_bytes ?? provenance.invocation.memory_limit_bytes ?? null,
      swap_limit_bytes: telemetry.overall.cgroup.swap_max_bytes ?? provenance.invocation.swap_limit_bytes ?? null,
      scope: "effective container cgroup; 60 GiB is the configured default, 80 GiB is the override ceiling; successful sealing at the selected limit requires validation",
    },
    groth16_parameters: measuredLog === null ? [] : parseParameterDiagnostics(measuredLog),
    telemetry,
    prewarm,
    prewarm_telemetry: prewarmTelemetry,
    provenance,
    phases,
    pc1_suboperations: pc1Suboperations,
    c2_suboperations: (telemetry.operations ?? []).filter((operation) => operation.name.startsWith("groth16_"))
      .map((operation) => ({ ...operation, ...memoryMetrics(operation) })),
    auxiliary_c2_timings: auxiliary.length ? auxiliary : null,
    measurement_units: { wall_ms: "milliseconds", cpu_ms: "process CPU milliseconds", average_cpu_cores: "logical cores; 1 = one fully occupied core", memory: "bytes", elapsed_ms: "milliseconds since telemetry session start" },
    measurement_semantics: {
      sampled_phase_peak: "Maximum of periodic and boundary samples; spikes between samples may be missed.",
      cumulative_high_water_marks: "ru_maxrss and memory.peak are maxima since process/cgroup start, not independent phase peaks.",
      concurrent_operations: "CPU deltas and RAM describe the whole process in each window. Overlapping suboperations must not be summed.",
      sealing_totals: "Main phases only, once each; excludes prewarm, raw_unseal and all suboperations/auxiliary timers.",
    },
    derived: {
      measured_phase_wall_ms: measuredPhaseWallMs,
      sealing_wall_ms: sealingWallMs,
      sealing_cpu_ms: sealingCpuMs,
      sealing_average_cpu_cores: averageCores(sealingCpuMs, sealingWallMs),
      raw_unseal_wall_ms: sumMetrics(phases.filter((phase) => String(phase.name).startsWith("raw_unseal")), "wall_ms"),
      outer_wall_ms: provenance.invocation.outer_wall_ms,
      unattributed_outer_wall_ms: measuredPhaseWallMs === null ? null : Math.max(0, provenance.invocation.outer_wall_ms - measuredPhaseWallMs),
      cgroup_memory_peak_bytes: telemetry.overall.cgroup.kernel_memory_peak_bytes,
      sampled_process_rss_peak_bytes: telemetry.overall.process_peak.rss_bytes,
      sampled_process_anon_peak_bytes: telemetry.overall.process_peak.rss_anon_bytes,
      sampled_process_file_peak_bytes: telemetry.overall.process_peak.rss_file_bytes,
      sampled_disk_allocated_peak_bytes: telemetry.overall.disk.sampled_total_allocated_peak_bytes,
      swap_peak_bytes: telemetry.overall.cgroup.sampled_swap_current_peak_bytes,
      oom_delta: telemetry.overall.cgroup.memory_events_delta.oom ?? null,
      oom_kill_delta: telemetry.overall.cgroup.memory_events_delta.oom_kill ?? null,
      cpu_quota_cores:
        numeric(telemetry.overall.cgroup.cpu_quota_usec) !== null &&
        numeric(telemetry.overall.cgroup.cpu_period_usec) > 0
          ? telemetry.overall.cgroup.cpu_quota_usec / telemetry.overall.cgroup.cpu_period_usec
          : null,
      cpu_throttled_usec: telemetry.overall.cgroup.cpu_stat_delta.throttled_usec ?? null,
    },
  };
}

export function renderPhaseMarkdown(report) {
  const value = (raw) => numeric(raw) === null ? "unavailable" : String(raw);
  const row = (label, phase) => {
    const peak = phase.sampled_phase_peak;
    return `| ${label} | ${value(phase.wall_ms)} | ${value(phase.cpu_ms)} | ${value(phase.average_cpu_cores)} | ${value(peak?.cgroup_memory_current_bytes)} | ${value(peak?.process_rss_bytes)} | ${value(peak?.process_rss_anon_bytes)} | ${value(peak?.process_rss_file_bytes)} | ${value(phase.sampling?.sample_count)} | ${value(phase.sampling?.maximum_observed_sample_gap_ms)} |`;
  };
  const header = [
    "| Phase / operation | Wall ms | Process CPU ms | Average logical cores | Sampled cgroup B | Sampled RSS B | Sampled anon RSS B | Sampled file RSS B | Samples | Max gap ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const lines = ["", "## Phase CPU, timing and sampled memory", "",
    "Values use milliseconds and bytes, matching [`report.json`](./report.json). CPU is a process counter delta; one average logical core means one fully occupied core.", "",
    ...header, ...report.phases.map((phase) => row(`\`${phase.name}\``, phase)), "",
    `Sealing (main phases once): ${value(report.derived.sealing_wall_ms)} ms wall, ${value(report.derived.sealing_cpu_ms)} ms process CPU. Raw unseal: ${value(report.derived.raw_unseal_wall_ms)} ms wall. Prewarm is recorded separately.`, "",
    "Memory columns are **sampled phase peaks** from interval and boundary samples; short spikes can be missed. Sampling intervals, boundary counts and gaps are recorded per window in JSON. `ru_maxrss` and kernel `memory.peak` are cumulative high-water marks since process/cgroup start, not independent phase peaks.", "",
    "| Phase | Cumulative process ru_maxrss B | Cumulative cgroup memory.peak B |",
    "| --- | ---: | ---: |",
    ...report.phases.map((phase) => `| \`${phase.name}\` | ${value(phase.cumulative_high_water_marks.process_ru_maxrss_bytes)} | ${value(phase.cumulative_high_water_marks.cgroup_memory_peak_bytes)} |`), "",
    "## PC1 suboperations", "", ...header,
  ];
  for (const operation of report.pc1_suboperations) {
    lines.push(row(`\`${operation.name}\` id=${operation.id}${operation.layer === null ? "" : ` layer=${operation.layer}`} (${operation.completed === null ? "incomplete" : operation.completed ? "completed" : "failed"})`, operation));
  }
  if (report.pc1_suboperations.length === 0) lines.push("", "PC1 suboperation measurements unavailable.");
  lines.push("", "Layer numbers are zero-based. Operation IDs, start/end intervals and overlaps are preserved in JSON. CPU and RAM cover the whole process during each operation; overlapping windows must not be summed or treated as exclusive worker usage.", "", "## Auxiliary C2 timers", "");
  if (report.auxiliary_c2_timings === null) lines.push("Bellperson synthesis/prover timers unavailable; full C2 remains in the phase table.");
  else {
    lines.push("| Bellperson timer | Wall ms | Source |", "| --- | ---: | --- |");
    for (const timer of report.auxiliary_c2_timings) lines.push(`| ${timer.name} | ${value(timer.wall_ms)} | [stderr.log line ${timer.line_number}](./stderr.log) |`);
    lines.push("", "Auxiliary library timers are not added to sealing or C2 totals.");
  }
  if (report.cpu_configuration) {
    const cpu = report.cpu_configuration;
    lines.push("", "## CPU configuration", "",
      `Independent pools: Rayon **${value(cpu.rayon_num_threads)}**, ec-gpu **${value(cpu.ec_gpu_num_threads)}**. Allowed CPUs: \`${cpu.cpus_allowed_list ?? "unavailable"}\`.`, "",
      `Encode: affinity=${cpu.encode_affinity}, producers=${value(cpu.encode_producers)}, stride=${value(cpu.encode_stride)}, lookahead=${value(cpu.encode_lookahead)}. Parent cache=${cpu.parent_cache}, requested mmap window=${value(cpu.parent_cache_window_nodes)} nodes.`, "",
      `Cache policy: \`${JSON.stringify(cpu.cache_policy)}\`. DONTNEED is advisory; historical trees are retained and C1 rereads remain measured.`, "",
      "Actual binding/restoration and fallback diagnostics are in `cpu_diagnostics` in [`report.json`](./report.json) and [`stderr.log`](./stderr.log). Build features: [`cargo-features.txt`](./cargo-features.txt); SHA-NI eligibility alone does not establish the active backend.");
  }
  if (report.parameter_loader || report.c2_suboperations?.length) {
    lines.push("", "## Groth16 parameters and batch memory", "",
      "Loader: " + (report.parameter_loader ?? "unavailable") + ". Effective container RAM limit: " + value(report.memory_budget?.memory_limit_bytes) + " B; swap limit: " + value(report.memory_budget?.swap_limit_bytes) + " B.", "",
      "Allocator configuration: " + JSON.stringify(report.allocator_configuration ?? null) + ".",
      "Before/after process anon/file RSS, cgroup counters, I/O and PSI are recorded in boundary_snapshots in report.json. The batch end is after Bellperson releases circuits/query builders. Remaining RSS is not a measurement of free allocator memory.",
      "groth16_c2 measures circuit/batch proving in both API paths. Parameter loading, vanilla proving/validation, API-level VK lookup and final seal-proof serialization are outside this operation; the enclosing benchmark phase still includes them.", "", ...header);
    for (const operation of report.c2_suboperations ?? []) {
      lines.push(row(operation.name + " id=" + operation.id + " " + JSON.stringify(operation.details ?? {}), operation));
    }
    lines.push("", "| Loader | Query index metadata B | Legacy index elements B | Parameter file B |", "| --- | ---: | ---: | ---: |");
    for (const layout of report.groth16_parameters ?? []) {
      if (layout.kind === "layout") lines.push("| " + layout.loader + " | " + layout.index_metadata_bytes + " | " + layout.legacy_index_element_bytes + " | " + layout.file_bytes + " |");
    }
    lines.push("", "Per-family point counts, encoded/decoded sizes and decode times are in groth16_parameters. Query index sizes exclude VK, decoded points and mmap/page cache. Nested or overlapping operations are not added to C2 or sealing totals.");
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  if (process.argv[2] === "--phase-markdown" && process.argv.length === 4) {
    process.stdout.write(renderPhaseMarkdown(readJson(process.argv[3])));
    return;
  }
  const [outputPath, mode, benchmarkPath, telemetryPath, provenancePath, prewarmPath, prewarmTelemetryPath, logPath] =
    process.argv.slice(2);
  if (!prewarmTelemetryPath || ![9, 10].includes(process.argv.length)) {
    fail(
      "usage: compose-proof-micro-report.mjs OUTPUT MODE BENCHMARK TELEMETRY PROVENANCE PREWARM|- PREWARM_TELEMETRY|- [MEASURED_STDERR|-]",
    );
  }
  const report = composeReport({
    mode,
    benchmark: readJson(benchmarkPath),
    telemetry: readJson(telemetryPath),
    provenance: readJson(provenancePath),
    prewarm: optionalJson(prewarmPath),
    prewarmTelemetry: optionalJson(prewarmTelemetryPath),
    measuredLog: logPath && logPath !== "-" ? readFileSync(logPath, "utf8") : null,
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
