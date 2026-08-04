import type { ScenarioContext } from "../runtime.js";
import { run, runRequired } from "../shell.js";

export function requireDevnet(context: ScenarioContext): void {
  const result = run(
    "docker",
    ["exec", containerName("lotus"), "lotus", "chain", "head"],
    context.projectRoot,
  );
  if (result.status !== 0) {
    throw new Error("DevNet not ready: Lotus chain head failed");
  }
}

export function dockerExec(context: ScenarioContext, container: string, args: string[]): string {
  return runRequired("docker", ["exec", containerName(container), ...args], context.projectRoot);
}

export function dockerExecEnv(
  context: ScenarioContext,
  container: string,
  env: Record<string, string>,
  args: string[]
): string {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return runRequired(
    "docker",
    ["exec", ...envArgs, containerName(container), ...args],
    context.projectRoot,
  );
}

export function dockerExecOk(context: ScenarioContext, container: string, args: string[]): boolean {
  return run("docker", ["exec", containerName(container), ...args], context.projectRoot).status === 0;
}

export function containerName(service: string): string {
  const services = new Set([
    "lotus", "lotus-miner", "curio", "piece-server", "indexer", "yugabyte",
  ]);
  if (!services.has(service)) throw new Error(`unknown DevNet service: ${service}`);
  return `porep-market-curio-devnet-${service}-1`;
}
