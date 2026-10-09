import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { summarizeTelemetry } from "../summarize-proof-micro-telemetry.mjs";
import { composeReport, parseBellpersonTimings, parseParameterDiagnostics, renderPhaseMarkdown } from "../compose-proof-micro-report.mjs";
import { writeFailureReport } from "../write-proof-micro-failure.mjs";

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

test("Groth16 query and batch boundaries retain sizes, anon/file RSS, cgroup I/O and PSI", () => {
  const batch = { partition_start: 0, partition_count: 1 };
  const query = { query_family: "h", query_points: 2, encoded_bytes: 192, decoded_bytes: 208 };
  const before = { cpu_ms: 110, rss_bytes: 300, rss_anon_bytes: 250, rss_file_bytes: 50 };
  const after = { cpu_ms: 210, rss_bytes: 250, rss_anon_bytes: 200, rss_file_bytes: 50 };
  const cgroup = { memory_max_bytes: 85899345920, memory_swap_max_bytes: 0, memory_current_bytes: 320, memory_peak_bytes: 500,
    memory_pressure: { some: { total_usec: 7 } }, io_stat: { rbytes: 192, rios: 1 } };
  const telemetry = summarize([
    sample(0, 0, 100, "phase_start"),
    sample(1, 10, 110, "operation_start", { process: before, cgroup, operation: { ...boundary(1, "groth16_batch", null, "start"), details: batch }, active_operation_ids: [1] }),
    sample(2, 20, 120, "operation_start", { operation: { ...boundary(2, "groth16_query_h", null, "start"), details: query }, active_operation_ids: [1, 2] }),
    sample(3, 30, 130, "operation_end", { operation: { ...boundary(2, "groth16_query_h", null, "end", true), details: query }, active_operation_ids: [1, 2] }),
    sample(4, 40, 210, "operation_end", { process: after, cgroup, operation: { ...boundary(1, "groth16_batch", null, "end", true), details: batch }, active_operation_ids: [1] }),
    sample(5, 50, 220, "phase_end"),
  ].map((entry) => ({ ...entry, phase: "commit_phase2_groth16" })));
  const layout = { kind: "layout", loader: "compact", index_metadata_bytes: 120, legacy_index_element_bytes: 240, file_bytes: 3000 };
  const decoded = { kind: "query", family: "h", points: 2, encoded_bytes: 192, decoded_bytes: 208, wall_ms: 10, completed: true };
  const logs = `2026-10-08T12:00:00 INFO storage_proofs_porep::zigzag::circuit::compound > zigzag_parameters ${JSON.stringify(layout)}\n` +
    JSON.stringify({ message: `zigzag_parameters ${JSON.stringify(decoded)}` }) + "\nzigzag_parameters {broken";
  assert.deepEqual(parseParameterDiagnostics(logs).map(({ source, line_number, ...entry }) => entry), [layout, decoded]);
  const result = report(telemetry, [{ name: "commit_phase2_groth16", phase_id: 1, wall_ms: 50, cpu_ms: 120 }], {
    benchmark: { phases: [{ name: "commit_phase2_groth16", phase_id: 1, wall_ms: 50, cpu_ms: 120 }], cpu_configuration: { parameter_loader: "compact", allocator_configuration: { tuning_applied: false } } }, measuredLog: logs,
  });
  assert.equal(result.parameter_loader, "compact");
  assert.deepEqual(result.memory_budget.memory_limit_bytes, 85899345920);
  assert.equal(result.memory_budget.swap_limit_bytes, 0);
  assert.equal(result.derived.sealing_wall_ms, 50);
  assert.equal(result.derived.sealing_cpu_ms, 120);
  assert.deepEqual(result.c2_suboperations.map((entry) => entry.details), [batch, query]);
  assert.deepEqual(result.c2_suboperations[0].boundary_snapshots.before.process, before);
  assert.deepEqual(result.c2_suboperations[0].boundary_snapshots.after.process, after);
  assert.deepEqual(result.c2_suboperations[0].boundary_snapshots.after.cgroup, cgroup);
  assert.deepEqual(result.phases[0].boundary_snapshots.after.process, telemetry.phase_intervals[0].boundary_snapshots.after.process);
  assert.deepEqual(result.groth16_parameters.map(({ source, line_number, ...entry }) => entry), [layout, decoded]);
  const markdown = renderPhaseMarkdown(result);
  assert.match(markdown, /\| compact \| 120 \| 240 \| 3000 \|/);
  assert.match(markdown, /groth16_query_h/);
  assert.match(markdown, /Remaining RSS is not a measurement of free allocator memory/);
});

test("Groth16 operation excludes loading and vanilla while the enclosing phase retains their cost", () => {
  const intervals = [
    [1, "groth16_parameter_load", 0, 10, 0, 20],
    [2, "vanilla_proving", 10, 50, 20, 100],
    [3, "vanilla_verification", 50, 60, 100, 120],
    [4, "groth16_c2", 60, 90, 120, 240],
  ];
  const samples = [sample(0, 0, 0, "phase_start")];
  for (const [id, name, start, end, cpuStart, cpuEnd] of intervals) {
    samples.push(sample(samples.length, start, cpuStart, "operation_start", {
      operation: boundary(id, name, null, "start"), active_operation_ids: [id],
    }));
    samples.push(sample(samples.length, end, cpuEnd, "operation_end", {
      operation: boundary(id, name, null, "end", true), active_operation_ids: [id],
    }));
  }
  // The last 10 ms cover API-level VK lookup and seal-proof serialization.
  samples.push(sample(samples.length, 100, 250, "phase_end", { phase_completed: true }));
  const telemetry = summarize(samples.map((entry) => ({ ...entry, phase: "commit_phase2_groth16" })));
  const result = report(telemetry, [{ name: "commit_phase2_groth16", phase_id: 1, wall_ms: 100, cpu_ms: 250 }]);
  assert.deepEqual(result.c2_suboperations.map((operation) => operation.name), ["groth16_parameter_load", "groth16_c2"]);
  const c2 = result.c2_suboperations[1];
  assert.equal(c2.wall_ms, 30);
  assert.equal(c2.cpu_ms, 120);
  assert.deepEqual(c2.overlapping_operation_ids, []);
  assert.equal(result.derived.sealing_wall_ms, 100);
  assert.equal(result.derived.sealing_cpu_ms, 250);
  assert.equal(result.telemetry.operations.filter((operation) => operation.name.startsWith("vanilla_")).length, 2);
  assert.match(renderPhaseMarkdown(result), /groth16_c2 measures circuit\/batch proving in both API paths/);
});

test("interrupted full C2 records OOM, partial query metadata and missing batch end", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-micro-full-failure-"));
  try {
    const path = (name) => join(directory, name);
    writeFileSync(path("container.json"), JSON.stringify({ state: { Running: false, OOMKilled: true }, memory_limit_bytes: 85899345920, memory_swap_limit_bytes: 85899345920 }));
    const entry = sample(0, 10, 110, "operation_start", { phase: "commit_phase2_groth16", operation: { ...boundary(1, "groth16_batch", null, "start"), details: { partition_start: 2, partition_count: 1 } }, active_operation_ids: [1] });
    writeFileSync(path("telemetry.ndjson"), JSON.stringify(entry) + "\n{interrupted");
    writeFileSync(path("summary.json"), "");
    writeFileSync(path("manifest.json"), "{}"); // Exercise unavailable provenance diagnostics, too.
    const cpu = { parameter_loader: "compact", allocator_configuration: { tuning_applied: false } };
    writeFileSync(path("stderr.log"), `ZigZag CPU configuration: ${JSON.stringify(cpu)}\nINFO storage_proofs_porep::zigzag::parameters > zigzag_parameters {"kind":"layout","loader":"compact","index_metadata_bytes":120}\n`);
    const result = writeFailureReport({ mode: "full", outputPath: path("report.json"), repositoryRoot: directory, imageManifestPath: path("manifest.json"), imageReference: "fixture", backend: "zigzag", sectorSize: "512mib", startedUnixMs: "1000", finishedUnixMs: "2000", exitCode: "137", containerPath: path("container.json"), rawTelemetryPath: path("telemetry.ndjson"), stdoutPath: path("summary.json"), stderrPath: path("stderr.log"), phasePath: "-" });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.kind, "container_oom");
    assert.equal(result.failure.exit_code, 137);
    assert.equal(result.derived.docker_oom_killed, true);
    assert.equal(result.benchmark, null);
    assert.equal(result.derived.sealing_wall_ms, null);
    assert.equal(result.c2_suboperations[0].boundary_coverage, "missing_end");
    assert.equal(result.c2_suboperations[0].boundary_snapshots.after, null);
    assert.equal(result.parameter_loader, "compact");
    assert.equal(result.provenance.invocation.memory_limit_bytes, 85899345920);
    assert.equal(result.provenance.invocation.swap_limit_bytes, 0);
    assert.equal(result.provenance.invocation.docker_memory_swap_limit_bytes, 85899345920);
    assert.equal(result.memory_budget.memory_limit_bytes, 85899345920);
    assert.equal(result.memory_budget.swap_limit_bytes, 0);
    assert.equal(result.groth16_parameters[0].index_metadata_bytes, 120);
    assert.match(result.diagnostics.errors.join("\n"), /invalid JSON/);
    assert.match(readFileSync(path("summary.md"), "utf8"), /No successful full proof\/verify\/unseal result/);
    assert.ok(readFileSync(path("telemetry-summary.json"), "utf8").includes("groth16_batch"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("full benchmark exit trap records OOM and validation failures before removing stopped containers", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-micro-full-trap-"));
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const source = readFileSync(join(root, "scripts/bench-proof-micro.sh"), "utf8");
    const fn = source.match(/bench_measured_exit\(\) \{[\s\S]*?\n\}\n/)[0];
    const path = (name) => join(directory, name);
    writeFileSync(path("container.cid"), "a".repeat(64));
    writeFileSync(path("manifest.json"), "{}");
    writeFileSync(path("summary.json"), "");
    writeFileSync(path("stderr.log"), 'ZigZag CPU configuration: {"parameter_loader":"compact"}\n');
    writeFileSync(path("telemetry.ndjson"), JSON.stringify(sample(0, 0, 1)) + "\n");
    const docker = `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then
  [[ "$TRAP_SCENARIO" != unavailable ]] || exit 1
  running=false; [[ "$TRAP_SCENARIO" != running ]] || running=true
  oom=true; container_exit=137
  if [[ "$TRAP_SCENARIO" == validation ]]; then oom=false; container_exit=0; fi
  printf '{"state":{"Running":%s,"OOMKilled":%s,"ExitCode":%s},"memory_limit_bytes":85899345920,"memory_swap_limit_bytes":85899345920}\\n' "$running" "$oom" "$container_exit"
elif [[ "$1" == rm ]]; then
  jq -e --argjson code "$TRAP_FAILURE_CODE" --argjson oom "$TRAP_OOM" '.status == "failed" and .failure.exit_code == $code and .derived.docker_oom_killed == $oom' "$TRAP_DIRECTORY/report.json" >/dev/null || exit 98
  printf removed > "$TRAP_DIRECTORY/removed"
else exit 99
fi
`;
    writeFileSync(path("docker"), docker, { mode: 0o755 });
    const code = `set -euo pipefail
${fn}
DEVNET_ROOT="$1"; run_dir="$2"
measured_cidfile="$run_dir/container.cid"; report_json="$run_dir/report.json"
image_manifest="$run_dir/manifest.json"; image=fixture; backend=zigzag; sector_size=512mib
measured_started_ms=1000; measured_finished_ms=2000; benchmark_results_saved=0
if [[ "$TRAP_SCENARIO" != validation ]]; then measured_exit_code=137; fi
telemetry_ndjson="$run_dir/telemetry.ndjson"; summary_json="$run_dir/summary.json"; stderr_log="$run_dir/stderr.log"
trap bench_measured_exit EXIT
exit "$3"
`;
    for (const scenario of ["stopped", "unavailable", "running", "validation"]) {
      const exitCode = scenario === "validation" ? 1 : 137;
      const oom = scenario !== "validation";
      rmSync(path("removed"), { force: true });
      const result = spawnSync("bash", ["-c", code, "full-trap-test", root, directory, String(exitCode)], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TRAP_SCENARIO: scenario, TRAP_DIRECTORY: directory, TRAP_FAILURE_CODE: String(exitCode), TRAP_OOM: String(oom) } });
      assert.equal(result.status, exitCode, result.stderr);
      const report = JSON.parse(readFileSync(path("report.json"), "utf8"));
      assert.equal(report.failure.exit_code, exitCode);
      assert.equal(report.mode, "full");
      assert.equal(report.benchmark, null);
      assert.equal(report.derived.docker_oom_killed, scenario === "unavailable" ? null : oom);
      if (scenario === "validation") assert.equal(report.failure.container.state.ExitCode, 0);
      if (scenario === "stopped" || scenario === "validation") assert.equal(readFileSync(path("removed"), "utf8"), "removed");
      else assert.throws(() => readFileSync(path("removed")), /ENOENT/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cleanup failures preserve a validated full benchmark report and record errors separately", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-micro-cleanup-failure-"));
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const source = readFileSync(join(root, "scripts/bench-proof-micro.sh"), "utf8");
    const exitFn = source.match(/bench_measured_exit\(\) \{[\s\S]*?\n\}\n/)[0];
    const cleanupFn = source.match(/bench_cleanup_successful_run\(\) \{[\s\S]*?\n\}\n/)[0];
    // Exercise the actual success marker's placement between report output and cleanup.
    const footer = source.slice(source.lastIndexOf("\nbench_append_telemetry_markdown ") + 1);
    const path = (name) => join(directory, name);
    const telemetry = summarize([sample(0, 0, 10, "phase_start"), sample(1, 10, 30, "phase_end")]);
    const benchmark = { verify_seal: true, raw_unseal_bytes_match: true,
      phases: [{ name: "commit_phase2_groth16", wall_ms: 10, cpu_ms: 20 }] };
    const result = report(telemetry, benchmark.phases, { benchmark });
    const retained = {
      "report.json": JSON.stringify(result),
      "summary.json": JSON.stringify(benchmark),
      "telemetry-summary.json": JSON.stringify(telemetry),
      "provenance.json": JSON.stringify(result.provenance),
    };
    const markdown = renderPhaseMarkdown(result);
    writeFileSync(path("container.cid"), "a".repeat(64));
    writeFileSync(path("manifest.json"), "{}");
    writeFileSync(path("stderr.log"), "");
    writeFileSync(path("telemetry.ndjson"), JSON.stringify(sample(0, 0, 1)) + "\n");
    writeFileSync(path("docker"), `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then
  printf '{"state":{"Running":false,"OOMKilled":false,"ExitCode":0}}\\n'
elif [[ "$1" == buildx && "$2" == prune ]]; then
  printf 'fixture BuildKit cleanup failed\\n' >&2
  exit 17
elif [[ "$1" == rm ]]; then
  jq -e '.benchmark.verify_seal == true and .benchmark.raw_unseal_bytes_match == true' "$TRAP_DIRECTORY/report.json" >/dev/null || exit 98
  [[ -s "$TRAP_DIRECTORY/post-run-error.json" ]] || exit 98
  printf removed > "$TRAP_DIRECTORY/removed"
else exit 99
fi
`, { mode: 0o755 });
    writeFileSync(path("node"), `#!/usr/bin/env bash
if [[ "$1" == */cleanup-proof-micro-artifacts.mjs ]]; then
  printf 'fixture artifact cleanup failed\\n' >&2
  exit 23
fi
exec "$REAL_NODE" "$@"
`, { mode: 0o755 });
    const code = `set -euo pipefail
${exitFn}
${cleanupFn}
devnet_progress() { :; }
devnet_die() { printf '%s\\n' "$*" >&2; exit 1; }
bench_append_telemetry_markdown() { :; }
DEVNET_ROOT="$1"; run_dir="$2"
measured_cidfile="$run_dir/container.cid"; report_json="$run_dir/report.json"; summary_md="$run_dir/summary.md"
image_manifest="$run_dir/manifest.json"; image=fixture; backend=zigzag; sector_size=512mib; mode=full
measured_started_ms=1000; measured_finished_ms=2000
telemetry_ndjson="$run_dir/telemetry.ndjson"; summary_json="$run_dir/summary.json"; stderr_log="$run_dir/stderr.log"
retain_zigzag_work_artifacts="$3"; prune_buildkit_after_bench="$3"; parent_cache_kind=zigzag
trap bench_measured_exit EXIT
${footer}
`;
    for (const scenario of [
      { retain: "1", operation: "buildkit_prune", exitCode: 17, log: "buildkit-prune.log" },
      { retain: "0", operation: "artifact_cleanup", exitCode: 23, log: "cleanup.stderr.log" },
    ]) {
      for (const [name, content] of Object.entries(retained)) writeFileSync(path(name), content);
      writeFileSync(path("summary.md"), markdown);
      rmSync(path("post-run-error.json"), { force: true });
      rmSync(path("removed"), { force: true });
      const shell = spawnSync("bash", ["-c", code, "cleanup-trap-test", root, directory, scenario.retain], {
        encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, REAL_NODE: process.execPath, TRAP_DIRECTORY: directory },
      });
      assert.equal(shell.status, 1, shell.stderr);
      for (const [name, content] of Object.entries(retained)) assert.equal(readFileSync(path(name), "utf8"), content, name);
      assert.ok(readFileSync(path("summary.md"), "utf8").startsWith(markdown));
      const error = JSON.parse(readFileSync(path("post-run-error.json"), "utf8"));
      assert.equal(error.schema_version, 1);
      assert.equal(error.benchmark_results_saved, true);
      assert.equal(error.operation, scenario.operation);
      assert.equal(error.exit_code, scenario.exitCode);
      assert.equal(error.script_exit_code, 1);
      assert.equal(error.log, scenario.log);
      assert.equal(error.container.state.ExitCode, 0);
      assert.equal(error.container.state.OOMKilled, false);
      assert.match(readFileSync(path(scenario.log), "utf8"), /fixture .* cleanup failed/);
      assert.equal(readFileSync(path("removed"), "utf8"), "removed");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
