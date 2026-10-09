#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";

function fail(message) {
  throw new Error(`proof microbenchmark telemetry: ${message}`);
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function maximum(samples, select) {
  return samples.reduce((peak, sample) => {
    const value = numeric(select(sample));
    return value === null ? peak : peak === null ? value : Math.max(peak, value);
  }, null);
}

function samplingQuality(samples, start = null, end = null) {
  const interval = samples[0]?.sampling_interval_ms ?? null;
  const times = samples.map((sample) => sample.elapsed_ms);
  if (start !== null) times.push(start);
  if (end !== null) times.push(end);
  times.sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  return {
    sampling_interval_ms: interval,
    sample_count: samples.length,
    interval_sample_count: samples.filter((sample) => sample.trigger === "interval").length,
    boundary_sample_count: samples.filter((sample) => /^(phase|operation)_(start|end)$/.test(sample.trigger)).length,
    maximum_observed_sample_gap_ms: gaps.reduce((peak, gap) => Math.max(peak, gap), 0),
    gaps_exceeding_interval_count: interval === null ? null : gaps.filter((gap) => gap > interval).length,
    sampled_peak_may_miss_short_spikes: true,
  };
}

function windowMetrics(samples, start, end) {
  const before = numeric(start?.process?.cpu_ms);
  const after = numeric(end?.process?.cpu_ms);
  const wall = start && end ? end.elapsed_ms - start.elapsed_ms : null;
  const cpu = before === null || after === null || after < before ? null : after - before;
  return {
    start_elapsed_ms: start?.elapsed_ms ?? null,
    end_elapsed_ms: end?.elapsed_ms ?? null,
    wall_ms: wall,
    cpu_ms: cpu,
    average_cpu_cores: wall > 0 && cpu !== null ? cpu / wall : null,
    measurement_scope: "whole_process_during_interval",
    sampling: samplingQuality(samples),
    boundary_snapshots: {
      before: start ? { elapsed_ms: start.elapsed_ms, process: start.process, cgroup: start.cgroup } : null,
      after: end ? { elapsed_ms: end.elapsed_ms, process: end.process, cgroup: end.cgroup } : null,
    },
  };
}

function operationSummaries(samples) {
  const operations = new Map();
  const active = new Set();
  for (const sample of samples) {
    const event = sample.operation;
    if (event) {
      if (!Number.isSafeInteger(event.id) || event.id < 1 || typeof event.name !== "string" ||
          !["start", "end"].includes(event.boundary) ||
          (event.layer !== null && (!Number.isSafeInteger(event.layer) || event.layer < 0))) {
        fail(`invalid operation boundary on sample ${sample.sequence}`);
      }
      if (event.boundary === "start") {
        if (operations.has(event.id)) fail(`duplicate operation start: ${event.id}`);
        operations.set(event.id, { event, start: sample, end: null, samples: [], overlaps: new Set() });
        active.add(event.id);
      } else {
        const operation = operations.get(event.id);
        if (!operation || operation.end) fail(`unmatched operation end: ${event.id}`);
        if (operation.event.name !== event.name || operation.event.layer !== event.layer ||
            JSON.stringify(operation.event.details ?? null) !== JSON.stringify(event.details ?? null) ||
            typeof event.completed !== "boolean") fail(`operation metadata changed: ${event.id}`);
        operation.end = sample;
      }
    }
    if (sample.active_operation_ids !== undefined) {
      if (!Array.isArray(sample.active_operation_ids) ||
          sample.active_operation_ids.length !== active.size ||
          new Set(sample.active_operation_ids).size !== active.size ||
          sample.active_operation_ids.some((id) => !active.has(id))) {
        fail(`invalid active operations on sample ${sample.sequence}`);
      }
    }
    for (const id of active) {
      const operation = operations.get(id);
      operation.samples.push(sample);
      for (const other of active) if (other !== id) operation.overlaps.add(other);
    }
    if (event?.boundary === "end") active.delete(event.id);
  }
  return [...operations.values()].map(({ event, start, end, samples: window, overlaps }) => ({
    id: event.id,
    name: event.name,
    layer: event.layer,
    details: event.details ?? null,
    parent_phase: start.phase,
    parent_phase_id: start.phase_id ?? null,
    completed: end?.operation.completed ?? null,
    boundary_coverage: end ? "complete" : "missing_end",
    overlap_status: end ? "checked" : "unknown",
    overlapping_operation_ids: [...overlaps].sort((a, b) => a - b),
    ...windowMetrics(window, start, end),
    ...aggregateSamples(window),
  }));
}

function firstPresent(samples, select) {
  for (const sample of samples) {
    const value = select(sample);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function peakMap(samples, select) {
  const result = {};
  for (const sample of samples) {
    const values = select(sample) ?? {};
    for (const [name, value] of Object.entries(values)) {
      const parsed = numeric(value);
      if (parsed === null) continue;
      result[name] = Math.max(result[name] ?? 0, parsed);
    }
  }
  return result;
}

function deltaMap(first, last) {
  const result = {};
  for (const name of new Set([...Object.keys(first ?? {}), ...Object.keys(last ?? {})])) {
    const before = numeric(first?.[name]);
    const after = numeric(last?.[name]);
    if (before !== null && after !== null) result[name] = Math.max(0, after - before);
  }
  return result;
}

function pressureDelta(first, last) {
  const result = {};
  for (const kind of ["some", "full"]) {
    const before = numeric(first?.[kind]?.total_usec);
    const after = numeric(last?.[kind]?.total_usec);
    result[`${kind}_total_usec`] =
      before === null || after === null ? null : Math.max(0, after - before);
  }
  return result;
}

function diskPathPeaks(samples) {
  const paths = new Map();
  for (const sample of samples) {
    for (const entry of sample.disk?.paths ?? []) {
      const key = `${entry.label}\0${entry.path}`;
      const current = paths.get(key) ?? {
        label: entry.label,
        path: entry.path,
        ever_existed: false,
        peak_apparent_bytes: 0,
        peak_allocated_bytes: 0,
        errors: new Set(),
      };
      current.ever_existed ||= entry.exists === true;
      current.peak_apparent_bytes = Math.max(
        current.peak_apparent_bytes,
        numeric(entry.apparent_bytes) ?? 0,
      );
      current.peak_allocated_bytes = Math.max(
        current.peak_allocated_bytes,
        numeric(entry.allocated_bytes) ?? 0,
      );
      if (typeof entry.error === "string" && entry.error.length > 0) current.errors.add(entry.error);
      paths.set(key, current);
    }
  }
  return [...paths.values()].map((entry) => ({
    ...entry,
    errors: [...entry.errors].sort(),
  }));
}

function aggregateSamples(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  return {
    sample_count: samples.length,
    first_elapsed_ms: first.elapsed_ms,
    last_elapsed_ms: last.elapsed_ms,
    trigger_counts: Object.fromEntries(
      [...new Set(samples.map((sample) => sample.trigger))].map((trigger) => [
        trigger,
        samples.filter((sample) => sample.trigger === trigger).length,
      ]),
    ),
    process_peak: {
      vm_size_bytes: maximum(samples, (sample) => sample.process?.vm_size_bytes),
      rss_bytes: maximum(samples, (sample) => sample.process?.rss_bytes),
      rss_anon_bytes: maximum(samples, (sample) => sample.process?.rss_anon_bytes),
      rss_file_bytes: maximum(samples, (sample) => sample.process?.rss_file_bytes),
      rss_shmem_bytes: maximum(samples, (sample) => sample.process?.rss_shmem_bytes),
      vm_swap_bytes: maximum(samples, (sample) => sample.process?.vm_swap_bytes),
      threads: maximum(samples, (sample) => sample.process?.threads),
      cpu_ms: maximum(samples, (sample) => sample.process?.cpu_ms),
      cpu_ms_scope: "cumulative_counter_since_process_start",
    },
    cgroup: {
      sampled_memory_current_peak_bytes: maximum(
        samples,
        (sample) => sample.cgroup?.memory_current_bytes,
      ),
      kernel_memory_peak_bytes: maximum(samples, (sample) => sample.cgroup?.memory_peak_bytes),
      kernel_memory_peak_scope: "high_water_mark_since_cgroup_start",
      memory_max_bytes: firstPresent(samples, (sample) => sample.cgroup?.memory_max_bytes),
      memory_max_unlimited: samples.some((sample) => sample.cgroup?.memory_max_unlimited === true),
      sampled_swap_current_peak_bytes: maximum(
        samples,
        (sample) => sample.cgroup?.memory_swap_current_bytes,
      ),
      swap_max_bytes: firstPresent(samples, (sample) => sample.cgroup?.memory_swap_max_bytes),
      swap_max_unlimited: samples.some(
        (sample) => sample.cgroup?.memory_swap_max_unlimited === true,
      ),
      memory_stat_peak: peakMap(samples, (sample) => sample.cgroup?.memory_stat),
      memory_events_delta: deltaMap(first.cgroup?.memory_events, last.cgroup?.memory_events),
      cpu_quota_usec: firstPresent(samples, (sample) => sample.cgroup?.cpu_quota_usec),
      cpu_period_usec: firstPresent(samples, (sample) => sample.cgroup?.cpu_period_usec),
      cpu_quota_unlimited: samples.some((sample) => sample.cgroup?.cpu_quota_unlimited === true),
      cpuset_cpus_effective: firstPresent(
        samples,
        (sample) => sample.cgroup?.cpuset_cpus_effective,
      ),
      cpuset_mems_effective: firstPresent(
        samples,
        (sample) => sample.cgroup?.cpuset_mems_effective,
      ),
      cpu_weight: firstPresent(samples, (sample) => sample.cgroup?.cpu_weight),
      cpu_stat_delta: deltaMap(first.cgroup?.cpu_stat, last.cgroup?.cpu_stat),
      io_stat_delta: deltaMap(first.cgroup?.io_stat, last.cgroup?.io_stat),
      memory_pressure_delta: pressureDelta(
        first.cgroup?.memory_pressure,
        last.cgroup?.memory_pressure,
      ),
      io_pressure_delta: pressureDelta(first.cgroup?.io_pressure, last.cgroup?.io_pressure),
    },
    disk: {
      sampled_total_apparent_peak_bytes: maximum(
        samples,
        (sample) => sample.disk?.total_apparent_bytes,
      ),
      sampled_total_allocated_peak_bytes: maximum(
        samples,
        (sample) => sample.disk?.total_allocated_bytes,
      ),
      path_peaks: diskPathPeaks(samples),
    },
  };
}

export function summarizeTelemetry(raw) {
  const samples = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`invalid JSON on line ${index + 1}: ${error.message}`);
      }
    });
  if (samples.length === 0) fail("no samples were recorded");
  const interval = samples[0].sampling_interval_ms;
  const pid = samples[0].pid;
  if (!Number.isFinite(interval) || interval <= 0) fail("invalid sampling interval");
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.schema_version !== 1) fail(`unsupported sample schema on line ${index + 1}`);
    if (sample.sequence !== index) fail(`non-contiguous sequence on line ${index + 1}`);
    if (sample.pid !== pid) fail(`PID changed on line ${index + 1}`);
    if (sample.sampling_interval_ms !== interval) fail(`sampling interval changed on line ${index + 1}`);
    if (numeric(sample.elapsed_ms) === null || sample.elapsed_ms < 0) fail(`invalid elapsed time on line ${index + 1}`);
    if (typeof sample.phase !== "string" || sample.phase.length === 0) fail(`invalid phase on line ${index + 1}`);
    if (sample.phase_id != null && (!Number.isSafeInteger(sample.phase_id) || sample.phase_id < 1)) fail(`invalid phase ID on line ${index + 1}`);
    if (index > 0 && sample.elapsed_ms < samples[index - 1].elapsed_ms) {
      fail(`elapsed time moved backwards on line ${index + 1}`);
    }
  }

  const phaseOrder = [...new Set(samples.map((sample) => sample.phase))];
  const warnings = [...new Set(samples.flatMap((sample) => sample.warnings ?? []))].sort();
  const diskErrors = [
    ...new Set(
      samples.flatMap((sample) =>
        (sample.disk?.paths ?? [])
          .map((entry) => entry.error)
          .filter((error) => typeof error === "string" && error.length > 0),
      ),
    ),
  ].sort();

  return {
    schema_version: 1,
    sample_schema_version: 1,
    pid,
    sampling_interval_ms: interval,
    first_timestamp_unix_ms: samples[0].timestamp_unix_ms,
    last_timestamp_unix_ms: samples.at(-1).timestamp_unix_ms,
    elapsed_ms: samples.at(-1).elapsed_ms,
    sample_count: samples.length,
    interval_sample_count: samples.filter((sample) => sample.trigger === "interval").length,
    maximum_observed_sample_gap_ms: samplingQuality(samples).maximum_observed_sample_gap_ms,
    phases: phaseOrder.map((phase) => {
      const window = samples.filter((sample) => sample.phase === phase);
      const starts = window.filter((sample) => sample.trigger === "phase_start");
      const ends = window.filter((sample) => sample.trigger === "phase_end");
      const singleInterval = starts.length === 1 && ends.length === 1;
      return {
        phase,
        ...windowMetrics(window, singleInterval ? starts[0] : null, singleInterval ? ends[0] : null),
        ...aggregateSamples(window),
      };
    }),
    phase_intervals: [...new Set(samples.filter((sample) => sample.phase_id != null).map((sample) => sample.phase_id))]
      .map((id) => {
        const window = samples.filter((sample) => sample.phase_id === id);
        const start = window.find((sample) => sample.trigger === "phase_start");
        const end = window.find((sample) => sample.trigger === "phase_end");
        return {
          phase: window[0].phase, phase_id: id,
          completed: end?.phase_completed ?? null,
          boundary_coverage: start && end ? "complete" : "incomplete",
          ...windowMetrics(window, start, end),
          ...aggregateSamples(window),
        };
      }),
    operations: operationSummaries(samples),
    sampling: samplingQuality(samples),
    overall: aggregateSamples(samples),
    warnings,
    disk_errors: diskErrors,
  };
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) {
    fail("usage: summarize-proof-micro-telemetry.mjs INPUT.ndjson OUTPUT.json");
  }
  const summary = summarizeTelemetry(readFileSync(inputPath, "utf8"));
  const temporary = `${outputPath}.temporary-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  renameSync(temporary, outputPath);
}

if (process.argv[1]?.endsWith("summarize-proof-micro-telemetry.mjs")) main();
