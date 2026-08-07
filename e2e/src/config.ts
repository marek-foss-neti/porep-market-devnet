import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AddressBook = {
  poRepMarket: string;
  spRegistry: string;
  validatorFactory: string;
  dataCapEvidenceAdapter: string;
  filecoinPay: string;
  sliOracle: string;
  metaAllocator: string;
  usdcToken: string;
  notificationReceiver: string;
  failingNotificationReceiver: string;
  sectorStatusInspector: string;
};

export type IdentityKeys = {
  deployer: string;
  client: string;
  providerPayee: string;
  porepService: string;
  operator: string;
  allocator: string;
  oracle: string;
  unauthorized: string;
};

export type E2EConfig = {
  cwd: string;
  projectRoot: string;
  envFile: string;
  rpcUrl: string;
  expectedChainId: number;
  expectedPorepCommit: string;
  deploymentPorepCommit: string;
  deploymentTargetMode: "locked" | "local";
  deploymentTargetDirty: boolean;
  deploymentId: string;
  deploymentRevision: number;
  proofBackend: "stacked" | "zigzag";
  deploymentRecordPath: string;
  privateKeyTest: string;
  privateKeySp: string;
  identityKeys: IdentityKeys;
  identityAddresses: Record<keyof IdentityKeys, string>;
  generation: string;
  provider: string;
  porepSourceDir: string;
  runRoot: string;
  addresses: AddressBook;
  requiredEnv: Record<string, "[set]" | "[missing]">;
  env: Record<string, string | undefined>;
};

type LoadConfigInput = {
  cwd?: string;
  projectRoot?: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  allowMissing?: boolean;
};

type Deployment = {
  deploymentId?: unknown;
  revision?: unknown;
  chain?: {
    generation?: unknown;
    chainId?: unknown;
    provider?: unknown;
  };
  proof?: { backend?: unknown };
  target?: {
    mode?: unknown;
    commit?: unknown;
    dirty?: unknown;
    snapshotPath?: unknown;
  };
  identities?: Record<string, unknown>;
  contracts?: Record<string, { address?: unknown }>;
};

type ActiveDeployment = {
  deploymentId?: unknown;
  revision?: unknown;
};

type Status = {
  generation?: unknown;
  chain?: { chainId?: unknown };
  miner?: { provider?: unknown };
  proof?: { backend?: unknown };
};

const DEVNET_CHAIN_ID = 31415926;
const IDENTITY_NAMES = [
  "deployer", "client", "providerPayee", "porepService",
  "operator", "allocator", "oracle", "unauthorized",
] as const;

export function loadConfig(input: LoadConfigInput = {}): E2EConfig {
  const cwd = resolve(input.cwd ?? process.cwd());
  const projectRoot = resolve(input.projectRoot ?? join(cwd, ".."));
  const env = input.env ?? process.env;
  const deploymentsRoot = join(projectRoot, ".runtime/deployments");
  const active = readJson<ActiveDeployment>(
    join(deploymentsRoot, "active.json"),
    "active deployment",
  );
  const deploymentId = deploymentIdValue(
    env.E2E_DEPLOYMENT_ID ?? active.deploymentId,
  );
  const deploymentRevision = revisionValue(
    env.E2E_DEPLOYMENT_REVISION ?? active.revision,
  );
  const deploymentRecordPath = join(
    deploymentsRoot,
    deploymentId,
    "revisions",
    `${String(deploymentRevision).padStart(3, "0")}.json`,
  );
  const privatePath = join(deploymentsRoot, deploymentId, "identities.private.json");
  const statusPath = join(projectRoot, ".runtime/devnet/status/latest.json");
  const deployment = readJson<Deployment>(deploymentRecordPath, "deployment manifest");
  const privateIdentities = readJson<Record<string, unknown>>(privatePath, "private identities");
  const status = readJson<Status>(statusPath, "DevNet status");

  if (
    requiredString(deployment.deploymentId, "deployment ID") !== deploymentId
    || requiredInteger(deployment.revision, "deployment revision") !== deploymentRevision
  ) {
    throw new Error("deployment selection does not match its revision record");
  }
  const generation = requiredString(deployment.chain?.generation, "deployment generation");
  if (generation !== requiredString(status.generation, "status generation")) {
    throw new Error("deployment generation is stale");
  }
  const chainId = requiredInteger(deployment.chain?.chainId, "deployment chain ID");
  const statusChainId = Number(requiredString(status.chain?.chainId, "status chain ID"));
  if (chainId !== DEVNET_CHAIN_ID || statusChainId !== DEVNET_CHAIN_ID) {
    throw new Error(`wrong DevNet chain ID: expected ${DEVNET_CHAIN_ID}`);
  }
  const provider = requiredString(deployment.chain?.provider, "deployment provider");
  if (provider !== requiredString(status.miner?.provider, "status provider")) {
    throw new Error("deployment provider is stale");
  }
  const proofBackend = requiredProofBackend(deployment.proof?.backend, "deployment proof backend");
  if (proofBackend !== requiredProofBackend(status.proof?.backend, "status proof backend")) {
    throw new Error("deployment proof backend is stale");
  }

  const identityKeys = Object.fromEntries(
    IDENTITY_NAMES.map((name) => [name, requiredKey(privateIdentities[name], name)]),
  ) as IdentityKeys;
  const identityAddresses = Object.fromEntries(
    IDENTITY_NAMES.map((name) => [
      name,
      requiredAddress(deployment.identities?.[name], `public identity: ${name}`),
    ]),
  ) as Record<keyof IdentityKeys, string>;

  const contractAddress = (name: string): string =>
    requiredAddress(deployment.contracts?.[name]?.address, `contract: ${name}`);
  const expectedPorepCommit = readPinnedPorepCommit(
    join(projectRoot, "versions.lock.yaml"),
  );
  const deploymentPorepCommit = requiredCommit(
    deployment.target?.commit,
    "PoRep Market source",
  );
  const deploymentTargetMode = requiredTargetMode(deployment.target?.mode);
  const deploymentTargetDirty = requiredBoolean(
    deployment.target?.dirty,
    "PoRep Market target dirty state",
  );
  const porepSourceDir = requiredAbsolutePath(
    deployment.target?.snapshotPath,
    "PoRep Market snapshot",
  );

  return {
    cwd,
    projectRoot,
    envFile: input.envFile ?? "",
    rpcUrl: "http://127.0.0.1:2234/rpc/v1",
    expectedChainId: DEVNET_CHAIN_ID,
    expectedPorepCommit,
    deploymentPorepCommit,
    deploymentTargetMode,
    deploymentTargetDirty,
    deploymentId,
    deploymentRevision,
    proofBackend,
    deploymentRecordPath,
    privateKeyTest: identityKeys.client,
    privateKeySp: identityKeys.unauthorized,
    identityKeys,
    identityAddresses,
    generation,
    provider,
    porepSourceDir,
    runRoot: join(projectRoot, ".runtime/runs"),
    addresses: {
      poRepMarket: contractAddress("PoRepMarket"),
      spRegistry: contractAddress("SPRegistry"),
      validatorFactory: contractAddress("ValidatorFactory"),
      dataCapEvidenceAdapter: contractAddress("DataCapEvidenceAdapter"),
      filecoinPay: contractAddress("FilecoinPay"),
      sliOracle: contractAddress("SLIOracle"),
      metaAllocator: contractAddress("MetaAllocator"),
      usdcToken: contractAddress("MockUSDC"),
      notificationReceiver: contractAddress("NotificationReceiver"),
      failingNotificationReceiver: contractAddress("FailingNotificationReceiver"),
      sectorStatusInspector: contractAddress("SectorStatusInspector"),
    },
    requiredEnv: {},
    env: { ...env },
  };
}

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error(`${label} is missing or invalid: ${path}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`invalid ${label}`);
  return value;
}

function requiredAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function requiredProofBackend(value: unknown, label: string): "stacked" | "zigzag" {
  if (value === "stacked" || value === "zigzag") return value;
  throw new Error(`invalid ${label}`);
}

function requiredKey(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`missing private identity: ${name}`);
  }
  return value;
}

function requiredCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function requiredTargetMode(value: unknown): "locked" | "local" {
  if (value !== "locked" && value !== "local") {
    throw new Error("invalid PoRep Market target mode");
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

function readPinnedPorepCommit(path: string): string {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    throw new Error(`version lock is missing or invalid: ${path}`);
  }
  const sections = lines.flatMap((line, index) =>
    /^  porep_market:\s*$/.test(line) ? [index] : []
  );
  if (sections.length !== 1) {
    throw new Error(`porep_market lock entry is missing or invalid: ${path}`);
  }
  const commits: string[] = [];
  for (let index = sections[0]! + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^  \S/.test(line)) break;
    const match = /^    commit:\s*([0-9a-f]{40})\s*$/.exec(line);
    if (match) commits.push(match[1]!);
  }
  if (commits.length !== 1) {
    throw new Error(`porep_market lock commit is missing or invalid: ${path}`);
  }
  return commits[0]!;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!path.startsWith("/")) throw new Error(`missing ${label}`);
  return path;
}

function deploymentIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^deployment-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("active deployment ID is missing or invalid");
  }
  return value;
}

function revisionValue(value: unknown): number {
  const revision = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("active deployment revision is missing or invalid");
  }
  return revision;
}
