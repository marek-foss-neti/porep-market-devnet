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
    checkRow("Exact piece bytes recovered", recovered, summary.state.RECOVERED_CAR === undefined
      ? "FR32 extraction"
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
    || summary.runId.endsWith("-seal-unseal-roundtrip");
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
