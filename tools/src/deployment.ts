import type { VersionLock } from "./lock.js";
import type { ContractTarget } from "./contract-target.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CODE_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CID_PATTERN = /^baf[a-z2-7]{20,}$/;
const PROVIDER_PATTERN = /^t0[0-9]+$/;
const DEPLOYMENT_ID_PATTERN = /^deployment-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROOF_BACKEND_PATTERN = /^(stacked|zigzag)$/;

export const deploymentContractNames = [
  "MockUSDC",
  "FilecoinPay",
  "MetaAllocator",
  "AllocatorFactory",
  "PoRepMarket",
  "PoRepMarketImplementation",
  "DataCapEvidenceAdapter",
  "DataCapEvidenceAdapterImplementation",
  "ValidatorFactory",
  "ValidatorFactoryImplementation",
  "ValidatorBeacon",
  "ValidatorImplementation",
  "SPRegistry",
  "SPRegistryImplementation",
  "SLIOracle",
  "SLIOracleImplementation",
  "SLIScorer",
  "SLIScorerImplementation",
  "TerminationOracle",
  "NotificationReceiver",
  "FailingNotificationReceiver",
  "SectorStatusInspector",
] as const;

const deploymentIdentityNames = [
  "deployer",
  "client",
  "providerPayee",
  "porepService",
  "operator",
  "allocator",
  "oracle",
  "unauthorized",
] as const;

type DeploymentContractName = (typeof deploymentContractNames)[number];
type DeploymentIdentityName = (typeof deploymentIdentityNames)[number];

export interface DeploymentContract {
  address: string;
  codeHash: string;
}

export interface DeploymentManifest {
  schemaVersion: 1;
  generatedAt: string;
  generation: string;
  genesisCid: string;
  chainId: number;
  epoch: number;
  provider: string;
  sources: Record<string, string>;
  identities: Record<DeploymentIdentityName, string>;
  contracts: Record<DeploymentContractName, DeploymentContract>;
}

export interface DeploymentRuntimeIdentity {
  generation: string;
  genesisCid: string;
  chainId: number;
  provider: string;
  proofBackend?: "stacked" | "zigzag";
}

export type RevisionContract = {
  address: string;
  runtimeCodeHash: string;
  kind: "direct" | "uups" | "beacon";
  implementation?: string;
  implementationCodeHash?: string;
};

export type DeploymentRevision = {
  schemaVersion: 2;
  deploymentId: string;
  revision: number;
  parentRevision: number | null;
  generatedAt: string;
  chain: DeploymentRuntimeIdentity & { epoch: number };
  proof: { backend: "stacked" | "zigzag" };
  target: ContractTarget;
  identities: Record<string, string>;
  contracts: Record<string, RevisionContract>;
  transactions: Array<{ purpose: string; hash: string; blockNumber: number }>;
};

export type ActiveDeployment = {
  schemaVersion: 1;
  deploymentId: string;
  revision: number;
};

export function parseDeploymentRevision(source: string): DeploymentRevision {
  const root = parseJsonRecord(source, "deployment revision");
  if (root.schemaVersion !== 2) throw new Error("deployment revision schemaVersion must be 2");
  const deploymentId = matchingString(root.deploymentId, DEPLOYMENT_ID_PATTERN, "deploymentId");
  const revision = integer(root.revision, "revision");
  const parentRevision = root.parentRevision === null ? null : integer(root.parentRevision, "parentRevision");
  if (
    (revision === 0 && parentRevision !== null)
    || (revision > 0 && parentRevision !== revision - 1)
  ) {
    throw new Error("deployment revision lineage is invalid");
  }
  const generatedAt = string(root.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("deployment revision generatedAt must be a timestamp");
  }

  const chainValue = record(root.chain, "chain");
  const chain = {
    generation: string(chainValue.generation, "chain.generation"),
    genesisCid: matchingString(chainValue.genesisCid, CID_PATTERN, "chain.genesisCid"),
    chainId: integer(chainValue.chainId, "chain.chainId"),
    provider: matchingString(chainValue.provider, PROVIDER_PATTERN, "chain.provider"),
    epoch: integer(chainValue.epoch, "chain.epoch"),
  };
  const proofValue = record(root.proof, "proof");
  const proof = {
    backend: matchingString(proofValue.backend, PROOF_BACKEND_PATTERN, "proof.backend") as "stacked" | "zigzag",
  };
  const targetValue = record(root.target, "target");
  const mode = targetValue.mode;
  if (mode !== "locked" && mode !== "local") {
    throw new Error("deployment revision target.mode is invalid");
  }
  const sourcePath = absolutePath(targetValue.sourcePath, "target.sourcePath");
  const snapshotPath = absolutePath(targetValue.snapshotPath, "target.snapshotPath");
  const submoduleValues = record(targetValue.submodules, "target.submodules");
  const submodules: Record<string, string> = {};
  for (const [name, commit] of Object.entries(submoduleValues)) {
    submodules[name] = matchingString(commit, COMMIT_PATTERN, `target.submodules.${name}`);
  }
  const target: ContractTarget = {
    mode,
    sourcePath,
    snapshotPath,
    commit: matchingString(targetValue.commit, COMMIT_PATTERN, "target.commit"),
    dirty: boolean(targetValue.dirty, "target.dirty"),
    submodules,
  };

  const identityValues = record(root.identities, "identities");
  const identities: Record<string, string> = {};
  for (const [name, value] of Object.entries(identityValues)) {
    identities[name] = matchingString(value, ADDRESS_PATTERN, `identities.${name}`);
  }
  const contractValues = record(root.contracts, "contracts");
  const contracts: Record<string, RevisionContract> = {};
  for (const [name, value] of Object.entries(contractValues)) {
    const contract = record(value, `contracts.${name}`);
    const kind = contract.kind;
    if (kind !== "direct" && kind !== "uups" && kind !== "beacon") {
      throw new Error(`deployment revision contracts.${name}.kind is invalid`);
    }
    const parsed: RevisionContract = {
      address: matchingString(contract.address, ADDRESS_PATTERN, `contracts.${name}.address`),
      runtimeCodeHash: matchingString(
        contract.runtimeCodeHash,
        CODE_HASH_PATTERN,
        `contracts.${name}.runtimeCodeHash`,
      ),
      kind,
    };
    if (kind !== "direct") {
      parsed.implementation = matchingString(
        contract.implementation,
        ADDRESS_PATTERN,
        `contracts.${name}.implementation`,
      );
      parsed.implementationCodeHash = matchingString(
        contract.implementationCodeHash,
        CODE_HASH_PATTERN,
        `contracts.${name}.implementationCodeHash`,
      );
    }
    contracts[name] = parsed;
  }
  if (Object.keys(contracts).length === 0) {
    throw new Error("deployment revision contracts must not be empty");
  }

  if (!Array.isArray(root.transactions)) {
    throw new Error("deployment revision transactions must be an array");
  }
  const transactions = root.transactions.map((value, index) => {
    const transaction = record(value, `transactions.${index}`);
    return {
      purpose: string(transaction.purpose, `transactions.${index}.purpose`),
      hash: matchingString(transaction.hash, CODE_HASH_PATTERN, `transactions.${index}.hash`),
      blockNumber: integer(transaction.blockNumber, `transactions.${index}.blockNumber`),
    };
  });
  return {
    schemaVersion: 2,
    deploymentId,
    revision,
    parentRevision,
    generatedAt,
    chain,
    proof,
    target,
    identities,
    contracts,
    transactions,
  };
}

export function parseActiveDeployment(source: string): ActiveDeployment {
  const root = parseJsonRecord(source, "active deployment");
  if (root.schemaVersion !== 1) throw new Error("active deployment schemaVersion must be 1");
  return {
    schemaVersion: 1,
    deploymentId: matchingString(root.deploymentId, DEPLOYMENT_ID_PATTERN, "deploymentId"),
    revision: integer(root.revision, "revision"),
  };
}

export function assertDeploymentRevisionMatchesRuntime(
  revision: DeploymentRevision,
  runtime: DeploymentRuntimeIdentity,
): void {
  if (revision.chain.chainId !== runtime.chainId) throw new Error("deployment chain ID is stale");
  if (revision.chain.generation !== runtime.generation) throw new Error("deployment generation is stale");
  if (revision.chain.genesisCid !== runtime.genesisCid) throw new Error("deployment genesis CID is stale");
  if (revision.chain.provider !== runtime.provider) throw new Error("deployment provider is stale");
  if (runtime.proofBackend !== undefined && revision.proof.backend !== runtime.proofBackend) {
    throw new Error("deployment proof backend is stale");
  }
}

export function requireDeploymentContracts(
  revision: DeploymentRevision,
  names: string[],
): void {
  for (const name of names) {
    if (revision.contracts[name] === undefined) {
      throw new Error(`deployment is missing required contract ${name}`);
    }
  }
}

export function formatDeploymentRevisionAddresses(revision: DeploymentRevision): string {
  const lines: string[][] = [
    ["deploymentId", revision.deploymentId],
    ["revision", String(revision.revision)],
    ["chainId", String(revision.chain.chainId)],
    ["generation", revision.chain.generation],
    ["provider", revision.chain.provider],
    ["proofBackend", revision.proof.backend],
  ];
  for (const [name, address] of Object.entries(revision.identities).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push([`identity.${name}`, address]);
  }
  for (const [name, contract] of Object.entries(revision.contracts).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push([name, contract.address]);
  }
  return `${lines.map((line) => line.join("\t")).join("\n")}\n`;
}

export function formatDeploymentRevisionToolingEnv(revision: DeploymentRevision): string {
  const required = [
    "PoRepMarket",
    "FilecoinPay",
    "SPRegistry",
    "ValidatorFactory",
    "MockUSDC",
    "SLIOracle",
    "SLIScorer",
  ];
  requireDeploymentContracts(revision, required);
  const address = (name: string): string => revision.contracts[name]!.address;
  return [
    "RPC_URL=http://127.0.0.1:2234/rpc/v1",
    `CHAIN_ID=${revision.chain.chainId}`,
    `POREP_MARKET=${address("PoRepMarket")}`,
    `FILECOIN_PAY=${address("FilecoinPay")}`,
    `SP_REGISTRY=${address("SPRegistry")}`,
    `VALIDATOR_FACTORY=${address("ValidatorFactory")}`,
    `USDC_TOKEN=${address("MockUSDC")}`,
    `POREP_MARKET_CONTRACT_ADDRESS=${address("PoRepMarket")}`,
    `FILECOIN_PAY_CONTRACT_ADDRESS=${address("FilecoinPay")}`,
    `SP_REGISTRY_CONTRACT_ADDRESS=${address("SPRegistry")}`,
    `SLI_ORACLE_CONTRACT_ADDRESS=${address("SLIOracle")}`,
    `SLI_SCORER_CONTRACT_ADDRESS=${address("SLIScorer")}`,
    "",
  ].join("\n");
}

export function parseDeploymentManifest(source: string): DeploymentManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("deployment manifest must be valid JSON");
  }
  const root = record(value, "deployment manifest");
  if (root.schemaVersion !== 1) throw new Error("deployment manifest schemaVersion must be 1");

  const generatedAt = string(root.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("deployment manifest generatedAt must be a timestamp");
  }
  const generation = string(root.generation, "generation");
  const genesisCid = matchingString(root.genesisCid, CID_PATTERN, "genesisCid");
  const chainId = integer(root.chainId, "chainId");
  const epoch = integer(root.epoch, "epoch");
  const provider = matchingString(root.provider, PROVIDER_PATTERN, "provider");

  const sourceValues = record(root.sources, "sources");
  const sources: Record<string, string> = {};
  for (const [name, commit] of Object.entries(sourceValues)) {
    sources[name] = matchingString(commit, COMMIT_PATTERN, `sources.${name}`);
  }

  const identityValues = record(root.identities, "identities");
  const identities = {} as Record<DeploymentIdentityName, string>;
  for (const name of deploymentIdentityNames) {
    identities[name] = matchingString(identityValues[name], ADDRESS_PATTERN, `identities.${name}`);
  }

  const contractValues = record(root.contracts, "contracts");
  const contracts = {} as Record<DeploymentContractName, DeploymentContract>;
  for (const name of deploymentContractNames) {
    const contract = record(contractValues[name], `contracts.${name}`);
    contracts[name] = {
      address: matchingString(contract.address, ADDRESS_PATTERN, `contracts.${name}.address`),
      codeHash: matchingString(contract.codeHash, CODE_HASH_PATTERN, `contracts.${name}.codeHash`),
    };
  }

  return {
    schemaVersion: 1,
    generatedAt,
    generation,
    genesisCid,
    chainId,
    epoch,
    provider,
    sources,
    identities,
    contracts,
  };
}

export function assertDeploymentMatchesRuntime(
  manifest: DeploymentManifest,
  runtime: DeploymentRuntimeIdentity,
  lock: VersionLock,
): void {
  if (manifest.chainId !== runtime.chainId) throw new Error("deployment chain ID is stale");
  if (manifest.generation !== runtime.generation) throw new Error("deployment generation is stale");
  if (manifest.genesisCid !== runtime.genesisCid) throw new Error("deployment genesis CID is stale");
  if (manifest.provider !== runtime.provider) throw new Error("deployment provider is stale");
  for (const [name, source] of Object.entries(lock.sources)) {
    if (manifest.sources[name] !== source.commit) {
      throw new Error(`deployment source ${name} does not match the version lock`);
    }
  }
}

export function formatDeploymentAddresses(manifest: DeploymentManifest): string {
  const lines = [
    ["chainId", String(manifest.chainId)],
    ["generation", manifest.generation],
    ["provider", manifest.provider],
  ];
  for (const name of deploymentIdentityNames) {
    lines.push([`identity.${name}`, manifest.identities[name]]);
  }
  for (const name of deploymentContractNames) {
    lines.push([name, manifest.contracts[name].address]);
  }
  return `${lines.map((line) => line.join("\t")).join("\n")}\n`;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`deployment manifest ${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(source: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(source), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be valid JSON`);
    throw error;
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`deployment manifest ${field} must be a non-empty string`);
  }
  return value;
}

function matchingString(value: unknown, pattern: RegExp, field: string): string {
  const parsed = string(value, field);
  if (!pattern.test(parsed)) throw new Error(`deployment manifest ${field} is invalid`);
  return parsed;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`deployment manifest ${field} must be a non-negative integer`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`deployment manifest ${field} must be a boolean`);
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!parsed.startsWith("/")) {
    throw new Error(`deployment manifest ${field} must be an absolute path`);
  }
  return parsed;
}
