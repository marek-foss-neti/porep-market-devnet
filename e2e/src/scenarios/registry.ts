import { readFileSync } from "node:fs";
import type { ScenarioContext } from "../runtime.js";
import { verifyCurioDevnet } from "../devnet/curio.js";
import { ensureActiveSectorFixture } from "../fixtures/activeSector.js";
import { runAccessControlGuards } from "./accessControlGuards.js";
import { runActivationLifecycleGuards } from "./activationLifecycleGuards.js";
import { runActivationPaddingBounds } from "./activationPaddingBounds.js";
import { runActorTokenGuards } from "./actorTokenGuards.js";
import { runBasicActivationFlow } from "./basicActivationFlow.js";
import { runCapacityExhaustion } from "./capacityExhaustion.js";
import { runClientFundsExhaustion } from "./clientFundsExhaustion.js";
import { runDataCapMalformedInput } from "./datacapMalformedInput.js";
import { runAdapterDisable } from "./adapterDisable.js";
import { runEvidenceAuthorityGuards } from "./evidenceAuthorityGuards.js";
import { runEvidenceNoClaimActivationGuard } from "./evidenceNoClaimActivationGuard.js";
import { runFullAvailableFlow } from "./fullAvailableFlow.js";
import { runMultiClaimEvidenceBatches } from "./multiClaimEvidenceBatches.js";
import { runNegativeActivationBeforeEvidence } from "./negativeActivationFlow.js";
import { runSettlementGuards } from "./settlementGuards.js";
import { runSharedClientMultiRailSettlement } from "./sharedClientMultiRailSettlement.js";
import { runProposalSmoke, runValidatorRailSmoke } from "./smokeFlows.js";
import { runDirectOnboardingNotification } from "./directOnboardingNotification.js";
import { runDirectOnboardingNotificationFailure } from "./directOnboardingNotificationFailure.js";
import { runDuplicateManifestLifecycle } from "./duplicateManifestLifecycle.js";
import { runSectorStatusActive, runSectorStatusNegative } from "./sectorStatus.js";
import { runUpgradeContinuity } from "./upgradeContinuity.js";
import { runTerminationSettlement } from "./terminationSettlement.js";
import { runCurioRestartReplay } from "./curioRestartReplay.js";
import { runBenchRetrieval } from "./benchRetrieval.js";
import { runBenchSealUnseal, runSealUnsealRoundtrip } from "./sealUnsealRoundtrip.js";
import {
  runBenchDeliverSealUnsealRetrieval,
  runDeliverSealUnsealRetrieval,
} from "./deliverSealUnsealRetrieval.js";
import {
  runAcceptedDealExpiration,
  runAcceptedDealRejection,
} from "./acceptedDealExits.js";
import { runDealTermination } from "./dealTermination.js";

export type ScenarioTag =
  | "benchmark"
  | "contract"
  | "curio"
  | "infra"
  | "sealing"
  | "upgrade"
  | "security";

export type ScenarioDefinition = {
  run: (context: ScenarioContext) => Promise<void>;
  tags: ScenarioTag[];
  timeoutMs: number;
  requiredContracts: string[];
  fixtures?: Array<"active-sector">;
  destructive?: boolean;
};

const MARKET_CONTRACTS = [
  "PoRepMarket",
  "SPRegistry",
  "ValidatorFactory",
  "ValidatorBeacon",
  "DataCapEvidenceAdapter",
  "FilecoinPay",
  "SLIOracle",
  "MetaAllocator",
  "MockUSDC",
] as const;
const CONTRACT_TIMEOUT_MS = 10 * 60_000;
const CURIO_TIMEOUT_MS = 2 * 60 * 60_000;

function contract(
  run: ScenarioDefinition["run"],
  tags: ScenarioTag[] = ["contract"],
): ScenarioDefinition {
  return {
    run,
    tags,
    timeoutMs: CONTRACT_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS],
  };
}

function sealing(
  run: ScenarioDefinition["run"],
  tags: ScenarioTag[] = ["curio", "sealing"],
): ScenarioDefinition {
  return {
    run,
    tags,
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS],
  };
}

function benchmark(run: ScenarioDefinition["run"]): ScenarioDefinition {
  return {
    run,
    tags: ["benchmark"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS],
  };
}

export const scenarioDefinitions: Record<string, ScenarioDefinition> = {
  "access-control-guards": contract(runAccessControlGuards, ["contract", "security"]),
  "accepted-deal-expiration": contract(runAcceptedDealExpiration, ["contract", "security"]),
  "accepted-deal-rejection": contract(runAcceptedDealRejection, ["contract", "security"]),
  "activation-lifecycle-guards": sealing(runActivationLifecycleGuards, ["curio", "sealing", "security"]),
  "activation-padding-bounds": contract(runActivationPaddingBounds, ["contract", "security"]),
  "actor-token-guards": contract(runActorTokenGuards, ["contract", "security"]),
  "basic-activation": sealing(runBasicActivationFlow),
  "capacity-exhaustion": contract(runCapacityExhaustion),
  "client-funds-exhaustion": sealing(runClientFundsExhaustion),
  "datacap-malformed-input": contract(runDataCapMalformedInput, ["contract", "security"]),
  "adapter-disable": {
    ...sealing(runAdapterDisable),
    destructive: true,
  },
  "bench-retrieval": benchmark(runBenchRetrieval),
  "bench-seal-unseal": benchmark(runBenchSealUnseal),
  "bench-deliver-seal-unseal-retrieval": benchmark(runBenchDeliverSealUnsealRetrieval),
  "deliver-seal-unseal-retrieval": sealing(runDeliverSealUnsealRetrieval),
  "direct-onboarding-notification": {
    run: runDirectOnboardingNotification,
    tags: ["curio", "sealing"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS, "NotificationReceiver"],
  },
  "direct-onboarding-notification-failure": {
    run: runDirectOnboardingNotificationFailure,
    tags: ["curio", "security"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS, "FailingNotificationReceiver"],
  },
  "duplicate-manifest-lifecycle": contract(runDuplicateManifestLifecycle, ["contract", "security"]),
  "curio-restart-replay": {
    run: runCurioRestartReplay,
    tags: ["curio", "sealing", "security"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS, "NotificationReceiver"],
  },
  "deal-termination": sealing(runDealTermination, ["curio", "sealing", "security"]),
  "evidence-authority-guards": sealing(runEvidenceAuthorityGuards, ["curio", "sealing", "security"]),
  "evidence-no-claim-activation-guard": contract(runEvidenceNoClaimActivationGuard, ["contract", "security"]),
  "full-available": sealing(runFullAvailableFlow),
  "multi-claim-evidence-batches": sealing(runMultiClaimEvidenceBatches),
  "negative-activation": contract(runNegativeActivationBeforeEvidence, ["contract", "security"]),
  "prepare-devnet": {
    run: verifyCurioDevnet,
    tags: ["curio", "infra"],
    timeoutMs: CONTRACT_TIMEOUT_MS,
    requiredContracts: [],
  },
  "proposal-smoke": contract(runProposalSmoke),
  "seal-unseal-roundtrip": sealing(runSealUnsealRoundtrip),
  "sector-status-active": {
    run: runSectorStatusActive,
    tags: ["curio", "sealing"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS, "SectorStatusInspector"],
    fixtures: ["active-sector"],
  },
  "sector-status-negative": {
    run: runSectorStatusNegative,
    tags: ["curio", "security"],
    timeoutMs: CONTRACT_TIMEOUT_MS,
    requiredContracts: ["SectorStatusInspector"],
  },
  "settlement-guards": sealing(runSettlementGuards, ["curio", "sealing", "security"]),
  "shared-client-multi-rail-settlement": sealing(runSharedClientMultiRailSettlement),
  "termination-settlement": sealing(runTerminationSettlement, ["curio", "sealing", "security"]),
  "validator-rail-smoke": contract(runValidatorRailSmoke),
  "upgrade-continuity": {
    run: runUpgradeContinuity,
    tags: ["upgrade"],
    timeoutMs: CURIO_TIMEOUT_MS,
    requiredContracts: [...MARKET_CONTRACTS],
  },
};

export const scenarioNames = Object.keys(scenarioDefinitions).sort();

export function resolveScenario(name: string): ScenarioDefinition {
  const scenario = scenarioDefinitions[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);
  return scenario;
}

export function assertScenarioPrerequisites(
  name: string,
  definition: ScenarioDefinition,
  deploymentRecordPath: string,
): void {
  const deployment = JSON.parse(readFileSync(deploymentRecordPath, "utf8")) as {
    contracts?: Record<string, unknown>;
  };
  const contracts = deployment.contracts ?? {};
  const missing = definition.requiredContracts.filter(
    (contract) => !Object.hasOwn(contracts, contract),
  );
  if (missing.length === 0) return;
  throw new Error(
    `scenario prerequisite failed: ${name} requires deployment contract${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
  );
}

export async function consumeScenarioFixtures(
  context: ScenarioContext,
  definition: ScenarioDefinition,
  activeSector: (context: ScenarioContext) => Promise<unknown> =
    ensureActiveSectorFixture,
): Promise<void> {
  for (const fixture of definition.fixtures ?? []) {
    if (fixture === "active-sector") await activeSector(context);
  }
}

export function resolveSuite(name: string): string[] {
  if (name === "full") {
    return scenarioNames.filter((scenario) =>
      !scenarioDefinitions[scenario]!.tags.includes("upgrade")
        && !scenarioDefinitions[scenario]!.tags.includes("benchmark")
        && !scenarioDefinitions[scenario]!.destructive
    );
  }
  if (name === "benchmark" || name === "contract" || name === "curio" || name === "security") {
    return scenarioNames.filter((scenario) =>
      scenarioDefinitions[scenario]!.tags.includes(name)
        && !scenarioDefinitions[scenario]!.destructive
    );
  }
  throw new Error(`unknown suite: ${name}`);
}
