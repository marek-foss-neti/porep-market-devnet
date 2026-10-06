import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { summarizeTelemetry } from "../summarize-proof-micro-telemetry.mjs";
import { composeReport, parseBellpersonTimings, renderPhaseMarkdown } from "../compose-proof-micro-report.mjs";

function sample(sequence, elapsed, cpu, trigger = "interval", extra = {}) {
  return {
    schema_version: 1, sequence, pid: 42, sampling_interval_ms: 100,
    timestamp_unix_ms: 1000 + elapsed, elapsed_ms: elapsed, trigger,
    phase: "pre_commit_phase1", phase_id: 1,
    process: { cpu_ms: cpu, rss_bytes: 80 + sequence, rss_anon_bytes: 60, rss_file_bytes: 20 },
    cgroup: { memory_current_bytes: 100 + sequence, memory_peak_bytes: 900 },
    disk: { paths: [], total_apparent_bytes: 10, total_allocated_bytes: 10 },
    warnings: [], ...extra,
  };
}

function boundary(id, name, layer, boundary, completed = null) {
  return { id, name, layer, boundary, completed };
}

function summarize(samples) {
  return summarizeTelemetry(samples.map((entry) => JSON.stringify(entry)).join("\n"));
}

function report(telemetry, phases, extra = {}) {
  return composeReport({ mode: "full", benchmark: { phases }, telemetry,
    provenance: { invocation: { outer_wall_ms: 1000 } }, prewarm: { wall_ms: 9999 },
    prewarmTelemetry: null, ...extra });
}

test("operation boundaries assign CPU deltas, sampled RAM and layer IDs including short windows", () => {
  const telemetry = summarize([
    sample(0, 0, 1000, "phase_start"),
    sample(1, 1, 1001, "operation_start", { operation: boundary(7, "tree_d_build", null, "start"), active_operation_ids: [7] }),
    sample(2, 2, 1004, "operation_end", { operation: boundary(7, "tree_d_build", null, "end", true), active_operation_ids: [7] }),
    sample(3, 2, 1004, "operation_start", { operation: boundary(8, "encode", 0, "start"), active_operation_ids: [8] }),
    sample(4, 102, 1204, "interval", { active_operation_ids: [8], process: { cpu_ms: 1204, rss_bytes: 500, rss_anon_bytes: 450, rss_file_bytes: 50 } }),
    sample(5, 202, 1404, "operation_end", { operation: boundary(8, "encode", 0, "end", true), active_operation_ids: [8] }),
    sample(6, 202, 1404, "operation_start", { operation: boundary(9, "tree_r", 0, "start"), active_operation_ids: [9] }),
    sample(7, 203, 1408, "operation_end", { operation: boundary(9, "tree_r", 0, "end", true), active_operation_ids: [9] }),
    sample(8, 210, 1420, "phase_end", { phase_completed: true }),
  ]);
  const [treeD, encode, treeR] = telemetry.operations;
  assert.equal(treeD.cpu_ms, 3);
  assert.equal(treeD.wall_ms, 1);
  assert.equal(treeD.average_cpu_cores, 3);
  assert.equal(treeD.sample_count, 2);
  assert.equal(treeD.sampling.interval_sample_count, 0);
  assert.equal(treeD.process_peak.cpu_ms, 1004); // Historical field is explicitly cumulative.
  assert.equal(treeD.process_peak.cpu_ms_scope, "cumulative_counter_since_process_start");
  assert.equal(encode.cpu_ms, 400);
  assert.equal(encode.process_peak.rss_bytes, 500);
  assert.equal(encode.process_peak.rss_anon_bytes, 450);
  assert.equal(encode.layer, 0);
  assert.equal(treeR.cpu_ms, 4);
  assert.deepEqual(encode.overlapping_operation_ids, []);
  assert.equal(telemetry.phase_intervals[0].cpu_ms, 420);
  const result = report(telemetry, [
    { name: "pre_commit_phase1", phase_id: 1, wall_ms: 210, cpu_ms: 420, max_rss_bytes: 800 },
    { name: "commit_phase2_groth16", wall_ms: 30, cpu_ms: 120 },
    { name: "verify", wall_ms: 10, cpu_ms: 10 },
    { name: "raw_unseal", wall_ms: 50, cpu_ms: 50 },
  ]);
  assert.equal(result.derived.sealing_wall_ms, 250);
  assert.equal(result.derived.sealing_cpu_ms, 550);
  assert.equal(result.derived.raw_unseal_wall_ms, 50);
  assert.equal(result.derived.measured_phase_wall_ms, 300);
  assert.equal(result.pc1_suboperations.length, 3);
  assert.equal(result.phases[0].sampled_phase_peak.process_rss_bytes, 500);
  assert.equal(result.phases[0].cumulative_high_water_marks.process_ru_maxrss_bytes, 800);
  assert.equal(result.phases[0].cumulative_high_water_marks.cgroup_memory_peak_bytes, 900);
  assert.equal(result.phases[1].sampled_phase_peak.process_rss_bytes, null);
  const markdown = renderPhaseMarkdown(result);
  for (const entry of [...result.phases, ...result.pc1_suboperations]) {
    assert.ok(markdown.includes(`| ${entry.wall_ms} | ${entry.cpu_ms} | ${entry.average_cpu_cores} |`));
  }
  assert.match(markdown, /\| `encode` id=8 layer=0 \(completed\) \| 200 \| 400 \| 2 \| 105 \| 500 \| 450 \| 50 \| 3 \| 100 \|/);
  assert.match(markdown, /sampled phase peaks/);
  assert.match(markdown, /cumulative high-water marks/);
  assert.match(markdown, /report\.json/);
});

test("concurrent operations keep independent IDs and whole-process intervals without adding totals", () => {
  const telemetry = summarize([
    sample(0, 0, 100, "phase_start"),
    sample(1, 10, 110, "operation_start", { operation: boundary(1, "tree_r", 0, "start"), active_operation_ids: [1] }),
    sample(2, 20, 140, "operation_start", { operation: boundary(2, "encode", 1, "start"), active_operation_ids: [1, 2] }),
    sample(3, 30, 190, "operation_end", { operation: boundary(1, "tree_r", 0, "end", true), active_operation_ids: [1, 2] }),
    sample(4, 40, 200, "operation_end", { operation: boundary(2, "encode", 1, "end", true), active_operation_ids: [2] }),
    sample(5, 50, 210, "phase_end"),
  ]);
  assert.deepEqual(telemetry.operations.map((entry) => entry.overlapping_operation_ids), [[2], [1]]);
  assert.deepEqual(telemetry.operations.map((entry) => entry.cpu_ms), [80, 60]);
  const result = report(telemetry, [{ name: "pre_commit_phase1", phase_id: 1, wall_ms: 50, cpu_ms: 110 }]);
  assert.equal(result.derived.sealing_cpu_ms, 110);
  assert.equal(result.derived.sealing_wall_ms, 50);
  assert.ok(result.pc1_suboperations.every((entry) => entry.measurement_scope === "whole_process_during_interval"));
});

test("zero-time, failed and interrupted operations preserve nulls and sampling gaps", () => {
  const telemetry = summarize([
    sample(0, 0, 100, "phase_start"),
    sample(1, 1, 101, "operation_start", { operation: boundary(1, "encode", 0, "start"), active_operation_ids: [1] }),
    sample(2, 1, 101, "operation_end", { operation: boundary(1, "encode", 0, "end", false), active_operation_ids: [1] }),
    sample(3, 2, 102, "operation_start", { operation: boundary(2, "tree_r", 0, "start"), active_operation_ids: [2] }),
    sample(4, 502, null, "interval", { active_operation_ids: [2] }),
  ]);
  assert.equal(telemetry.operations[0].average_cpu_cores, null);
  assert.equal(telemetry.operations[0].completed, false);
  assert.equal(telemetry.operations[1].completed, null);
  assert.equal(telemetry.operations[1].cpu_ms, null);
  assert.equal(telemetry.operations[1].wall_ms, null);
  assert.equal(telemetry.operations[1].boundary_coverage, "missing_end");
  assert.equal(telemetry.operations[1].overlap_status, "unknown");
  assert.equal(telemetry.operations[1].sampling.maximum_observed_sample_gap_ms, 500);
  assert.equal(telemetry.operations[1].sampling.gaps_exceeding_interval_count, 1);
  const result = report(telemetry, [{ name: "pre_commit_phase1", phase_id: 1, wall_ms: 0, cpu_ms: null }]);
  assert.equal(result.phases[0].average_cpu_cores, null);
  assert.equal(result.derived.sealing_cpu_ms, null);
  assert.match(renderPhaseMarkdown(result), /failed/);
  assert.match(renderPhaseMarkdown(result), /incomplete/);
  assert.match(renderPhaseMarkdown(result), /unavailable/);
  assert.equal(report(telemetry, []).derived.sealing_wall_ms, null);
});

test("legacy samples remain readable and repeated phase names are joined by ID", () => {
  const legacy = summarize([
    sample(0, 0, 100, "phase_start", { phase_id: undefined }),
    sample(1, 10, 120, "phase_end", { phase_id: undefined }),
  ]);
  assert.deepEqual(legacy.operations, []);
  assert.equal(report(legacy, [{ name: "pre_commit_phase1", wall_ms: 10 }]).phases[0].cpu_ms, null);
  assert.equal(legacy.phases[0].cpu_ms, 20);
  const repeated = summarize([
    sample(0, 0, 100, "phase_start"), sample(1, 10, 120, "phase_end"),
    sample(2, 100, 200, "phase_start", { phase_id: 2 }),
    sample(3, 110, 220, "phase_end", { phase_id: 2 }),
  ]);
  const result = report(repeated, [1, 2].map((id) => ({ name: "pre_commit_phase1", phase_id: id, wall_ms: 10, cpu_ms: 20 })));
  assert.deepEqual(result.phases.map((entry) => entry.sampling.sample_count), [2, 2]);
  assert.deepEqual(result.phases.map((entry) => entry.start_elapsed_ms), [0, 100]);
  assert.equal(repeated.phases[0].cpu_ms, null); // Never subtract across the intervening work.
});

test("overlap remains observable when concurrent boundaries share a millisecond", () => {
  const telemetry = summarize([
    sample(0, 0, 0, "operation_start", { operation: boundary(1, "tree_r", 0, "start"), active_operation_ids: [1] }),
    sample(1, 0, 0, "operation_start", { operation: boundary(2, "encode", 1, "start"), active_operation_ids: [1, 2] }),
    sample(2, 0, 0, "operation_end", { operation: boundary(1, "tree_r", 0, "end", true), active_operation_ids: [1, 2] }),
    sample(3, 0, 0, "operation_end", { operation: boundary(2, "encode", 1, "end", true), active_operation_ids: [2] }),
  ]);
  assert.deepEqual(telemetry.operations.map((entry) => entry.overlapping_operation_ids), [[2], [1]]);
  assert.ok(telemetry.operations.every((entry) => entry.average_cpu_cores === null));
});

test("invalid streams and inconsistent operation boundaries fail validation", () => {
  assert.throws(() => summarizeTelemetry(""), /no samples/);
  assert.throws(() => summarizeTelemetry("{"), /invalid JSON/);
  assert.throws(() => summarize([sample(1, 0, 0)]), /non-contiguous/);
  assert.throws(() => summarize([sample(0, 0, 0), sample(1, -1, 0)]), /invalid elapsed/);
  assert.throws(() => summarize([sample(0, 0, 0, "operation_end", { operation: boundary(1, "encode", 0, "end", true) })]), /unmatched/);
  assert.throws(() => summarize([
    sample(0, 0, 0, "operation_start", { operation: boundary(1, "encode", 0, "start") }),
    sample(1, 1, 0, "operation_end", { operation: boundary(1, "encode", 1, "end", true) }),
  ]), /metadata changed/);
  assert.throws(() => summarize([sample(0, 0, 0, "interval", { active_operation_ids: [9] })]), /invalid active/);
});

test("Bellperson auxiliary synthesis/prover timers support Rust Duration units and remain outside totals", () => {
  const raw = "INFO bellperson::groth16::prover::native > synthesis time: 1.5s\nINFO bellperson::groth16::prover::native > prover time: 42ms\nINFO bellperson::groth16::prover > synthesis time: 2µs\nINFO bellperson::groth16::prover > prover time: 3ns\nother synthesis time: 99s";
  assert.deepEqual(parseBellpersonTimings(raw).map((entry) => entry.wall_ms), [1500, 42, 0.002, 0.000003]);
  const result = report(summarize([sample(0, 0, 10)]), [{ name: "commit_phase2_groth16", wall_ms: 2000, cpu_ms: 4000 }], { measuredLog: raw });
  assert.equal(result.derived.sealing_wall_ms, 2000);
  assert.equal(result.auxiliary_c2_timings.length, 4);
  assert.match(renderPhaseMarkdown(result), /synthesis \| 1500/);
});

test("CLI produces JSON and Markdown from the same measurements", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-micro-measurements-"));
  try {
    const telemetry = summarize([sample(0, 0, 10, "phase_start"), sample(1, 10, 30, "phase_end")]);
    const paths = ["report.json", "benchmark.json", "telemetry.json", "provenance.json"].map((file) => join(directory, file));
    writeFileSync(paths[1], JSON.stringify({ phases: [{ name: "pre_commit_phase1", phase_id: 1, wall_ms: 10, cpu_ms: 20 }] }));
    writeFileSync(paths[2], JSON.stringify(telemetry));
    writeFileSync(paths[3], JSON.stringify({ invocation: { outer_wall_ms: 20 } }));
    const script = new URL("../compose-proof-micro-report.mjs", import.meta.url);
    const composed = spawnSync(process.execPath, [script.pathname, paths[0], "full", ...paths.slice(1), "-", "-"], { encoding: "utf8" });
    assert.equal(composed.status, 0, composed.stderr);
    const output = JSON.parse(readFileSync(paths[0], "utf8"));
    const rendered = spawnSync(process.execPath, [script.pathname, "--phase-markdown", paths[0]], { encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout, renderPhaseMarkdown(output));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("benchmark shell appends the canonical phase table and preserves existing telemetry", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-micro-markdown-"));
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const source = readFileSync(join(root, "scripts/bench-proof-micro.sh"), "utf8");
    const fn = source.match(/bench_append_telemetry_markdown\(\) \{[\s\S]*?\n\}\n/)[0];
    const result = report(summarize([sample(0, 0, 10, "phase_start"), sample(1, 10, 30, "phase_end")]),
      [{ name: "pre_commit_phase1", phase_id: 1, wall_ms: 10, cpu_ms: 20, max_rss_bytes: 1000 }]);
    const json = join(directory, "report.json");
    const markdown = join(directory, "summary.md");
    writeFileSync(json, JSON.stringify(result));
    const rendered = spawnSync("bash", ["-c", `${fn}\nbench_append_telemetry_markdown "$1" "$2"`, "measurement-test", json, markdown], {
      encoding: "utf8", env: { ...process.env, DEVNET_ROOT: root },
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    const output = readFileSync(markdown, "utf8");
    assert.ok(output.startsWith(renderPhaseMarkdown(result)));
    assert.match(output, /Container and disk telemetry/);
    assert.match(output, /telemetry-summary\.json/);
    assert.match(output, /\| `pre_commit_phase1` \| 1000 \| 900 \|/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
