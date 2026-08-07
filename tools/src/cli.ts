import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectDevnetStatus,
  inspectRenderedCompose,
  parseComposeRuntimeContract,
} from "./devnet.js";
import { prepareContractTarget } from "./contract-target.js";
import {
  assertDeploymentRevisionMatchesRuntime,
  assertDeploymentMatchesRuntime,
  formatDeploymentAddresses,
  formatDeploymentRevisionAddresses,
  formatDeploymentRevisionToolingEnv,
  parseDeploymentManifest,
  parseDeploymentRevision,
} from "./deployment.js";
import { loadVersionLock, managedSources } from "./lock.js";
import { loadRuntimeLock } from "./runtime-lock.js";
import { reconcileSource, type SourceState, verifySource } from "./sources.js";
import { createUpgradePlan } from "./upgrade.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockPath = join(repositoryRoot, "versions.lock.yaml");
const cacheRoot = join(repositoryRoot, ".cache", "sources");

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 7 && args[0] === "upgrade" && args[1] === "plan") {
    const fromRevision = Number(args[3]);
    if (!Number.isSafeInteger(fromRevision) || fromRevision < 0) {
      throw new Error("upgrade fromRevision must be a non-negative integer");
    }
    const revision = parseDeploymentRevision(await readStandardInput());
    if (revision.deploymentId !== args[2] || revision.revision !== fromRevision) {
      throw new Error("upgrade plan does not match the selected deployment revision");
    }
    const planInput = {
      revision,
      targetSnapshotPath: resolve(args[4] ?? ""),
      contracts: (args[5] ?? "").split(",").filter(Boolean),
      ...(args[6] === "-"
        ? {}
        : { calldata: JSON.parse(args[6] ?? "{}") as Record<string, string> }),
    };
    console.log(JSON.stringify(createUpgradePlan(planInput)));
    return;
  }
  if (args[0] === "contract-target" && args[1] === "prepare") {
    const input = parseContractTargetArguments(args);
    console.log(JSON.stringify(await prepareContractTarget({
      projectRoot: repositoryRoot,
      ...input,
    })));
    return;
  }

  if (
    (args.length === 7 || args.length === 8)
    && args[0] === "deployment"
    && args[1] === "revision"
    && args[2] === "inspect"
  ) {
    const chainId = Number(args[5]);
    if (!Number.isSafeInteger(chainId) || chainId < 0) {
      throw new Error("deployment revision inspect chain ID must be a non-negative integer");
    }
    const revision = parseDeploymentRevision(await readStandardInput());
    assertDeploymentRevisionMatchesRuntime(revision, {
      generation: args[3] ?? "",
      genesisCid: args[4] ?? "",
      chainId,
      provider: args[6] ?? "",
      ...(args[7] === undefined ? {} : { proofBackend: normalizeProofBackend(args[7]) }),
    });
    console.log("deployment revision is current");
    return;
  }

  if (matchesThree(args, "deployment", "revision", "addresses")) {
    console.log(formatDeploymentRevisionAddresses(
      parseDeploymentRevision(await readStandardInput()),
    ).trimEnd());
    return;
  }

  if (matchesThree(args, "deployment", "revision", "tooling-env")) {
    console.log(formatDeploymentRevisionToolingEnv(
      parseDeploymentRevision(await readStandardInput()),
    ).trimEnd());
    return;
  }

  if (args.length === 6 && args[0] === "deployment" && args[1] === "inspect") {
    const chainId = Number(args[4]);
    if (!Number.isSafeInteger(chainId) || chainId < 0) {
      throw new Error("deployment inspect chain ID must be a non-negative integer");
    }
    const [lock, manifestSource] = await Promise.all([
      loadVersionLock(lockPath),
      readStandardInput(),
    ]);
    const manifest = parseDeploymentManifest(manifestSource);
    assertDeploymentMatchesRuntime(
      manifest,
      {
        generation: args[2] ?? "",
        genesisCid: args[3] ?? "",
        chainId,
        provider: args[5] ?? "",
      },
      lock,
    );
    console.log("deployment manifest is current");
    return;
  }

  if (matches(args, "deployment", "addresses")) {
    console.log(formatDeploymentAddresses(parseDeploymentManifest(await readStandardInput())).trimEnd());
    return;
  }

  if (matchesThree(args, "devnet", "status", "inspect")) {
    const [runtimeLock, statusSource] = await Promise.all([
      loadRuntimeLock(lockPath),
      readStandardInput(),
    ]);
    const inspected = inspectDevnetStatus(statusSource, runtimeLock);
    console.log(`ready provider=${inspected.provider} epoch=${inspected.epoch}`);
    return;
  }

  if (
    args.length === 4
    && args[0] === "devnet"
    && args[1] === "compose"
    && args[2] === "inspect"
  ) {
    const composeEnvironmentPath = resolve(args[3] ?? "");
    const [runtimeLock, lock, environmentSource, renderedSource] = await Promise.all([
      loadRuntimeLock(lockPath),
      loadVersionLock(lockPath),
      readFile(composeEnvironmentPath, "utf8"),
      readStandardInput(),
    ]);
    const contract = parseComposeRuntimeContract(environmentSource);
    const sources = managedSources(lock);
    const curio = sources.find((source) => source.name === "curio");
    const filecoinServices = sources.find((source) => source.name === "filecoin_services");
    const multicall3 = sources.find((source) => source.name === "multicall3");
    if (curio === undefined || filecoinServices === undefined || multicall3 === undefined) {
      throw new Error("managed source contract is incomplete");
    }
    if (
      contract.imageNamespace !== runtimeLock.runtime.composeProject
      || contract.curioShortCommit !== curio.commit.slice(0, 12)
      || !contract.filecoinServicesSource.endsWith(`/${filecoinServices.name}/${filecoinServices.commit}`)
      || !contract.multicall3Source.endsWith(`/${multicall3.name}/${multicall3.commit}`)
      || contract.yugabyteImage !== runtimeLock.images.yugabyte.resolvedReference.replace(/^docker\.io\//, "")
    ) {
      throw new Error("compose environment does not match the immutable lock");
    }
    const inspected = inspectRenderedCompose(renderedSource, runtimeLock, contract);
    console.log(
      `${inspected.services.length} services, ${inspected.images.length} images, `
      + `${inspected.ports.length} ports, ${inspected.mounts.length} mounts`,
    );
    return;
  }

  if (matchesThree(args, "runtime", "lock", "verify")) {
    const runtimeLock = await loadRuntimeLock(lockPath);
    console.log([
      "network",
      runtimeLock.network.chainId,
      `NV${runtimeLock.network.genesis.networkVersion}/actors-v${runtimeLock.network.genesis.actorsVersion}`,
      `epoch-${runtimeLock.network.firehorse.epoch}=NV${runtimeLock.network.firehorse.networkVersion}/actors-v${runtimeLock.network.firehorse.actorsVersion}`,
    ].join("\t"));
    console.log(["actor", "v18-manifest", runtimeLock.network.actorsV18.manifestCid].join("\t"));
    console.log([
      "actor",
      "v18-storage-miner",
      runtimeLock.network.actorsV18.storageMinerActorCid,
    ].join("\t"));
    for (const image of Object.values(runtimeLock.images)) {
      console.log([
        "image",
        image.name,
        image.resolvedReference,
        `linux/amd64=${image.platformDigests["linux/amd64"]}`,
        `linux/arm64=${image.platformDigests["linux/arm64"]}`,
      ].join("\t"));
    }
    console.log(["tool", "node", runtimeLock.buildTools.node.version].join("\t"));
    console.log(["tool", "npm", runtimeLock.buildTools.npm.version].join("\t"));
    for (const tool of Object.values(runtimeLock.buildTools.sources)) {
      const fields = ["tool", tool.name, tool.tag, tool.commit];
      if (tool.managedSource !== undefined) {
        fields.push(`managed-source=${tool.managedSource}`);
      }
      console.log(fields.join("\t"));
    }
    console.log([
      "runtime",
      runtimeLock.runtime.composeProject,
      `${runtimeLock.runtime.services.length}-services`,
      `${Object.keys(runtimeLock.runtime.ports).length}-ports`,
    ].join("\t"));
    for (const service of runtimeLock.runtime.services) {
      console.log(["service", service].join("\t"));
    }
    for (const port of Object.values(runtimeLock.runtime.ports)) {
      console.log([
        "port",
        port.name,
        port.service,
        `${port.host}:${port.container}`,
      ].join("\t"));
    }
    return;
  }

  const lock = await loadVersionLock(lockPath);
  const sources = managedSources(lock);

  if (matches(args, "lock", "verify")) {
    for (const source of sources) {
      console.log([source.name, "locked", source.commit].join("\t"));
    }
    return;
  }

  if (matches(args, "sources", "fetch")) {
    for (const source of sources) {
      printState(await reconcileSource(source, cacheRoot));
    }
    return;
  }

  if (matches(args, "sources", "verify")) {
    for (const source of sources) {
      printState(await verifySource(source, cacheRoot));
    }
    return;
  }

  throw new Error(
    "usage: cli.ts deployment inspect <generation> <genesis-cid> <chain-id> <provider> | "
    + "deployment addresses | deployment revision inspect <generation> <genesis-cid> "
    + "<chain-id> <provider> [proof-backend] | deployment revision addresses | "
    + "devnet status inspect | devnet compose inspect <compose.env> | "
    + "contract-target prepare <deployment-seed> [--source <absolute-path>] | "
    + "runtime lock verify | lock verify | sources fetch | sources verify",
  );
}

export function parseContractTargetArguments(args: string[]): {
  deploymentSeed: string;
  sourcePath?: string;
} {
  const usage = "usage: contract-target prepare <deployment-seed> [--source <absolute-path>]";
  const deploymentSeed = args[2];
  if (
    args[0] !== "contract-target"
    || args[1] !== "prepare"
    || deploymentSeed === undefined
  ) {
    throw new Error(usage);
  }
  if (args.length === 3) return { deploymentSeed };
  const sourcePath = args[4];
  if (args.length !== 5 || args[3] !== "--source" || sourcePath === undefined) {
    throw new Error(usage);
  }
  return { deploymentSeed, sourcePath };
}

function matches(args: string[], first: string, second: string): boolean {
  return args.length === 2 && args[0] === first && args[1] === second;
}

function matchesThree(args: string[], first: string, second: string, third: string): boolean {
  return args.length === 3 && args[0] === first && args[1] === second && args[2] === third;
}

function normalizeProofBackend(value: string): "stacked" | "zigzag" {
  if (value === "stacked" || value === "zigzag") return value;
  throw new Error("proof backend must be stacked or zigzag");
}

function printState(state: SourceState): void {
  const submodules = Object.entries(state.submodules)
    .map(([name, commit]) => `${name}=${commit}`)
    .join(",");
  console.log([
    state.name,
    state.path,
    state.expectedCommit,
    state.actualCommit,
    state.detached ? "detached" : "attached",
    state.dirty ? "dirty" : "clean",
    submodules,
  ].join("\t"));
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
