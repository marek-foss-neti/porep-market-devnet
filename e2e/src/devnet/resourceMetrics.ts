import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { envNumber, envValue } from "../runtime.js";
import { run } from "../shell.js";
import { containerName } from "./docker.js";

const DEFAULT_RESOURCE_SERVICES = ["curio", "lotus", "lotus-miner", "yugabyte", "piece-server"];
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

const CGROUP_METRICS_SCRIPT = String.raw`
cpu_usage_usec=0
if [ -f /sys/fs/cgroup/cpu.stat ]; then
  cpu_usage_usec="$(awk '/^usage_usec /{print $2}' /sys/fs/cgroup/cpu.stat 2>/dev/null || printf 0)"
elif [ -f /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then
  cpu_usage_nsec="$(cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null || printf 0)"
  cpu_usage_usec="$((cpu_usage_nsec / 1000))"
fi

memory_current_bytes=0
if [ -f /sys/fs/cgroup/memory.current ]; then
  memory_current_bytes="$(cat /sys/fs/cgroup/memory.current 2>/dev/null || printf 0)"
elif [ -f /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
  memory_current_bytes="$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || printf 0)"
fi

memory_peak_bytes="$memory_current_bytes"
if [ -f /sys/fs/cgroup/memory.peak ]; then
  memory_peak_bytes="$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || printf "$memory_current_bytes")"
elif [ -f /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
  memory_peak_bytes="$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || printf "$memory_current_bytes")"
fi

io_read_bytes=0
io_write_bytes=0
if [ -f /sys/fs/cgroup/io.stat ]; then
  set -- $(awk '{
    for (i = 2; i <= NF; i++) {
      split($i, pair, "=")
      if (pair[1] == "rbytes") read += pair[2]
      if (pair[1] == "wbytes") written += pair[2]
    }
  } END { printf "%s %s", read + 0, written + 0 }' /sys/fs/cgroup/io.stat 2>/dev/null || printf "0 0")
  io_read_bytes="$1"
  io_write_bytes="$2"
  if [ -z "$io_read_bytes" ]; then io_read_bytes=0; fi
  if [ -z "$io_write_bytes" ]; then io_write_bytes=0; fi
fi

printf 'cpu_usage_usec=%s\n' "$cpu_usage_usec"
printf 'memory_current_bytes=%s\n' "$memory_current_bytes"
printf 'memory_peak_bytes=%s\n' "$memory_peak_bytes"
printf 'io_read_bytes=%s\n' "$io_read_bytes"
printf 'io_write_bytes=%s\n' "$io_write_bytes"
`;

export type CgroupMetrics = {
  cpuUsageUsec: number | null;
  memoryCurrentBytes: number | null;
  memoryPeakBytes: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
};

export type ResourceSample = CgroupMetrics & {
  scope: string;
  sampledAt: string;
  elapsedMs: number;
  service: string;
  error: string | null;
};

export type ServiceResourceSummary = {
  service: string;
  sampleCount: number;
  errorCount: number;
  durationMs: number;
  cpuTimeMs: number | null;
  averageCpuCores: number | null;
  initialMemoryBytes: number | null;
  finalMemoryBytes: number | null;
  peakObservedMemoryBytes: number | null;
  cgroupPeakMemoryBytes: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
};

export type ResourceSummary = {
  scope: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sampleIntervalMs: number;
  sampleCount: number;
  metricsPath: string;
  summaryPath: string;
  services: ServiceResourceSummary[];
  totals: {
    cpuTimeMs: number | null;
    averageCpuCores: number | null;
    peakObservedMemoryBytes: number | null;
    cgroupPeakMemoryBytes: number | null;
    ioReadBytes: number | null;
    ioWriteBytes: number | null;
  };
};

export class ResourceMonitor {
  private readonly startedAtMs = Date.now();
  private readonly startedAt = new Date(this.startedAtMs).toISOString();
  private readonly samples: ResourceSample[] = [];
  private readonly metricsPath: string;
  private readonly summaryPath: string;
  private interval: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly context: ScenarioContext,
    private readonly scope: string,
    private readonly services: string[],
    private readonly sampleIntervalMs: number,
  ) {
    const safeScope = scenarioFileSlug(scope);
    this.metricsPath = join(context.runDir, `${safeScope}.resource-metrics.ndjson`);
    this.summaryPath = join(context.runDir, `${safeScope}.resource-summary.json`);
  }

  start(): this {
    this.sampleAll();
    this.interval = setInterval(() => this.sampleAll(), this.sampleIntervalMs);
    return this;
  }

  stop(): ResourceSummary {
    if (this.stopped) {
      throw new Error(`resource monitor already stopped: ${this.scope}`);
    }
    this.stopped = true;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.sampleAll();
    const completedAtMs = Date.now();
    const summary = summarizeResourceSamples(
      this.scope,
      this.startedAt,
      new Date(completedAtMs).toISOString(),
      Math.max(0, completedAtMs - this.startedAtMs),
      this.sampleIntervalMs,
      this.metricsPath,
      this.summaryPath,
      this.services,
      this.samples,
    );
    writeFileSync(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  private sampleAll(): void {
    const sampledAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    for (const service of this.services) {
      const sample = readServiceSample(this.context, this.scope, service, sampledAt, elapsedMs);
      this.samples.push(sample);
      appendFileSync(this.metricsPath, `${JSON.stringify(sample)}\n`);
    }
  }
}

export function startResourceMonitor(context: ScenarioContext, scope: string): ResourceMonitor {
  const services = parseResourceServices(
    envValue(context, "BENCH_RESOURCE_SERVICES", DEFAULT_RESOURCE_SERVICES.join(",")),
  );
  const sampleIntervalMs = normalizeSampleInterval(
    envNumber(context, "BENCH_RESOURCE_SAMPLE_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS),
  );
  return new ResourceMonitor(context, scope, services, sampleIntervalMs).start();
}

export async function withResourceMonitor<T>(
  context: ScenarioContext,
  scope: string,
  statePrefix: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const monitor = startResourceMonitor(context, scope);
  try {
    return await action();
  } finally {
    const summary = monitor.stop();
    recordResourceSummaryState(context, statePrefix, summary);
  }
}

export function recordResourceSummaryState(
  context: ScenarioContext,
  statePrefix: string,
  summary: ResourceSummary,
): void {
  const prefix = stateKeyPrefix(statePrefix);
  context.state.set(`${prefix}_RESOURCE_SUMMARY`, summary.summaryPath);
  context.state.set(`${prefix}_RESOURCE_METRICS`, summary.metricsPath);
  context.state.set(`${prefix}_RESOURCE_DURATION_MS`, summary.durationMs);
  context.state.set(`${prefix}_RESOURCE_SAMPLE_COUNT`, summary.sampleCount);
  setOptionalMetric(context, `${prefix}_CPU_TIME_MS`, summary.totals.cpuTimeMs);
  setOptionalMetric(context, `${prefix}_AVG_CPU_CORES`, summary.totals.averageCpuCores);
  setOptionalMetric(context, `${prefix}_PEAK_MEMORY_BYTES`, summary.totals.peakObservedMemoryBytes);
  setOptionalMetric(context, `${prefix}_CGROUP_PEAK_MEMORY_BYTES`, summary.totals.cgroupPeakMemoryBytes);
  setOptionalMetric(context, `${prefix}_IO_READ_BYTES`, summary.totals.ioReadBytes);
  setOptionalMetric(context, `${prefix}_IO_WRITE_BYTES`, summary.totals.ioWriteBytes);
}

export function parseCgroupMetricsOutput(output: string): CgroupMetrics {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z_]+)=([0-9]+)\s*$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return {
    cpuUsageUsec: parseMetric(values.get("cpu_usage_usec")),
    memoryCurrentBytes: parseMetric(values.get("memory_current_bytes")),
    memoryPeakBytes: parseMetric(values.get("memory_peak_bytes")),
    ioReadBytes: parseMetric(values.get("io_read_bytes")),
    ioWriteBytes: parseMetric(values.get("io_write_bytes")),
  };
}

export function summarizeResourceSamples(
  scope: string,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  sampleIntervalMs: number,
  metricsPath: string,
  summaryPath: string,
  services: string[],
  samples: ResourceSample[],
): ResourceSummary {
  const serviceSummaries = services.map((service) =>
    summarizeServiceSamples(service, samples.filter((sample) => sample.service === service)));
  const totalCpuTimeMs = sumNullable(serviceSummaries.map((service) => service.cpuTimeMs));
  return {
    scope,
    startedAt,
    completedAt,
    durationMs,
    sampleIntervalMs,
    sampleCount: samples.length,
    metricsPath,
    summaryPath,
    services: serviceSummaries,
    totals: {
      cpuTimeMs: totalCpuTimeMs,
      averageCpuCores: totalCpuTimeMs === null || durationMs <= 0
        ? null
        : totalCpuTimeMs / durationMs,
      peakObservedMemoryBytes: sumNullable(
        serviceSummaries.map((service) => service.peakObservedMemoryBytes),
      ),
      cgroupPeakMemoryBytes: sumNullable(
        serviceSummaries.map((service) => service.cgroupPeakMemoryBytes),
      ),
      ioReadBytes: sumNullable(serviceSummaries.map((service) => service.ioReadBytes)),
      ioWriteBytes: sumNullable(serviceSummaries.map((service) => service.ioWriteBytes)),
    },
  };
}

function readServiceSample(
  context: ScenarioContext,
  scope: string,
  service: string,
  sampledAt: string,
  elapsedMs: number,
): ResourceSample {
  try {
    const result = run(
      "docker",
      ["exec", containerName(service), "sh", "-ec", CGROUP_METRICS_SCRIPT],
      context.projectRoot,
    );
    if (result.status !== 0) {
      return sampleWithError(scope, sampledAt, elapsedMs, service, result.stderr || result.stdout);
    }
    return {
      scope,
      sampledAt,
      elapsedMs,
      service,
      ...parseCgroupMetricsOutput(result.stdout),
      error: null,
    };
  } catch (error) {
    return sampleWithError(
      scope,
      sampledAt,
      elapsedMs,
      service,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function sampleWithError(
  scope: string,
  sampledAt: string,
  elapsedMs: number,
  service: string,
  error: string,
): ResourceSample {
  return {
    scope,
    sampledAt,
    elapsedMs,
    service,
    cpuUsageUsec: null,
    memoryCurrentBytes: null,
    memoryPeakBytes: null,
    ioReadBytes: null,
    ioWriteBytes: null,
    error: error.trim().slice(0, 1_000),
  };
}

function summarizeServiceSamples(service: string, samples: ResourceSample[]): ServiceResourceSummary {
  const validSamples = samples.filter((sample) => sample.error === null);
  const cpuSamples = validSamples.filter((sample) => sample.cpuUsageUsec !== null);
  const ioReadSamples = validSamples.filter((sample) => sample.ioReadBytes !== null);
  const ioWriteSamples = validSamples.filter((sample) => sample.ioWriteBytes !== null);
  const durationMs = validSamples.length < 2
    ? 0
    : Math.max(0, validSamples[validSamples.length - 1]!.elapsedMs - validSamples[0]!.elapsedMs);
  const cpuTimeMs = delta(cpuSamples, (sample) => sample.cpuUsageUsec) === null
    ? null
    : delta(cpuSamples, (sample) => sample.cpuUsageUsec)! / 1_000;

  return {
    service,
    sampleCount: samples.length,
    errorCount: samples.length - validSamples.length,
    durationMs,
    cpuTimeMs,
    averageCpuCores: cpuTimeMs === null || durationMs <= 0 ? null : cpuTimeMs / durationMs,
    initialMemoryBytes: firstMetric(validSamples, (sample) => sample.memoryCurrentBytes),
    finalMemoryBytes: lastMetric(validSamples, (sample) => sample.memoryCurrentBytes),
    peakObservedMemoryBytes: maxMetric(validSamples, (sample) => sample.memoryCurrentBytes),
    cgroupPeakMemoryBytes: maxMetric(validSamples, (sample) => sample.memoryPeakBytes),
    ioReadBytes: delta(ioReadSamples, (sample) => sample.ioReadBytes),
    ioWriteBytes: delta(ioWriteSamples, (sample) => sample.ioWriteBytes),
  };
}

function parseResourceServices(value: string): string[] {
  const services = value.split(",").map((service) => service.trim()).filter(Boolean);
  return services.length > 0 ? services : [...DEFAULT_RESOURCE_SERVICES];
}

function normalizeSampleInterval(value: number): number {
  if (!Number.isFinite(value) || value < 250) return DEFAULT_SAMPLE_INTERVAL_MS;
  return Math.round(value);
}

function stateKeyPrefix(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function scenarioFileSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function setOptionalMetric(context: ScenarioContext, key: string, value: number | null): void {
  if (value !== null && Number.isFinite(value)) context.state.set(key, formatNumber(value));
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function parseMetric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstMetric<T>(samples: T[], value: (sample: T) => number | null): number | null {
  for (const sample of samples) {
    const current = value(sample);
    if (current !== null) return current;
  }
  return null;
}

function lastMetric<T>(samples: T[], value: (sample: T) => number | null): number | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const current = value(samples[index]!);
    if (current !== null) return current;
  }
  return null;
}

function maxMetric<T>(samples: T[], value: (sample: T) => number | null): number | null {
  let maximum: number | null = null;
  for (const sample of samples) {
    const current = value(sample);
    if (current !== null && (maximum === null || current > maximum)) maximum = current;
  }
  return maximum;
}

function delta<T>(samples: T[], value: (sample: T) => number | null): number | null {
  const first = firstMetric(samples, value);
  const last = lastMetric(samples, value);
  if (first === null || last === null) return null;
  return Math.max(0, last - first);
}

function sumNullable(values: Array<number | null>): number | null {
  let total = 0;
  let observed = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    observed = true;
  }
  return observed ? total : null;
}
