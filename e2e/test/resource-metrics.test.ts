import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCgroupMetricsOutput,
  summarizeResourceSamples,
  type ResourceSample,
} from "../src/devnet/resourceMetrics.js";

test("parses cgroup resource metric snapshots", () => {
  assert.deepEqual(parseCgroupMetricsOutput([
    "cpu_usage_usec=123456",
    "memory_current_bytes=2097152",
    "memory_peak_bytes=4194304",
    "io_read_bytes=1024",
    "io_write_bytes=2048",
  ].join("\n")), {
    cpuUsageUsec: 123_456,
    memoryCurrentBytes: 2_097_152,
    memoryPeakBytes: 4_194_304,
    ioReadBytes: 1_024,
    ioWriteBytes: 2_048,
  });

  assert.deepEqual(parseCgroupMetricsOutput("cpu_usage_usec=not-a-number\n"), {
    cpuUsageUsec: null,
    memoryCurrentBytes: null,
    memoryPeakBytes: null,
    ioReadBytes: null,
    ioWriteBytes: null,
  });
});

test("summarizes resource samples into per-service and total benchmark metrics", () => {
  const samples: ResourceSample[] = [
    sample("curio", 0, 1_000_000, 100, 150, 1_000, 2_000),
    sample("lotus", 0, 500_000, 80, 100, 5_000, 8_000),
    sample("curio", 2_000, 3_000_000, 220, 230, 3_048, 7_000),
    sample("lotus", 2_000, 1_000_000, 90, 110, 5_000, 9_024),
  ];

  const summary = summarizeResourceSamples(
    "seal-unseal",
    "2026-08-06T00:00:00.000Z",
    "2026-08-06T00:00:02.000Z",
    2_000,
    1_000,
    "/tmp/metrics.ndjson",
    "/tmp/summary.json",
    ["curio", "lotus"],
    samples,
  );

  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.services[0]?.service, "curio");
  assert.equal(summary.services[0]?.cpuTimeMs, 2_000);
  assert.equal(summary.services[0]?.averageCpuCores, 1);
  assert.equal(summary.services[0]?.peakObservedMemoryBytes, 220);
  assert.equal(summary.services[0]?.ioReadBytes, 2_048);
  assert.equal(summary.services[1]?.cpuTimeMs, 500);
  assert.equal(summary.totals.cpuTimeMs, 2_500);
  assert.equal(summary.totals.averageCpuCores, 1.25);
  assert.equal(summary.totals.peakObservedMemoryBytes, 310);
  assert.equal(summary.totals.ioWriteBytes, 6_024);
});

function sample(
  service: string,
  elapsedMs: number,
  cpuUsageUsec: number,
  memoryCurrentBytes: number,
  memoryPeakBytes: number,
  ioReadBytes: number,
  ioWriteBytes: number,
): ResourceSample {
  return {
    scope: "seal-unseal",
    sampledAt: "2026-08-06T00:00:00.000Z",
    elapsedMs,
    service,
    cpuUsageUsec,
    memoryCurrentBytes,
    memoryPeakBytes,
    ioReadBytes,
    ioWriteBytes,
    error: null,
  };
}
