import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { E2EConfig } from "./config.js";
import {
  scenarioStepSlug,
  writeRunMarkdownSummary,
} from "./report.js";
import type { RunSummary, ScenarioStepResult } from "./report.js";
import { StateStore } from "./state.js";
import { run } from "./shell.js";

export type { RunSummary, ScenarioStepResult } from "./report.js";

export type ScenarioContext = {
  config: E2EConfig;
  scenario: string;
  runId: string;
  runDir: string;
  stateFile: string;
  projectRoot: string;
  scriptsRoot: string;
  state: StateStore;
  startedAt: string;
  startedAtMs: number;
  steps: string[];
  stepResults: ScenarioStepResult[];
};

export function createScenarioContext(
  config: E2EConfig,
  runDir: string,
  runId = runDir.split("/").at(-1) ?? "scenario-run",
  scenario = runId,
): ScenarioContext {
  mkdirSync(runDir, { recursive: true });
  const startedAtMs = Date.now();

  return {
    config,
    scenario,
    runId,
    runDir,
    stateFile: join(runDir, "scenario.state.json"),
    projectRoot: config.projectRoot,
    scriptsRoot: config.projectRoot,
    state: new StateStore(join(runDir, "scenario.state.json")),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    steps: [],
    stepResults: [],
  };
}

export async function runStep<T>(
  context: ScenarioContext,
  name: string,
  action: () => T | Promise<T>
): Promise<T> {
  const index = context.steps.length + 1;
  const label = `${index} ${name}`;
  const started = Date.now();
  context.steps.push(name);
  console.log(`\n== ${label} ==`);

  try {
    const result = await action();
    const elapsedMs = Date.now() - started;
    const artifact = `${String(index).padStart(2, "0")}-${scenarioStepSlug(name)}.json`;
    writeFileSync(
      join(context.runDir, artifact),
      `${JSON.stringify({ name, elapsedMs, result }, stringifyBigInt, 2)}\n`
    );
    context.stepResults.push({ index, name, status: "passed", elapsedMs, artifact });
    console.log(`Completed ${name} in ${elapsedMs}ms`);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const artifact = `${String(index).padStart(2, "0")}-${scenarioStepSlug(name)}.error.json`;
    writeFileSync(
      join(context.runDir, artifact),
      `${JSON.stringify({
        name,
        elapsedMs,
        error: message
      }, null, 2)}\n`
    );
    context.stepResults.push({
      index,
      name,
      status: "failed",
      elapsedMs,
      artifact,
      error: message,
    });
    throw error;
  }
}

export function writeRunSummary(
  context: ScenarioContext,
  result: "passed" | "failed" = "passed",
  error?: unknown,
): string {
  const summaryPath = join(context.runDir, "summary.json");
  const summaryMarkdownPath = join(context.runDir, "summary.md");
  const completedAtMs = Date.now();
  const summary: RunSummary = {
    startedAt: context.startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - context.startedAtMs),
    result,
    scenario: context.scenario,
    runId: context.runId,
    deploymentId: context.config.deploymentId,
    deploymentRevision: context.config.deploymentRevision,
    deploymentRecordPath: context.config.deploymentRecordPath,
    runDir: context.runDir,
    stateFile: context.stateFile,
    summaryMarkdownPath,
    steps: context.steps,
    stepResults: context.stepResults,
    state: context.state.all(),
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
  writeFileSync(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`
  );
  writeRunMarkdownSummary(summaryPath);
  console.log(`\nRun summary: ${summaryPath}`);
  console.log(`Run report: ${summaryMarkdownPath}`);
  return summaryPath;
}

export function writeFailureDiagnostics(context: ScenarioContext): string {
  const path = join(context.runDir, "failure-diagnostics.log");
  const result = run("docker", [
    "compose",
    "--env-file",
    join(context.projectRoot, ".runtime/devnet/compose.env"),
    "--project-name",
    "porep-market-curio-devnet",
    "--file",
    join(context.projectRoot, "docker/compose.curio-devnet.yaml"),
    "logs",
    "--tail",
    "200",
    "curio",
    "lotus",
    "yugabyte",
  ], context.projectRoot);
  const output = `${result.stdout}\n${result.stderr}`.slice(-512_000);
  writeFileSync(path, output);
  context.state.set("FAILURE_DIAGNOSTICS", path);
  return path;
}

export function envValue(context: ScenarioContext, key: string, fallback = ""): string {
  return context.config.env[key] ?? process.env[key] ?? fallback;
}

export function envBigInt(context: ScenarioContext, key: string, fallback: bigint): bigint {
  const value = envValue(context, key);
  return value ? BigInt(value) : fallback;
}

export function envNumber(context: ScenarioContext, key: string, fallback: number): number {
  const value = envValue(context, key);
  return value ? Number(value) : fallback;
}

export function defaultDepositAmountHuman(context: ScenarioContext): string {
  const override = envValue(context, "V2_DEPOSIT_AMOUNT");
  if (override) return override;

  const pricePerMonth = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const withMargin = (pricePerMonth * 110n + 99n) / 100n;
  return ((withMargin + 999_999n) / 1_000_000n).toString();
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
