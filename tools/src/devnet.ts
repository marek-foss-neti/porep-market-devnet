import { parseDocument } from "yaml";
import { isAbsolute, relative, resolve } from "node:path";

import type { RuntimeLock } from "./runtime-lock.js";

export interface ComposeInspection {
  services: string[];
  hostPorts: number[];
  hasContainerNames: boolean;
  hasStaticNetworkIdentity: boolean;
  hasAnonymousVolumes: boolean;
  hasUnsafeMount: boolean;
  hasSynapseDisabledMarker: boolean;
}

export interface ComposeRuntimeContract {
  curioShortCommit: string;
  dataDirectory: string;
  filecoinServicesSource: string;
  filProofsUseZigZag: string;
  filProofsZigZagGenerateMissingParams: string;
  imageNamespace: string;
  multicall3Source: string;
  proofBackend: "stacked" | "zigzag";
  proofParametersDirectory: string;
  yugabyteImage: string;
}

export interface RenderedComposeInspection {
  completionServices: string[];
  healthyServices: string[];
  images: string[];
  mounts: string[];
  ports: string[];
  services: string[];
}

export interface DevnetStatusInspection {
  ready: true;
  epoch: number;
  provider: string;
}

const composeEnvironmentKeys = [
  "DEVNET_CURIO_SHORT_COMMIT",
  "DEVNET_DATA_DIR",
  "DEVNET_FILECOIN_SERVICES_SOURCE",
  "DEVNET_IMAGE_NAMESPACE",
  "DEVNET_MULTICALL3_SOURCE",
  "DEVNET_PROOF_BACKEND",
  "DEVNET_PROOF_PARAMETERS_DIR",
  "DEVNET_YUGABYTE_IMAGE",
  "FIL_PROOFS_USE_ZIGZAG",
  "FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS",
] as const;

export function inspectCompose(source: string, lock: RuntimeLock): ComposeInspection {
  const document = parseDocument(source).toJS();
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("compose document must be a mapping");
  }
  const root = document as Record<string, unknown>;
  const services = record(root.services, "services");
  const names = Object.keys(services).sort();
  const expected = [...lock.runtime.services].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("compose service allowlist mismatch");
  const rendered = JSON.stringify(root);
  const hostPorts = Object.values(lock.runtime.ports).map((port) => port.host).sort((a, b) => a - b);
  for (const port of hostPorts) {
    if (!rendered.includes(`:${port}:`)) throw new Error(`compose missing host port ${port}`);
  }
  return {
    services: names,
    hostPorts,
    hasContainerNames: rendered.includes("container_name"),
    hasStaticNetworkIdentity: rendered.includes("ipv4_address") || rendered.includes("subnet"),
    hasAnonymousVolumes: /\"volumes\":\[[^\]]*\"\/[^\"]+\"/.test(rendered),
    hasUnsafeMount: rendered.includes(".cache/sources/curio") || rendered.includes("${HOME}") || rendered.includes(`/${"Users"}/`),
    hasSynapseDisabledMarker: rendered.includes(".synapse-sdk.ready"),
  };
}

export function inspectRenderedCompose(
  source: string,
  lock: RuntimeLock,
  contract: ComposeRuntimeContract,
): RenderedComposeInspection {
  const root = parseJsonRecord(source, "rendered compose");
  if (root.name !== lock.runtime.composeProject) throw new Error("compose project mismatch");
  if ("volumes" in root) throw new Error("anonymous or named Compose volumes are forbidden");

  const services = record(root.services, "services");
  const names = Object.keys(services).sort();
  for (const required of lock.runtime.services) {
    if (!(required in services)) throw new Error(`required service is missing: ${required}`);
  }

  const images: string[] = [];
  const ports: string[] = [];
  const mounts: string[] = [];
  const healthyServices: string[] = [];
  const completionServices: string[] = [];
  const publishedPorts = new Set<string>();
  const allowedMountRoots = [
    contract.dataDirectory,
    contract.filecoinServicesSource,
    contract.multicall3Source,
    contract.proofParametersDirectory,
  ].map((path) => resolve(path));

  for (const name of names) {
    const service = record(services[name], `service ${name}`);
    if ("container_name" in service || service.network_mode === "host") {
      throw new Error(`${name} declares fixed network identity`);
    }
    if (JSON.stringify(service.networks ?? {}).includes("ipv4_address")) {
      throw new Error(`${name} declares a static IP address`);
    }

    if (typeof service.image !== "string" || service.image.length === 0) {
      throw new Error(`${name} image is missing`);
    }
    if (lock.runtime.services.includes(name as typeof lock.runtime.services[number])) {
      const expectedImage = name === "yugabyte"
        ? contract.yugabyteImage
        : `${contract.imageNamespace}/${name}:${contract.curioShortCommit}`;
      if (service.image !== expectedImage) throw new Error(`${name} image mismatch`);
    }
    const environment = environmentRecord(service.environment);
    if (
      (name === "lotus" || name === "curio")
      && environment.FIL_PROOFS_USE_ZIGZAG !== contract.filProofsUseZigZag
    ) {
      throw new Error(`${name} FIL_PROOFS_USE_ZIGZAG mismatch`);
    }
    if (
      name === "curio"
      && environment.FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS
        !== contract.filProofsZigZagGenerateMissingParams
    ) {
      throw new Error("curio FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS mismatch");
    }
    images.push(service.image);

    const servicePorts = array(service.ports ?? [], `${name} ports`).map((value, index) => {
      const port = record(value, `${name} port ${index}`);
      if (
        port.host_ip !== "127.0.0.1"
        || typeof port.published !== "string"
        || typeof port.target !== "number"
      ) {
        throw new Error(`${name} port ${index} is not a loopback binding`);
      }
      if (publishedPorts.has(port.published)) {
        throw new Error(`host port is duplicated: ${port.published}`);
      }
      publishedPorts.add(port.published);
      return `${name}:${port.published}:${port.target}`;
    }).sort();
    ports.push(...servicePorts);

    const actualMounts = array(service.volumes ?? [], `${name} volumes`).map((value, index) => {
      const mount = record(value, `${name} volume ${index}`);
      if (
        mount.type !== "bind"
        || typeof mount.source !== "string"
        || typeof mount.target !== "string"
        || !isAbsolute(mount.source)
        || !isAbsolute(mount.target)
      ) {
        throw new Error(`${name} volume ${index} must be an absolute bind mount`);
      }
      const source = resolve(mount.source);
      if (!allowedMountRoots.some((root) => pathIsWithin(source, root))) {
        throw new Error(`${name} volume ${index} source is outside project-owned roots`);
      }
      return `${source}:${mount.target}:${mount.read_only === true ? "ro" : "rw"}`;
    }).sort();
    mounts.push(...actualMounts.map((mount) => `${name}:${mount}`));

    if (name === "contracts-bootstrap") {
      completionServices.push(name);
    } else if (lock.runtime.services.includes(name as typeof lock.runtime.services[number])) {
      const healthcheck = record(service.healthcheck, `${name} healthcheck`);
      if (!Array.isArray(healthcheck.test)) throw new Error(`${name} healthcheck test is missing`);
      healthyServices.push(name);
    }
  }

  for (const expected of Object.values(lock.runtime.ports)) {
    const key = `${expected.service}:${expected.host}:${expected.container}`;
    if (!ports.includes(key)) throw new Error(`required port is missing: ${key}`);
  }

  return {
    completionServices: completionServices.sort(),
    healthyServices: healthyServices.sort(),
    images: images.sort(),
    mounts: mounts.sort(),
    ports: ports.sort(),
    services: names,
  };
}

export function parseComposeRuntimeContract(source: string): ComposeRuntimeContract {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    if (rawLine === "") continue;
    const separator = rawLine.indexOf("=");
    if (separator <= 0) throw new Error(`compose environment line ${index + 1} is invalid`);
    const key = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    if (!composeEnvironmentKeys.includes(key as typeof composeEnvironmentKeys[number])) {
      throw new Error(`compose environment key is unexpected: ${key}`);
    }
    if (key in values) throw new Error(`compose environment key is duplicated: ${key}`);
    if (value === "" || value.includes("\0") || value.includes("\n")) {
      throw new Error(`compose environment value is invalid: ${key}`);
    }
    values[key] = value;
  }
  assertExactKeys(values, [...composeEnvironmentKeys], "compose environment");
  return {
    curioShortCommit: requiredValue(values, "DEVNET_CURIO_SHORT_COMMIT"),
    dataDirectory: requiredValue(values, "DEVNET_DATA_DIR"),
    filecoinServicesSource: requiredValue(values, "DEVNET_FILECOIN_SERVICES_SOURCE"),
    filProofsUseZigZag: requiredValue(values, "FIL_PROOFS_USE_ZIGZAG"),
    filProofsZigZagGenerateMissingParams: requiredValue(values, "FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS"),
    imageNamespace: requiredValue(values, "DEVNET_IMAGE_NAMESPACE"),
    multicall3Source: requiredValue(values, "DEVNET_MULTICALL3_SOURCE"),
    proofBackend: proofBackendValue(requiredValue(values, "DEVNET_PROOF_BACKEND")),
    proofParametersDirectory: requiredValue(values, "DEVNET_PROOF_PARAMETERS_DIR"),
    yugabyteImage: requiredValue(values, "DEVNET_YUGABYTE_IMAGE"),
  };
}

export function validateLifecycleScript(source: string): {
  usesOnlyProjectCompose: boolean; hasDestructiveDownOnlyInReset: boolean;
  rejectsUnsafeResetPaths: boolean; allowlistsLogServices: boolean; hasForbiddenCleanup: boolean;
} {
  return {
    usesOnlyProjectCompose: source.includes("devnet_compose"),
    hasDestructiveDownOnlyInReset: source.includes("down --volumes --remove-orphans"),
    rejectsUnsafeResetPaths: source.includes("devnet_require_owned_path"),
    allowlistsLogServices: source.includes("devnet_require_service"),
    hasForbiddenCleanup: /docker system prune|--rmi|make devnet\/(?:up|down)/.test(source),
  };
}

export function inspectDevnetStatus(
  source: string,
  lock: RuntimeLock,
): DevnetStatusInspection {
  const root = parseJsonRecord(source, "devnet status");
  if (root.schemaVersion !== 1) throw new Error("devnet status schema mismatch");
  if (
    typeof root.generatedAt !== "string"
    || !Number.isFinite(Date.parse(root.generatedAt))
    || typeof root.generation !== "string"
    || root.generation.length === 0
  ) {
    throw new Error("devnet status identity is invalid");
  }

  const build = record(root.build, "build");
  if (
    typeof build.curioCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(build.curioCommit)
    || typeof build.lotusCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(build.lotusCommit)
    || (build.platform !== "linux/arm64" && build.platform !== "linux/amd64")
  ) {
    throw new Error("devnet status build evidence is invalid");
  }

  const proof = record(root.proof, "proof");
  const proofBackend = proofBackendValue(proof.backend);
  const expectedProofEnv = proofBackend === "zigzag" ? "1" : "0";
  const lotusProof = record(proof.lotus, "proof.lotus");
  const curioProof = record(proof.curio, "proof.curio");
  if (
    lotusProof.FIL_PROOFS_USE_ZIGZAG !== expectedProofEnv
    || curioProof.FIL_PROOFS_USE_ZIGZAG !== expectedProofEnv
    || curioProof.FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS !== expectedProofEnv
  ) {
    throw new Error("devnet proof backend environment is invalid");
  }

  const compose = array(root.compose, "compose").map((value, index) => {
    const service = record(value, `compose service ${index}`);
    if (
      typeof service.service !== "string"
      || typeof service.state !== "string"
      || typeof service.health !== "string"
      || typeof service.exitCode !== "number"
    ) {
      throw new Error(`compose service ${index} is invalid`);
    }
    return service as {
      service: string;
      state: string;
      health: string;
      exitCode: number;
    };
  });
  assertEqual(
    compose.map((service) => service.service).sort(),
    [...lock.runtime.services].sort(),
    "status service allowlist",
  );
  for (const service of compose) {
    if (service.service === "contracts-bootstrap") {
      if (service.state !== "exited" || service.exitCode !== 0) {
        throw new Error("contracts-bootstrap did not complete successfully");
      }
    } else if (service.state !== "running" || service.health !== "healthy") {
      throw new Error(`${service.service} is not healthy`);
    }
  }

  const chain = record(root.chain, "chain");
  if (
    chain.chainId !== `0x${lock.network.chainId.toString(16)}`
    || !Number.isInteger(chain.epoch)
    || (chain.epoch as number) < lock.network.firehorse.epoch
    || chain.networkVersion !== lock.network.firehorse.networkVersion
    || chain.actorsVersion !== lock.network.firehorse.actorsVersion
    || chain.manifestCid !== lock.network.actorsV18.manifestCid
    || chain.minerActorCodeCid !== lock.network.actorsV18.storageMinerActorCid
  ) {
    throw new Error("live chain does not match the required NV28 actor state");
  }

  const miner = record(root.miner, "miner");
  if (
    typeof miner.provider !== "string"
    || !/^t0[0-9]+$/.test(miner.provider)
    || miner.provider === "t01000"
    || typeof miner.owner !== "string"
    || miner.owner.length === 0
    || typeof miner.worker !== "string"
    || miner.worker.length === 0
    || !Array.isArray(miner.control)
    || !miner.control.every((address) => typeof address === "string" && address.length > 0)
    || miner.sectorSize !== 8_388_608
  ) {
    throw new Error("Curio provider evidence is invalid");
  }

  const curio = record(root.curio, "curio");
  if (
    curio.commit !== build.curioCommit
    || curio.apiReady !== true
    || curio.marketReady !== true
    || curio.databaseReady !== true
    || !Number.isInteger(curio.taskCount)
    || (curio.taskCount as number) < 0
  ) {
    throw new Error("Curio semantic readiness is incomplete");
  }

  return {
    ready: true,
    epoch: chain.epoch as number,
    provider: miner.provider,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a sequence`);
  return value;
}

function parseJsonRecord(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return record(parsed, label);
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  assertEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch`);
}

function pathIsWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith("../") && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (value === undefined) throw new Error(`compose environment is missing ${key}`);
  return value;
}

function proofBackendValue(value: unknown): "stacked" | "zigzag" {
  if (value === "stacked" || value === "zigzag") return value;
  throw new Error("proof backend is invalid");
}

function environmentRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries: Record<string, string> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (typeof entryValue === "string") entries[key] = entryValue;
    }
    return entries;
  }
  if (Array.isArray(value)) {
    const entries: Record<string, string> = {};
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const separator = entry.indexOf("=");
      if (separator > 0) entries[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return entries;
  }
  return {};
}
