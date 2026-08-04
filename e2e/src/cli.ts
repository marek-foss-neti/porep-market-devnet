import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  assertPreflightFacts,
  buildPreflightSummary,
  collectPreflightFacts,
} from "./preflight.js";
import {
  createScenarioContext,
  type ScenarioContext,
  writeFailureDiagnostics,
  writeRunSummary,
} from "./runtime.js";
import {
  assertScenarioPrerequisites,
  consumeScenarioFixtures,
  resolveScenario,
} from "./scenarios/registry.js";

const scenario = process.argv[2] ?? "preflight";
let context: ScenarioContext | undefined;
let failure: unknown;

try {
  const config = loadConfig({ cwd: process.cwd() });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario}`;
  const runDir = process.env.SCENARIO_RUN_DIR === undefined
    ? join(config.runRoot, runId)
    : resolve(process.env.SCENARIO_RUN_DIR);
  const relativeRunDir = relative(config.runRoot, runDir);
  if (
    relativeRunDir === ".."
    || relativeRunDir.startsWith("../")
    || relativeRunDir.startsWith("..\\")
  ) {
    throw new Error("scenario run directory escapes the runtime root");
  }
  mkdirSync(runDir, { recursive: true });
  context = createScenarioContext(config, runDir, runId, scenario);
  const facts = collectPreflightFacts(context);
  assertPreflightFacts(facts);
  writeFileSync(
    join(runDir, "preflight.json"),
    `${JSON.stringify(facts, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value, 2)}\n`,
  );
  process.stdout.write(buildPreflightSummary(facts));

  if (scenario !== "preflight") {
    const definition = resolveScenario(scenario);
    assertScenarioPrerequisites(
      scenario,
      definition,
      config.deploymentRecordPath,
    );
    await consumeScenarioFixtures(context, definition);
    await definition.run(context);
  }
} catch (error) {
  failure = error;
  if (context !== undefined) writeFailureDiagnostics(context);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (context !== undefined) {
    writeRunSummary(
      context,
      failure === undefined ? "passed" : "failed",
      failure,
    );
  }
}
