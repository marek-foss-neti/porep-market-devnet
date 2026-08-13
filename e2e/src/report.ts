import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export type ScenarioStepResult = {
  index: number;
  name: string;
  status: "passed" | "failed";
  elapsedMs: number;
  artifact: string;
  error?: string;
};

export type RunSummary = {
  startedAt?: string;
  completedAt: string;
  durationMs?: number;
  result: "passed" | "failed";
  scenario?: string;
  runId: string;
  deploymentId: string;
  deploymentRevision: number;
  deploymentRecordPath: string;
  runDir: string;
  stateFile: string;
  summaryMarkdownPath?: string;
  steps: string[];
  stepResults?: ScenarioStepResult[];
  state: Record<string, string>;
  error?: string;
};

type ResourceSummaryReport = {
  scope?: string;
  durationMs?: number;
  sampleCount?: number;
  metricsPath?: string;
  summaryPath?: string;
  totals?: {
    cpuTimeMs?: number | null;
    averageCpuCores?: number | null;
    peakObservedMemoryBytes?: number | null;
    cgroupPeakMemoryBytes?: number | null;
    ioReadBytes?: number | null;
    ioWriteBytes?: number | null;
  };
  services?: Array<{
    service?: string;
    sampleCount?: number;
    errorCount?: number;
    cpuTimeMs?: number | null;
    averageCpuCores?: number | null;
    finalMemoryBytes?: number | null;
    peakObservedMemoryBytes?: number | null;
    cgroupPeakMemoryBytes?: number | null;
    ioReadBytes?: number | null;
    ioWriteBytes?: number | null;
  }>;
};

export function scenarioStepSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function writeRunMarkdownSummary(summaryPath: string): string {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
  const reportPath = join(dirname(summaryPath), "summary.md");
  writeFileSync(reportPath, renderRunMarkdownSummary(summary, dirname(summaryPath)));
  return reportPath;
}

export function renderRunMarkdownSummary(summary: RunSummary, artifactDir = summary.runDir): string {
  const steps = resolveStepResults(summary, artifactDir);
  const passedSteps = steps.filter((step) => step.status === "passed").length;
  const failedStep = steps.find((step) => step.status === "failed");
  const passed = summary.result === "passed";
  const startedAt = summary.startedAt ?? inferStartedAt(summary.runId);
  const durationMs = summary.durationMs ?? elapsedBetween(startedAt, summary.completedAt);
  const lines = [
    `# E2E scenario report: \`${escapeInline(scenarioLabel(summary))}\``,
    "",
    `> ${passed ? "✅ **PASSED**" : "❌ **FAILED**"} — ${passed
      ? `all ${passedSteps} recorded steps completed successfully.`
      : failedStep === undefined
        ? "the run failed before a scenario step completed."
        : `step ${failedStep.index} failed: **${escapeMarkdown(failedStep.name)}**.`}`,
    "",
    "## Run details",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Result | ${passed ? "✅ passed" : "❌ failed"} |`,
    `| Run ID | \`${escapeInline(summary.runId)}\` |`,
    `| Started | \`${escapeInline(startedAt ?? "not recorded")}\` |`,
    `| Completed | \`${escapeInline(summary.completedAt)}\` |`,
    `| Duration | ${formatDuration(durationMs)} |`,
    `| Deployment | \`${escapeInline(summary.deploymentId)}\` revision \`${summary.deploymentRevision}\` |`,
    "",
  ];

  if (isSealUnsealSummary(summary)) {
    lines.push(...renderSealUnsealChecks(summary, steps));
  }

  if (isRetrievalBenchmarkSummary(summary)) {
    lines.push(...renderRetrievalBenchmark(summary));
  }

  if (isBenchmarkSummary(summary)) {
    lines.push(...renderBenchmarkEnvironment(summary));
    lines.push(...renderBenchmarkResources(summary));
  }

  lines.push(
    "## Steps",
    "",
    "| # | Status | Step | Duration | Evidence |",
    "| ---: | --- | --- | ---: | --- |",
  );
  if (steps.length === 0) {
    lines.push("| — | — | No scenario steps were recorded | — | — |");
  } else {
    for (const step of steps) {
      lines.push(
        `| ${step.index} | ${step.status === "passed" ? "✅ passed" : "❌ failed"} | ${escapeMarkdown(step.name)} | ${formatDuration(step.elapsedMs)} | [JSON](./${encodePath(step.artifact)}) |`,
      );
    }
  }
  lines.push("");

  if (!passed) {
    lines.push("## Failure", "");
    if (failedStep !== undefined) {
      lines.push(
        `Failed step: **${escapeMarkdown(failedStep.name)}** (${formatDuration(failedStep.elapsedMs)}).`,
        "",
      );
    }
    const failureMessage = summary.error ?? failedStep?.error ?? "No error message was captured.";
    lines.push("Error message:", "", ...indentCode(failureMessage), "");
    const diagnostics = summary.state.FAILURE_DIAGNOSTICS;
    if (diagnostics !== undefined) {
      lines.push(`Diagnostics: ${reportPathLink(diagnostics, summary.runDir)}`, "");
    }
  }

  const stateEntries = Object.entries(summary.state).sort(([left], [right]) => left.localeCompare(right));
  lines.push(
    "## Recorded state",
    "",
    "The complete values remain available in [`summary.json`](./summary.json).",
    "",
  );
  if (stateEntries.length === 0) {
    lines.push("No scenario state was recorded.", "");
  } else {
    lines.push("<details>", "<summary>Show recorded state</summary>", "", "| Key | Value |", "| --- | --- |");
    for (const [key, value] of stateEntries) {
      lines.push(`| \`${escapeInline(key)}\` | \`${escapeInline(truncate(value, 240))}\` |`);
    }
    lines.push("", "</details>", "");
  }

  return `${lines.join("\n")}\n`;
}

function resolveStepResults(summary: RunSummary, artifactDir: string): ScenarioStepResult[] {
  if (Array.isArray(summary.stepResults) && summary.stepResults.length > 0) {
    return summary.stepResults;
  }

  const names = Array.isArray(summary.steps) ? summary.steps : [];
  return names.map((name, offset) => {
    const index = offset + 1;
    const prefix = `${String(index).padStart(2, "0")}-${scenarioStepSlug(name)}`;
    const passedArtifact = `${prefix}.json`;
    const failedArtifact = `${prefix}.error.json`;
    const failed = existsSync(join(artifactDir, failedArtifact));
    const artifact = failed ? failedArtifact : passedArtifact;
    const artifactPath = join(artifactDir, artifact);
    let elapsedMs = 0;
    let error: string | undefined;

    if (existsSync(artifactPath)) {
      try {
        const payload = JSON.parse(readFileSync(artifactPath, "utf8")) as {
          elapsedMs?: unknown;
          error?: unknown;
        };
        if (typeof payload.elapsedMs === "number") elapsedMs = payload.elapsedMs;
        if (typeof payload.error === "string") error = payload.error;
      } catch {
        // Keep the report usable even if a historical step artifact is malformed.
      }
    }

    return {
      index,
      name,
      status: failed ? "failed" : "passed",
      elapsedMs,
      artifact: existsSync(artifactPath) ? artifact : "summary.json",
      ...(error === undefined ? {} : { error }),
    };
  });
}

function renderSealUnsealChecks(
  summary: RunSummary,
  steps: ScenarioStepResult[],
): string[] {
  const committed = steps.find((step) =>
    /ProveCommit on-chain without waiting for WindowPoSt|verify resumed sector and source are unchanged/i.test(step.name));
  const commd = steps.find((step) => /verify unsealed CommD/i.test(step.name));
  const recovered = steps.find((step) => /recover exact piece bytes/i.test(step.name));
  const sectorRecovered = steps.find((step) => /forced sector retrieval after cold unseal/i.test(step.name));
  const unchanged = steps.find((step) => /sealed replica and on-chain sector remain unchanged/i.test(step.name));
  const sourceHash = summary.state.SOURCE_SHA256;
  const recoveredHash = summary.state.RECOVERED_SHA256;
  const hashesPresent = sourceHash !== undefined && recoveredHash !== undefined;
  const hashesMatch = hashesPresent && sourceHash === recoveredHash;

  return [
    "## Seal/unseal verdict",
    "",
    "| Check | Result | Evidence |",
    "| --- | --- | --- |",
    proofBackendRow(summary),
    checkRow(
      "Sector committed on-chain",
      committed,
      summary.state.SECTOR_NUMBER === undefined
        ? "StateSectorGetInfo check"
        : `sector \`${escapeInline(summary.state.SECTOR_NUMBER)}\``,
    ),
    committed === undefined
      ? "| WindowPoSt wait | — not recorded | This run predates the explicit skip check |"
      : "| WindowPoSt wait | ⏭ skipped by design | Unseal starts after ProveCommit; sector activation is not a test gate |",
    checkRow("Unsealed CommD verified", commd, summary.state.UNSEALED_CID === undefined
      ? "Curio CommD check"
      : `\`${escapeInline(summary.state.UNSEALED_CID)}\``),
    checkRow("Exact piece bytes recovered", recovered ?? sectorRecovered, summary.state.RECOVERED_CAR === undefined
      ? summary.state.RETRIEVAL_SECTOR_COLD_OUTPUT === undefined
        ? "FR32 extraction"
        : reportPathLink(summary.state.RETRIEVAL_SECTOR_COLD_OUTPUT, summary.runDir)
      : reportPathLink(summary.state.RECOVERED_CAR, summary.runDir)),
    `| Source/recovered SHA-256 | ${!hashesPresent ? "— not reached" : hashesMatch ? "✅ passed" : "❌ failed"} | ${!hashesPresent
      ? "Both hashes were not recorded"
      : `source \`${escapeInline(sourceHash)}\`<br>recovered \`${escapeInline(recoveredHash)}\``} |`,
    checkRow("Sealed replica unchanged", unchanged, summary.state.SEALED_SHA256 === undefined
      ? "Final sealed-file hash check"
      : `\`${escapeInline(summary.state.SEALED_SHA256)}\``),
    "",
  ];
}

function proofBackendRow(summary: RunSummary): string {
  const backend = summary.state.PROOF_BACKEND;
  const result = backend === "zigzag"
    ? "✅ ZigZag"
    : backend === "sdr"
      ? "✅ SDR"
      : "— not recorded";
  const proof = summary.state.REGISTERED_SEAL_PROOF;
  const proofName = summary.state.REGISTERED_SEAL_PROOF_NAME;
  const sectorSize = formatRecordedBytes(summary.state.REGISTERED_SEAL_PROOF_SECTOR_SIZE_BYTES);
  const evidence = [
    proofName === undefined && proof === undefined
      ? undefined
      : `registered proof \`${escapeInline(proofName ?? "unknown")}\`${proof === undefined ? "" : ` (${escapeInline(proof)})`}`,
    sectorSize === undefined ? undefined : `sector size \`${sectorSize}\``,
    summary.state.PROOF_BACKEND_REASON,
    summary.state.UNSEAL_PATH === undefined ? undefined : `unseal path: ${summary.state.UNSEAL_PATH}`,
  ].filter((value): value is string => value !== undefined && value.length > 0)
    .map(escapeMarkdown)
    .join("<br>");

  return `| Proof backend | ${result} | ${evidence || "not recorded"} |`;
}

function checkRow(label: string, step: ScenarioStepResult | undefined, evidence: string): string {
  const status = step === undefined
    ? "— not reached"
    : step.status === "passed"
      ? "✅ passed"
      : "❌ failed";
  return `| ${escapeMarkdown(label)} | ${status} | ${evidence} |`;
}

function isSealUnsealSummary(summary: RunSummary): boolean {
  return summary.scenario === "seal-unseal-roundtrip"
    || summary.scenario === "bench-seal-unseal"
    || summary.scenario === "deliver-seal-unseal-retrieval"
    || summary.scenario === "bench-deliver-seal-unseal-retrieval"
    || summary.runId.endsWith("-seal-unseal-roundtrip");
}

function isBenchmarkSummary(summary: RunSummary): boolean {
  return summary.scenario === "bench-seal-unseal"
    || summary.scenario === "bench-retrieval"
    || summary.state.BENCHMARK_KIND !== undefined
    || Object.keys(summary.state).some((key) => key.endsWith("_RESOURCE_SUMMARY"));
}

function isRetrievalBenchmarkSummary(summary: RunSummary): boolean {
  return summary.scenario === "bench-retrieval"
    || summary.scenario === "bench-deliver-seal-unseal-retrieval"
    || summary.state.BENCHMARK_KIND === "retrieval";
}

function renderRetrievalBenchmark(summary: RunSummary): string[] {
  if (summary.state.BENCHMARK_KIND === "deliver-seal-unseal-retrieval") {
    return renderDeliverRetrievalBenchmark(summary);
  }
  const modes = ["cold", "hot"] as const;
  const rows = modes
    .map((mode) => retrievalRow(summary, mode))
    .filter((row): row is string => row !== undefined);
  if (rows.length === 0) return [];

  const lines = [
    "## Retrieval benchmark",
    "",
    summary.state.RETRIEVAL_BENCH_SCOPE
      ? escapeMarkdown(summary.state.RETRIEVAL_BENCH_SCOPE)
      : "Curio HTTP retrieval via `/piece/{cid}`.",
    "",
  ];
  if (summary.state.RETRIEVAL_BENCH_CAVEAT !== undefined) {
    lines.push(`Note: ${escapeMarkdown(summary.state.RETRIEVAL_BENCH_CAVEAT)}`, "");
  }
  if (summary.state.RETRIEVAL_BENCH_SOURCE_NOTE !== undefined) {
    lines.push(`Source note: ${escapeMarkdown(summary.state.RETRIEVAL_BENCH_SOURCE_NOTE)}`, "");
  }
  lines.push(
    "| Mode | Initial storage | Final storage | Result | Bytes | TTFB | Total | Throughput | SHA-256 | Artifact |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows,
    "",
  );
  return lines;
}

function renderDeliverRetrievalBenchmark(summary: RunSummary): string[] {
  const rows = [
    retrievalPathRow(summary, "HTTP cold", "RETRIEVAL_HTTP_COLD", true),
    retrievalPathRow(summary, "HTTP hot", "RETRIEVAL_HTTP_HOT", true),
    retrievalPathRow(summary, "Sector cold", "RETRIEVAL_SECTOR_COLD", false),
    retrievalPathRow(summary, "Sector hot", "RETRIEVAL_SECTOR_HOT", false),
  ].filter((row): row is string => row !== undefined);
  if (rows.length === 0) return [];

  const lines = [
    "## Retrieval benchmark",
    "",
    summary.state.DELIVER_RETRIEVAL_BENCH_SCOPE
      ? escapeMarkdown(summary.state.DELIVER_RETRIEVAL_BENCH_SCOPE)
      : "Deliver/seal/unseal/retrieval benchmark.",
    "",
  ];
  if (summary.state.RETRIEVAL_BENCH_SOURCE_NOTE !== undefined) {
    lines.push(`Source note: ${escapeMarkdown(summary.state.RETRIEVAL_BENCH_SOURCE_NOTE)}`, "");
  }
  if (summary.state.RETRIEVAL_CACHE_ISOLATION !== undefined) {
    lines.push(`Cache isolation: ${escapeMarkdown(summary.state.RETRIEVAL_CACHE_ISOLATION)}`, "");
  }
  lines.push(
    "| Path | Initial storage | Final storage | Result | Bytes | TTFB | Total | Throughput | SHA-256 | Artifact |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows,
    "",
  );
  return lines;
}

function retrievalPathRow(
  summary: RunSummary,
  label: string,
  prefix: string,
  http: boolean,
): string | undefined {
  const bytes = numberFromState(summary, `${prefix}_BYTES`);
  const ttfbMs = http ? numberFromState(summary, `${prefix}_TTFB_MS`) : undefined;
  const totalMs = http ? numberFromState(summary, `${prefix}_TOTAL_MS`) : undefined;
  const throughput = http ? numberFromState(summary, `${prefix}_THROUGHPUT_BYTES_PER_SECOND`) : undefined;
  const sha256 = summary.state[`${prefix}_SHA256`];
  const sha256Match = summary.state[`${prefix}_SHA256_MATCH`];
  const output = summary.state[`${prefix}_OUTPUT`];
  if (bytes === undefined && sha256 === undefined) return undefined;
  const status = http ? summary.state[`${prefix}_HTTP_STATUS`] : undefined;
  const result = sha256Match === "true"
    ? http ? `✅ HTTP ${escapeInline(status ?? "unknown")}, hash match` : "✅ sector bytes, hash match"
    : sha256Match === "false"
      ? "❌ hash mismatch"
      : "— not reached";
  const digest = sha256 === undefined
    ? "not recorded"
    : sha256Match === "true"
      ? `match \`${shortDigest(sha256)}\``
      : `\`${shortDigest(sha256)}\``;
  return [
    label,
    escapeMarkdown(summary.state[`${prefix}_STORAGE_BEFORE`] ?? "not recorded"),
    escapeMarkdown(summary.state[`${prefix}_STORAGE_AFTER`] ?? "not recorded"),
    result,
    formatBytesHuman(bytes),
    formatDuration(ttfbMs),
    formatDuration(totalMs),
    formatThroughput(throughput),
    digest,
    output === undefined ? "not recorded" : reportPathLink(output, summary.runDir),
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function retrievalRow(summary: RunSummary, mode: "cold" | "hot"): string | undefined {
  const prefix = `RETRIEVAL_${mode.toUpperCase()}`;
  const status = summary.state[`${prefix}_HTTP_STATUS`];
  const bytes = numberFromState(summary, `${prefix}_BYTES`);
  const ttfbMs = numberFromState(summary, `${prefix}_TTFB_MS`);
  const totalMs = numberFromState(summary, `${prefix}_TOTAL_MS`);
  const throughput = numberFromState(summary, `${prefix}_THROUGHPUT_BYTES_PER_SECOND`);
  const sha256 = summary.state[`${prefix}_SHA256`];
  const sha256Match = summary.state[`${prefix}_SHA256_MATCH`];
  const output = summary.state[`${prefix}_OUTPUT`];
  if (status === undefined && bytes === undefined && sha256 === undefined) return undefined;

  const result = status === "200" && sha256Match === "true"
    ? "✅ HTTP 200, hash match"
    : status === undefined
      ? "— not reached"
      : `❌ HTTP ${escapeInline(status)}${sha256Match === "false" ? ", hash mismatch" : ""}`;
  const digest = sha256 === undefined
    ? "not recorded"
    : sha256Match === "true"
      ? `match \`${shortDigest(sha256)}\``
      : `\`${shortDigest(sha256)}\``;

  return [
    mode,
    escapeMarkdown(summary.state[`${prefix}_STORAGE_BEFORE`] ?? "not recorded"),
    escapeMarkdown(summary.state[`${prefix}_STORAGE_AFTER`] ?? "not recorded"),
    result,
    formatBytesHuman(bytes),
    formatDuration(ttfbMs),
    formatDuration(totalMs),
    formatThroughput(throughput),
    digest,
    output === undefined ? "not recorded" : reportPathLink(output, summary.runDir),
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function renderBenchmarkResources(summary: RunSummary): string[] {
  const resources = Object.entries(summary.state)
    .filter(([key]) => key.endsWith("_RESOURCE_SUMMARY"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stateKey, path]) => ({
      stateKey,
      path,
      summary: readResourceSummary(path),
    }));
  if (resources.length === 0) return [];

  const lines = [
    "## Resource metrics",
    "",
    "Resource samples are read from container cgroup files. Peak sampled memory is the maximum observed `memory.current`; cgroup peak is the container-lifetime peak reported by the runtime.",
    "",
    "| Scope | Duration | CPU time | Avg CPU cores | Peak sampled memory | IO read | IO write | Samples | Files |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const resource of resources) {
    const report = resource.summary;
    if (report === undefined) {
      lines.push(
        `| ${escapeMarkdown(resourceScopeFromKey(resource.stateKey))} | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | ${reportPathLink(resource.path, summary.runDir)} |`,
      );
      continue;
    }
    const files = [
      report.summaryPath ?? resource.path,
      report.metricsPath,
    ].filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((path) => reportPathLink(path, summary.runDir))
      .join("<br>");
    lines.push([
      report.scope ?? resourceScopeFromKey(resource.stateKey),
      formatDuration(report.durationMs),
      formatDuration(nullableNumber(report.totals?.cpuTimeMs)),
      formatCores(nullableNumber(report.totals?.averageCpuCores)),
      formatBytesHuman(nullableNumber(report.totals?.peakObservedMemoryBytes)),
      formatBytesHuman(nullableNumber(report.totals?.ioReadBytes)),
      formatBytesHuman(nullableNumber(report.totals?.ioWriteBytes)),
      report.sampleCount?.toString() ?? "not recorded",
      files || reportPathLink(resource.path, summary.runDir),
    ].map((value) => escapeMarkdown(value)).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");

  for (const resource of resources) {
    if (resource.summary === undefined || resource.summary.services === undefined) continue;
    lines.push(
      "<details>",
      `<summary>Service metrics: ${escapeMarkdown(resource.summary.scope ?? resourceScopeFromKey(resource.stateKey))}</summary>`,
      "",
      "| Service | CPU time | Avg CPU cores | Peak sampled memory | Cgroup peak | IO read | IO write | Samples | Errors |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const service of resource.summary.services) {
      lines.push([
        service.service ?? "unknown",
        formatDuration(nullableNumber(service.cpuTimeMs)),
        formatCores(nullableNumber(service.averageCpuCores)),
        formatBytesHuman(nullableNumber(service.peakObservedMemoryBytes)),
        formatBytesHuman(nullableNumber(service.cgroupPeakMemoryBytes)),
        formatBytesHuman(nullableNumber(service.ioReadBytes)),
        formatBytesHuman(nullableNumber(service.ioWriteBytes)),
        service.sampleCount?.toString() ?? "not recorded",
        service.errorCount?.toString() ?? "not recorded",
      ].map((value) => escapeMarkdown(value)).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    lines.push("", "</details>", "");
  }

  return lines;
}

function renderBenchmarkEnvironment(summary: RunSummary): string[] {
  const rows = [
    environmentRow("Proof backend selector", summary.state.DEVNET_PROOF_BACKEND),
    environmentRow("Sector size selector", sectorSelectorLabel(summary)),
    environmentRow("Runtime proof path", summary.state.PROOF_BACKEND),
    environmentRow("Proof parameter cache", proofParameterCacheLabel(summary)),
    environmentRow("ZigZag sidecars", zigzagSidecarLabel(summary)),
    environmentRow("Curio source commit", shortCommit(summary.state.DEVNET_CURIO_COMMIT ?? summary.state.STATUS_CURIO_COMMIT)),
    environmentRow("Lotus source commit", shortCommit(summary.state.DEVNET_LOTUS_COMMIT ?? summary.state.STATUS_LOTUS_COMMIT)),
    environmentRow("Build platform", summary.state.DEVNET_IMAGE_PLATFORM ?? summary.state.STATUS_IMAGE_PLATFORM),
    environmentRow("Curio image", imageLabel(summary, "IMAGE_CURIO")),
    environmentRow("Lotus image", imageLabel(summary, "IMAGE_LOTUS")),
    environmentRow("Docker", dockerLabel(summary)),
  ].filter((row): row is string => row !== undefined);
  if (rows.length === 0) return [];

  return [
    "## Benchmark environment",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows,
    "",
  ];
}

function sectorSelectorLabel(summary: RunSummary): string | undefined {
  const selector = summary.state.DEVNET_SECTOR_SIZE ?? summary.state.STATUS_SECTOR_SIZE;
  const bytes = formatRecordedBytes(
    summary.state.DEVNET_SECTOR_SIZE_BYTES ?? summary.state.STATUS_SECTOR_SIZE_BYTES,
  );
  if (selector === undefined && bytes === undefined) return undefined;
  return [selector, bytes].filter((value) => value !== undefined).join(" / ");
}

function environmentRow(label: string, value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return `| ${escapeMarkdown(label)} | ${escapeMarkdown(value)} |`;
}

function proofParameterCacheLabel(summary: RunSummary): string | undefined {
  const status = summary.state.PROOF_PARAMETER_CACHE_STATUS;
  if (status === undefined) return undefined;
  const files = numberFromState(summary, "PROOF_PARAMETER_CACHE_FILE_COUNT");
  const bytes = numberFromState(summary, "PROOF_PARAMETER_CACHE_BYTES");
  return [
    status,
    files === undefined ? undefined : `${files} files`,
    bytes === undefined ? undefined : formatBytesHuman(bytes),
  ].filter((value): value is string => value !== undefined).join(", ");
}

function zigzagSidecarLabel(summary: RunSummary): string | undefined {
  const directory = summary.state.ZIGZAG_SIDECAR_DIR;
  const files = numberFromState(summary, "ZIGZAG_SIDECAR_FILE_COUNT");
  const bytes = numberFromState(summary, "ZIGZAG_SIDECAR_BYTES");
  if (directory === undefined && files === undefined && bytes === undefined) return undefined;
  return [
    directory,
    files === undefined ? undefined : `${files} files`,
    bytes === undefined ? undefined : formatBytesHuman(bytes),
  ].filter((value): value is string => value !== undefined).join(", ");
}

function imageLabel(summary: RunSummary, prefix: string): string | undefined {
  const reference = summary.state[`${prefix}_REFERENCE`];
  const id = summary.state[`${prefix}_ID`];
  if (reference === undefined && id === undefined) return undefined;
  return [
    reference === undefined ? undefined : `\`${escapeInline(reference)}\``,
    id === undefined ? undefined : `\`${shortDigest(id)}\``,
  ].filter((value): value is string => value !== undefined).join("<br>");
}

function dockerLabel(summary: RunSummary): string | undefined {
  const version = summary.state.DOCKER_SERVER_VERSION;
  const cpus = summary.state.DOCKER_CPU_COUNT;
  const memory = formatBytesHuman(numberFromState(summary, "DOCKER_TOTAL_MEMORY_BYTES"));
  const parts = [
    version === undefined ? undefined : `version ${version}`,
    cpus === undefined ? undefined : `${cpus} CPUs`,
    memory === "not recorded" ? undefined : memory,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

function scenarioLabel(summary: RunSummary): string {
  if (summary.scenario !== undefined) return summary.scenario;
  if (summary.runId.endsWith("-seal-unseal-roundtrip")) return "seal-unseal-roundtrip";
  return summary.runId;
}

function inferStartedAt(runId: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(runId);
  if (match === null) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

function elapsedBetween(startedAt: string | undefined, completedAt: string): number | undefined {
  if (startedAt === undefined) return undefined;
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return undefined;
  }
  return completedMs - startedMs;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "not recorded";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
  const totalSeconds = Math.floor(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${seconds}s`;
}

function formatRecordedBytes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return value;
  if (bytes === 2 * 1024) return "2 KiB";
  if (bytes === 8 * 1024 * 1024) return "8 MiB";
  if (bytes === 512 * 1024 * 1024) return "512 MiB";
  if (bytes === 32 * 1024 * 1024 * 1024) return "32 GiB";
  if (bytes === 64 * 1024 * 1024 * 1024) return "64 GiB";
  return `${bytes} bytes`;
}

function readResourceSummary(path: string): ResourceSummaryReport | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ResourceSummaryReport;
  } catch {
    return undefined;
  }
}

function numberFromState(summary: RunSummary, key: string): number | undefined {
  const value = summary.state[key];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nullableNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatBytesHuman(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "not recorded";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = value / 1024;
  for (const unit of units) {
    if (scaled < 1024) return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${unit}`;
    scaled /= 1024;
  }
  return `${scaled.toFixed(1)} PiB`;
}

function formatThroughput(value: number | undefined): string {
  return value === undefined ? "not recorded" : `${formatBytesHuman(value)}/s`;
}

function formatCores(value: number | undefined): string {
  if (value === undefined) return "not recorded";
  return value.toFixed(value < 1 ? 3 : 2).replace(/\.?0+$/, "");
}

function shortDigest(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}...`;
}

function shortCommit(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `\`${escapeInline(value.slice(0, 12))}\``;
}

function resourceScopeFromKey(key: string): string {
  return key.replace(/_RESOURCE_SUMMARY$/, "").toLowerCase().replace(/_/g, "-");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeInline(value: string): string {
  return escapeMarkdown(value).replace(/`/g, "'");
}

function indentCode(value: string): string[] {
  const lines = value.split(/\r?\n/);
  return (lines.length === 0 ? [""] : lines).map((line) => `    ${line}`);
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

function encodePath(value: string): string {
  return value.split(/[\\/]/).map(encodeURIComponent).join("/");
}

function reportPathLink(path: string, runDir: string): string {
  const relativePath = relative(runDir, path);
  if (
    relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  ) {
    return `[\`${escapeInline(relativePath)}\`](./${encodePath(relativePath)})`;
  }
  return `\`${escapeInline(path)}\``;
}
