import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InterfaceAbi } from "ethers";
import type { ScenarioContext } from "../runtime.js";

export type ContractAbis = {
  spRegistry: InterfaceAbi;
  poRepMarket: InterfaceAbi;
  validatorFactory: InterfaceAbi;
  validator: InterfaceAbi;
  filecoinPay: InterfaceAbi;
  erc20Permit: InterfaceAbi;
  dataCapEvidenceAdapter: InterfaceAbi;
  sliOracle: InterfaceAbi;
  sliScorer: InterfaceAbi;
};

const cache = new Map<string, ContractAbis>();

export function artifactAbis(context: ScenarioContext): ContractAbis {
  const filecoinPayRoot = join(
    context.projectRoot,
    ".runtime/deployments",
    context.config.deploymentId,
    "work/filecoin-pay",
  );
  const harnessRoot = join(context.projectRoot, ".runtime/contracts");
  const cacheKey = `${context.config.porepSourceDir}:${filecoinPayRoot}:${harnessRoot}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const abis = {
    spRegistry: loadAbi(context.config.porepSourceDir, "SPRegistry.sol/SPRegistry.json"),
    poRepMarket: loadAbi(context.config.porepSourceDir, "PoRepMarket.sol/PoRepMarket.json"),
    validatorFactory: loadAbi(context.config.porepSourceDir, "ValidatorFactory.sol/ValidatorFactory.json"),
    validator: loadAbi(context.config.porepSourceDir, "Validator.sol/Validator.json"),
    dataCapEvidenceAdapter: loadAbi(context.config.porepSourceDir, "DataCapEvidenceAdapter.sol/DataCapEvidenceAdapter.json"),
    sliOracle: loadAbi(context.config.porepSourceDir, "SLIOracle.sol/SLIOracle.json"),
    sliScorer: loadAbi(context.config.porepSourceDir, "SLIScorer.sol/SLIScorer.json"),
    filecoinPay: loadAbi(filecoinPayRoot, "FilecoinPayV1.sol/FilecoinPayV1.json"),
    erc20Permit: loadAbi(harnessRoot, "MockUSDC.sol/MockUSDC.json")
  };
  cache.set(cacheKey, abis);
  return abis;
}

function loadAbi(projectRoot: string, artifactPath: string): InterfaceAbi {
  const path = join(projectRoot, "out", artifactPath);
  if (!existsSync(path)) {
    throw new Error(`missing contract artifact ${path}; run the V2 setup/build step for this source before E2E scenarios`);
  }

  const artifact = JSON.parse(readFileSync(path, "utf8")) as { abi?: unknown };
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`contract artifact ${path} does not contain an ABI array`);
  }
  return artifact.abi as InterfaceAbi;
}
