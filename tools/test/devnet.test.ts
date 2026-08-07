import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRuntimeLock } from "../src/runtime-lock.js";
import {
  inspectCompose,
  inspectDevnetStatus,
  inspectRenderedCompose,
  validateLifecycleScript,
  type ComposeRuntimeContract,
} from "../src/devnet.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfilePath = join(repositoryRoot, "docker", "curio-all-in-one.Dockerfile");
const buildScriptPath = join(repositoryRoot, "scripts", "devnet-build.sh");
const sptoolPatchPath = join(
  repositoryRoot,
  "patches",
  "curio",
  "0001-sptool-mk20-notification-flags.patch",
);
const filecoinFfiPatchPath = join(
  repositoryRoot,
  "patches",
  "filecoin-ffi",
  "0001-zigzag-devnet-ffi.patch",
);
const filecoinFfiFvm4PathPatchPath = join(
  repositoryRoot,
  "patches",
  "filecoin-ffi",
  "0002-zigzag-devnet-fvm4-path.patch",
);
const fvmZigzagPatchPath = join(
  repositoryRoot,
  "patches",
  "fvm",
  "0001-zigzag-devnet-verifier.patch",
);
const lotusEntrypointPatchPath = join(
  repositoryRoot,
  "patches",
  "curio",
  "0002-lotus-entrypoint-zigzag-runtime-only.patch",
);
const curioZigzagUnsealPatchPath = join(
  repositoryRoot,
  "patches",
  "curio",
  "0003-zigzag-devnet-unseal.patch",
);
const commonScriptPath = join(repositoryRoot, "scripts", "devnet-common.sh");
const runtimeLockPath = join(repositoryRoot, "versions.lock.yaml");
const composePath = join(repositoryRoot, "docker", "compose.curio-devnet.yaml");
const upScriptPath = join(repositoryRoot, "scripts", "devnet-up.sh");
const downScriptPath = join(repositoryRoot, "scripts", "devnet-down.sh");
const resetScriptPath = join(repositoryRoot, "scripts", "devnet-reset.sh");
const logsScriptPath = join(repositoryRoot, "scripts", "devnet-logs.sh");
const statusScriptPath = join(repositoryRoot, "scripts", "devnet-status.sh");
const benchProofBackendsScriptPath = join(repositoryRoot, "scripts", "bench-proof-backends.sh");
const curioSourceCommit = "ce15c0c92209366a5523b803e9c159baa2ffb66a";
const derivedImageServices = [
  "lotus",
  "contracts-bootstrap",
  "lotus-miner",
  "curio",
  "piece-server",
  "indexer",
] as const;
const dockerSurfaceInputs = [
  "docker/curio-all-in-one.Dockerfile",
  "docker/lotus/Dockerfile",
  "docker/contracts-bootstrap/Dockerfile",
  "docker/lotus-miner/Dockerfile",
  "docker/curio/Dockerfile",
  "docker/piece-server/Dockerfile",
  "docker/indexer/Dockerfile",
  "patches/curio/0002-lotus-entrypoint-zigzag-runtime-only.patch",
  "patches/curio/0003-zigzag-devnet-unseal.patch",
  "patches/filecoin-ffi/0002-zigzag-devnet-fvm4-path.patch",
  "patches/fvm/0001-zigzag-devnet-verifier.patch",
] as const;

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sha256ZigzagApiSurface(rustFilProofsRoot: string): Promise<string> {
  const zigzagApi = join(rustFilProofsRoot, "filecoin-proofs", "src", "api", "zigzag.rs");
  const zigzagCaches = join(rustFilProofsRoot, "filecoin-proofs", "src", "caches.rs");
  const input = [
    "filecoin-proofs/src/api/zigzag.rs",
    await sha256File(zigzagApi),
    "filecoin-proofs/src/caches.rs",
    await sha256File(zigzagCaches),
    "",
  ].join("\n");

  return createHash("sha256").update(input).digest("hex");
}

async function sha256DockerSurface(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const path of dockerSurfaceInputs) {
    chunks.push(path, await sha256File(join(root, path)));
  }
  chunks.push("");
  return createHash("sha256").update(chunks.join("\n")).digest("hex");
}

test("Curio build exposes the existing MK20 notification fields through sptool", async () => {
  const [dockerfile, buildScript, patch] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(buildScriptPath, "utf8"),
    readFile(sptoolPatchPath, "utf8"),
  ]);

  assert.match(patch, /Name:\s+"notification-address"/);
  assert.match(patch, /Name:\s+"notification-payload"/);
  assert.match(patch, /address\.NewFromString\(cctx\.String\("notification-address"\)\)/);
  assert.match(patch, /hex\.DecodeString\(strings\.TrimPrefix/);
  assert.match(patch, /p\.DDOV1\.NotificationAddress = notificationAddress/);
  assert.match(patch, /p\.DDOV1\.NotificationPayload = notificationPayload/);
  assert.match(patch, /const maxSizePiece = 8 << 20/);
  assert.ok(patch.includes("+\tif d.MarketDealID == nil {\n+\t\treturn Ok, nil"));
  assert.match(dockerfile, /COPY --from=harness-overlay .*0001-sptool-mk20-notification-flags\.patch/);
  assert.match(dockerfile, /git apply --check .*sptool-mk20-notification-flags\.patch/);
  assert.match(buildScript, /--build-context "harness-overlay=\."/);
  assert.match(buildScript, /sources verify/);
});

test("devnet build overlays ZigZag filecoin-ffi for Curio sealing and Lotus verification", async () => {
  const [
    dockerfile,
    lotusDockerfile,
    buildScript,
    commonScript,
    compose,
    patch,
    filecoinFfiFvm4PathPatch,
    fvmZigzagPatch,
    lotusEntrypointPatch,
    curioZigzagUnsealPatch,
  ] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(join(repositoryRoot, "docker", "lotus", "Dockerfile"), "utf8"),
    readFile(buildScriptPath, "utf8"),
    readFile(commonScriptPath, "utf8"),
    readFile(composePath, "utf8"),
    readFile(filecoinFfiPatchPath, "utf8"),
    readFile(filecoinFfiFvm4PathPatchPath, "utf8"),
    readFile(fvmZigzagPatchPath, "utf8"),
    readFile(lotusEntrypointPatchPath, "utf8"),
    readFile(curioZigzagUnsealPatchPath, "utf8"),
  ]);

  assert.match(patch, /FIL_PROOFS_USE_ZIGZAG/);
  assert.match(patch, /zigzag_prove_from_cache/);
  assert.match(patch, /zigzag_pre_commit_phase1_with_replica_id/);
  assert.match(patch, /zigzag_verify_seal/);
  assert.match(filecoinFfiFvm4PathPatch, /fvm-4\.8\.2-zigzag/);
  assert.match(fvmZigzagPatch, /FIL_PROOFS_USE_ZIGZAG/);
  assert.match(fvmZigzagPatch, /read_zigzag_proof_sidecar/);
  assert.match(fvmZigzagPatch, /zigzag_verify_seal/);
  assert.match(curioZigzagUnsealPatch, /FIL_PROOFS_USE_ZIGZAG/);
  assert.match(curioZigzagUnsealPatch, /unseal skip sdr key for zigzag/);
  assert.match(curioZigzagUnsealPatch, /filecoinffi\.Unseal/);
  assert.match(curioZigzagUnsealPatch, /fr32\.NewPadWriter/);
  assert.match(commonScript, /DEVNET_RUST_FIL_PROOFS_SOURCE/);
  assert.match(buildScript, /zigzag_prove_from_cache/);
  assert.match(buildScript, /zigzag_pre_commit_phase1_with_replica_id/);
  assert.match(buildScript, /parameters\.json srs-inner-product\.json/);
  assert.match(buildScript, /--build-context "lotus-source=\$\{lotus_source_relative\}"/);
  assert.match(buildScript, /--build-context "rust-fil-proofs=\$\{rust_fil_proofs_source\}"/);
  assert.match(buildScript, /--build-context "harness-overlay=\."/);
  assert.match(commonScript, /devnet_docker_surface_sha256/);

  assert.match(dockerfile, /FROM scratch AS rust-fil-proofs-local/);
  assert.match(dockerfile, /COPY --from=rust-fil-proofs \/parameters\.json \/parameters\.json/);
  assert.match(dockerfile, /COPY --from=rust-fil-proofs \/srs-inner-product\.json \/srs-inner-product\.json/);
  assert.match(dockerfile, /COPY --from=rust-fil-proofs \/filecoin-proofs \/filecoin-proofs/);
  assert.match(dockerfile, /COPY --from=rust-fil-proofs-local \/ \/opt\/curio\/extern\/rust-fil-proofs/);
  assert.match(dockerfile, /COPY --from=rust-fil-proofs-local \/ \/opt\/lotus\/extern\/rust-fil-proofs/);
  assert.match(dockerfile, /0003-zigzag-devnet-unseal\.patch/);
  assert.match(dockerfile, /git apply --check .*curio-zigzag-devnet-unseal\.patch/);
  assert.match(dockerfile, /git apply --check --directory=extern\/filecoin-ffi .*filecoin-ffi-zigzag-devnet\.patch/);
  assert.match(dockerfile, /cargo fetch --manifest-path extern\/filecoin-ffi\/rust\/Cargo\.toml/);
  assert.match(dockerfile, /fvm-4\.8\.2-zigzag/);
  assert.match(dockerfile, /fvm-zigzag-devnet-verifier\.patch/);
  assert.match(dockerfile, /filecoin-ffi-zigzag-devnet-fvm4-path\.patch/);
  assert.match(dockerfile, /FROM \$\{GO_BUILDER_IMAGE\} AS lotus-builder/);
  assert.match(dockerfile, /COPY --from=lotus-source \/ \./);
  assert.match(dockerfile, /make debug-lotus debug-lotus-miner debug-lotus-seed debug-lotus-shed/);
  assert.match(dockerfile, /COPY --from=lotus-builder \/opt\/lotus\/lotus /);
  assert.doesNotMatch(dockerfile, /ENV[\s\S]*FIL_PROOFS_USE_ZIGZAG/);
  assert.match(lotusDockerfile, /0002-lotus-entrypoint-zigzag-runtime-only\.patch/);
  assert.match(lotusDockerfile, /git apply \/tmp\/lotus-entrypoint-zigzag-runtime-only\.patch/);
  assert.match(lotusEntrypointPatch, /env -u FIL_PROOFS_USE_ZIGZAG -u FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS/);
  assert.match(lotusEntrypointPatch, /without_zigzag_proofs lotus-seed .*pre-seal/);

  const lotusService = compose.match(/  lotus:\n[\s\S]*?\n  contracts-bootstrap:/)?.[0] ?? "";
  const lotusMinerService = compose.match(/  lotus-miner:\n[\s\S]*?\n  curio:/)?.[0] ?? "";
  const curioService = compose.match(/  curio:\n[\s\S]*?\n  yugabyte:/)?.[0] ?? "";
  assert.match(curioService, /FIL_PROOFS_USE_ZIGZAG=\$\{FIL_PROOFS_USE_ZIGZAG\}/);
  assert.match(curioService, /FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=\$\{FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS\}/);
  assert.match(lotusService, /FIL_PROOFS_USE_ZIGZAG=\$\{FIL_PROOFS_USE_ZIGZAG\}/);
  assert.doesNotMatch(lotusService, /FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS/);
  assert.doesNotMatch(lotusMinerService, /FIL_PROOFS_USE_ZIGZAG/);
});

test("devnet status accepts only complete semantic readiness evidence", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const provider = "t01001";
  const ready = {
    schemaVersion: 1,
    generatedAt: "2026-07-24T18:00:00Z",
    generation: "generation-one",
    build: {
      curioCommit: curioSourceCommit,
      lotusCommit: "154c0c3a46e92006008818bb06aaf959e2e705a9",
      platform: "linux/arm64",
    },
    proof: {
      backend: "zigzag",
      lotus: { FIL_PROOFS_USE_ZIGZAG: "1" },
      curio: {
        FIL_PROOFS_USE_ZIGZAG: "1",
        FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS: "1",
      },
    },
    compose: lock.runtime.services.map((service) => ({
      service,
      state: service === "contracts-bootstrap" ? "exited" : "running",
      health: service === "contracts-bootstrap" ? "" : "healthy",
      exitCode: service === "contracts-bootstrap" ? 0 : 0,
    })),
    chain: {
      chainId: "0x1df5e76",
      epoch: 250,
      networkVersion: 28,
      actorsVersion: 18,
      manifestCid: lock.network.actorsV18.manifestCid,
      minerActorCodeCid: lock.network.actorsV18.storageMinerActorCid,
    },
    miner: {
      provider,
      owner: "t3owner",
      worker: "t3worker",
      control: ["t3control"],
      sectorSize: 8_388_608,
    },
    curio: {
      commit: curioSourceCommit,
      apiReady: true,
      marketReady: true,
      databaseReady: true,
      taskCount: 2,
    },
  };

  const inspected = inspectDevnetStatus(JSON.stringify(ready), lock);
  assert.equal(inspected.ready, true);
  assert.equal(inspected.provider, provider);
  assert.equal(inspected.epoch, 250);

  for (const mutate of [
    (value: typeof ready) => { value.chain.chainId = "0x1"; },
    (value: typeof ready) => { value.chain.networkVersion = 27; },
    (value: typeof ready) => { value.chain.minerActorCodeCid = "bafkqaaa"; },
    (value: typeof ready) => { value.compose[0]!.health = "starting"; },
    (value: typeof ready) => { value.miner.provider = "t01000"; },
    (value: typeof ready) => { value.miner.sectorSize = 2_048; },
    (value: typeof ready) => { value.curio.marketReady = false; },
  ]) {
    const invalid = structuredClone(ready);
    mutate(invalid);
    assert.throws(() => inspectDevnetStatus(JSON.stringify(invalid), lock));
  }
});

test("public status command is bounded and reports a stopped project precisely", async () => {
  const justfile = await readFile(join(repositoryRoot, "justfile"), "utf8");
  const statusScript = await readFile(statusScriptPath, "utf8");
  const absoluteDeadline = statusScript.indexOf("command_deadline=");
  const initialRunningCheck = statusScript.indexOf('running="$(');
  assert.match(justfile, /status:\n\s+@bash scripts\/devnet-status\.sh/);
  assert.match(statusScript, /project is not running/);
  assert.match(statusScript, /--timeout-ms 30000/);
  assert.ok(absoluteDeadline >= 0 && absoluteDeadline < initialRunningCheck);
  assert.match(statusScript, /deadline=\$\(\(command_deadline - 65\)\)/);
  assert.match(statusScript, /diagnostic_timeout_ms/);
  assert.match(statusScript, /status_pause \|\| break/);
  assert.match(statusScript, /\.runtime\/devnet\/status\/latest\.json/);
  assert.match(statusScript, /Filecoin\.StateMinerInfo/);
  assert.match(statusScript, /ControlAddresses/);
  assert.match(statusScript, /127\.0\.0\.1:22310\/health/);
});

test("proof backend benchmark runner performs fresh isolated comparisons and aggregates evidence", async () => {
  const [justfile, script] = await Promise.all([
    readFile(join(repositoryRoot, "justfile"), "utf8"),
    readFile(benchProofBackendsScriptPath, "utf8"),
  ]);

  assert.match(justfile, /bench-proof-backends:\n\s+@bash scripts\/bench-proof-backends\.sh/);
  assert.match(script, /BENCH_BACKEND_ORDER:-zigzag,stacked/);
  assert.match(script, /BENCH_REPETITIONS:-1/);
  assert.match(script, /prewarm_zigzag_if_needed/);
  assert.match(script, /just reset zigzag/);
  assert.match(script, /just test-deliver-seal-unseal-retrieval active/);
  assert.match(script, /just reset "\$\{backend\}"/);
  assert.match(script, /just deploy/);
  assert.match(script, /just bench-deliver-seal-unseal-retrieval active/);
  assert.match(script, /proofParameterCacheStatus/);
  assert.match(script, /curioImageId/);
  assert.match(script, /dockerTotalMemoryBytes/);
  assert.match(script, /summary\.json/);
  assert.match(script, /Proof backend benchmark comparison/);
});

async function renderTaskThreeCompose(): Promise<{
  contract: ComposeRuntimeContract;
  rendered: string;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devnet-compose-render-"));
  const dataDirectory = join(fixtureRoot, ".runtime", "devnet", "data");
  const proofParametersDirectory = join(fixtureRoot, ".cache", "proof-parameters");
  const filecoinServicesSource = join(
    fixtureRoot,
    ".cache",
    "sources",
    "filecoin_services",
    "e485abae3f89775b3c9a0014c74a60ae9e98fe8c",
  );
  const multicall3Source = join(
    fixtureRoot,
    ".cache",
    "sources",
    "multicall3",
    "b667d67ecfa5361a81e8f110234ce242613b0012",
  );
  const imageNamespace = "porep-market-curio-devnet";
  const curioShortCommit = curioSourceCommit.slice(0, 12);
  const yugabyteImage =
    "yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8";
  const envPath = join(fixtureRoot, "compose.env");
  await writeFile(
    envPath,
    [
      `DEVNET_IMAGE_NAMESPACE=${imageNamespace}`,
      `DEVNET_CURIO_SHORT_COMMIT=${curioShortCommit}`,
      `DEVNET_DATA_DIR=${dataDirectory}`,
      "DEVNET_PROOF_BACKEND=stacked",
      `DEVNET_PROOF_PARAMETERS_DIR=${proofParametersDirectory}`,
      `DEVNET_FILECOIN_SERVICES_SOURCE=${filecoinServicesSource}`,
      `DEVNET_MULTICALL3_SOURCE=${multicall3Source}`,
      `DEVNET_YUGABYTE_IMAGE=${yugabyteImage}`,
      "FIL_PROOFS_USE_ZIGZAG=0",
      "FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=0",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(
    "env",
    [
      "-u",
      "DEVNET_DATA_DIR",
      "-u",
      "DEVNET_IMAGE_NAMESPACE",
      "docker",
      "compose",
      "--env-file",
      envPath,
      "--project-name",
      "porep-market-curio-devnet",
      "--file",
      composePath,
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVNET_DATA_DIR: "/tmp/hostile-data-override",
        DEVNET_IMAGE_NAMESPACE: "hostile-image-override",
      },
      timeout: 5_000,
    },
  );
  await rm(fixtureRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return {
    contract: {
      curioShortCommit,
      dataDirectory,
      filecoinServicesSource,
      filProofsUseZigZag: "0",
      filProofsZigZagGenerateMissingParams: "0",
      imageNamespace,
      multicall3Source,
      proofBackend: "stacked",
      proofParametersDirectory,
      yugabyteImage,
    },
    rendered: result.stdout,
  };
}

test("rendered compose inspector enforces the complete Task 3 contract", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { contract, rendered } = await renderTaskThreeCompose();
  const inspected = inspectRenderedCompose(rendered, lock, contract);

  assert.deepEqual(inspected.services, [...lock.runtime.services].sort());
  assert.equal(inspected.images.length, 7);
  assert.equal(inspected.ports.length, 13);
  assert.equal(inspected.mounts.length, 32);
  assert.deepEqual(inspected.healthyServices, [
    "curio",
    "indexer",
    "lotus",
    "lotus-miner",
    "piece-server",
    "yugabyte",
  ]);
  assert.deepEqual(inspected.completionServices, ["contracts-bootstrap"]);
});

test("rendered compose inspector rejects every reviewed counterexample", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { contract, rendered } = await renderTaskThreeCompose();
  const base = JSON.parse(rendered) as {
    services: Record<string, {
      image?: string;
      ports?: Array<{ published: string; target: number }>;
      volumes?: Array<{ read_only?: boolean; source: string; target: string }>;
    }>;
  };
  const mutate = (change: (fixture: typeof base) => void): string => {
    const fixture = structuredClone(base);
    change(fixture);
    return JSON.stringify(fixture);
  };
  const cases = [
    mutate((fixture) => {
      const lotusPort = fixture.services.lotus?.ports?.[0];
      assert.ok(lotusPort);
      lotusPort.target = 9999;
    }),
    mutate((fixture) => {
      fixture.services.lotus!.volumes!.push({
        source: "/tmp/outside-project",
        target: "/unexpected",
      });
    }),
    mutate((fixture) => {
      fixture.services.lotus!.ports![0]!.published =
        fixture.services.curio!.ports![0]!.published;
    }),
    mutate((fixture) => {
      fixture.services.curio!.image = "porep-market-curio-devnet/curio:mutable";
    }),
    mutate((fixture) => {
      fixture.services.curio!.ports!.pop();
    }),
    mutate((fixture) => {
      delete fixture.services.indexer;
    }),
    mutate((fixture) => {
      Object.assign(fixture.services.curio!, { container_name: "fixed-curio" });
    }),
  ];

  for (const [index, fixture] of cases.entries()) {
    assert.throws(
      () => inspectRenderedCompose(fixture, lock, contract),
      { name: "Error" },
      `counterexample ${index} was accepted`,
    );
  }
});

test("rendered compose inspector ignores harmless operational tuning", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { contract, rendered } = await renderTaskThreeCompose();
  const fixture = JSON.parse(rendered) as {
    services: Record<string, {
      logging?: unknown;
      restart?: string;
      volumes?: Array<{ read_only?: boolean; source: string; target: string }>;
    }>;
  };
  fixture.services.curio!.logging = { driver: "local", options: { "max-size": "10m" } };
  fixture.services.curio!.restart = "unless-stopped";
  const sourceMount = fixture.services["contracts-bootstrap"]!.volumes!.find(
    (volume) => volume.target === "/opt/local-src/filecoin-services",
  );
  assert.ok(sourceMount);
  delete sourceMount.read_only;
  assert.doesNotThrow(() =>
    inspectRenderedCompose(JSON.stringify(fixture), lock, contract)
  );
});

test("typed CLI accepts the rendered Compose contract and up invokes it before start", async () => {
  const { contract, rendered } = await renderTaskThreeCompose();
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devnet-compose-cli-"));
  const envPath = join(fixtureRoot, "compose.env");
  try {
    await writeFile(
      envPath,
      [
        `DEVNET_IMAGE_NAMESPACE=${contract.imageNamespace}`,
        `DEVNET_CURIO_SHORT_COMMIT=${contract.curioShortCommit}`,
        `DEVNET_DATA_DIR=${contract.dataDirectory}`,
        `DEVNET_PROOF_BACKEND=${contract.proofBackend}`,
        `DEVNET_PROOF_PARAMETERS_DIR=${contract.proofParametersDirectory}`,
        `DEVNET_FILECOIN_SERVICES_SOURCE=${contract.filecoinServicesSource}`,
        `DEVNET_MULTICALL3_SOURCE=${contract.multicall3Source}`,
        `DEVNET_YUGABYTE_IMAGE=${contract.yugabyteImage}`,
        `FIL_PROOFS_USE_ZIGZAG=${contract.filProofsUseZigZag}`,
        `FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=${contract.filProofsZigZagGenerateMissingParams}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync(
      "npm",
      [
        "--prefix",
        join(repositoryRoot, "tools"),
        "run",
        "cli",
        "--",
        "devnet",
        "compose",
        "inspect",
        envPath,
      ],
      {
        encoding: "utf8",
        input: rendered,
        timeout: 5_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /7 services, 7 images, 13 ports, 32 mounts/);

    const up = await readFile(upScriptPath, "utf8");
    const inspection = up.indexOf("devnet_inspect_rendered_compose");
    const startup = up.indexOf("devnet_compose up --detach");
    assert.ok(inspection >= 0);
    assert.ok(startup > inspection);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function createLifecycleFixture(): Promise<{
  commandLog: string;
  fixtureBase: string;
  root: string;
  stubBin: string;
}> {
  const fixtureBase = await mkdtemp(join(tmpdir(), "devnet-lifecycle-"));
  const root = join(fixtureBase, "repository");
  const stubBin = join(fixtureBase, "bin");
  const commandLog = join(fixtureBase, "commands.log");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docker"), { recursive: true });
  await mkdir(join(root, "patches", "filecoin-ffi"), { recursive: true });
  await mkdir(join(root, "patches", "curio"), { recursive: true });
  await mkdir(join(root, "patches", "fvm"), { recursive: true });
  for (const service of derivedImageServices) {
    await mkdir(join(root, "docker", service), { recursive: true });
  }
  await mkdir(
    join(fixtureBase, "rust-fil-proofs", "filecoin-proofs", "src", "api"),
    { recursive: true },
  );
  await mkdir(stubBin, { recursive: true });
  await writeFile(
    join(root, "patches", "filecoin-ffi", "0001-zigzag-devnet-ffi.patch"),
    "fixture ZigZag filecoin-ffi patch\n",
    "utf8",
  );
  await writeFile(
    join(root, "patches", "filecoin-ffi", "0002-zigzag-devnet-fvm4-path.patch"),
    "fixture ZigZag filecoin-ffi FVM4 path patch\n",
    "utf8",
  );
  await writeFile(
    join(root, "patches", "curio", "0002-lotus-entrypoint-zigzag-runtime-only.patch"),
    "fixture Lotus ZigZag runtime-only patch\n",
    "utf8",
  );
  await writeFile(
    join(root, "patches", "curio", "0003-zigzag-devnet-unseal.patch"),
    "fixture Curio ZigZag unseal patch\n",
    "utf8",
  );
  await writeFile(
    join(root, "patches", "fvm", "0001-zigzag-devnet-verifier.patch"),
    "fixture ZigZag FVM verifier patch\n",
    "utf8",
  );
  for (const path of dockerSurfaceInputs.filter((path) => path.startsWith("docker/"))) {
    await writeFile(join(root, path), "FROM scratch\n", "utf8");
  }
  await writeFile(
    join(fixtureBase, "rust-fil-proofs", "filecoin-proofs", "src", "api", "zigzag.rs"),
    "pub fn zigzag_prove_from_cache() {}\npub fn zigzag_pre_commit_phase1_with_replica_id() {}\n",
    "utf8",
  );
  await writeFile(
    join(fixtureBase, "rust-fil-proofs", "filecoin-proofs", "src", "caches.rs"),
    "pub fn get_zigzag_params() {}\npub fn get_zigzag_verifying_key() {}\n",
    "utf8",
  );
  for (const name of [
    "devnet-common.sh",
    "devnet-up.sh",
    "devnet-down.sh",
    "devnet-reset.sh",
    "devnet-logs.sh",
  ]) {
    await cp(join(repositoryRoot, "scripts", name), join(root, "scripts", name));
  }
  await writeFile(join(root, "docker", "compose.curio-devnet.yaml"), "services: {}\n", "utf8");
  const dockerStub = join(stubBin, "docker");
  const nodeStub = join(stubBin, "node");
  await writeFile(
    dockerStub,
    `#!/usr/bin/env bash
printf 'docker' >> "$DEVNET_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$DEVNET_TEST_COMMAND_LOG"
printf '\\n' >> "$DEVNET_TEST_COMMAND_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then
  case "$*" in
    *"{{.Id}}"*) printf '%s\\n' "\${DEVNET_TEST_IMAGE_ID:-sha256:fixture}" ;;
    *"io.porep-market.curio.commit"*) printf '%s\\n' "\${DEVNET_TEST_CURIO_COMMIT:-}" ;;
    *"io.porep-market.lotus.commit"*) printf '%s\\n' "\${DEVNET_TEST_LOTUS_COMMIT:-}" ;;
    *"io.porep-market.blst.commit"*) printf '%s\\n' "\${DEVNET_TEST_BLST_COMMIT:-}" ;;
    *"io.porep-market.dockerfile.sha256"*) printf '%s\\n' "\${DEVNET_TEST_DOCKERFILE_HASH:-}" ;;
    *"io.porep-market.zigzag.filecoin-ffi.patch.sha256"*) printf '%s\\n' "\${DEVNET_TEST_ZIGZAG_PATCH_HASH:-}" ;;
    *"io.porep-market.zigzag.rust-fil-proofs.api.sha256"*) printf '%s\\n' "\${DEVNET_TEST_ZIGZAG_API_HASH:-}" ;;
    *"{{.Os}}/{{.Architecture}}"*) printf '%s\\n' "linux/arm64" ;;
    *"{{json .Config.Volumes}}"*)
      if [[ "$3" == yugabytedb/* ]]; then
        printf '%s\\n' '{"/mnt/disk0":{},"/mnt/disk1":{}}'
      else
        printf '%s\\n' null
      fi
      ;;
  esac
  exit 0
fi
if [[ "$1" == compose && " $* " == *" config "* ]]; then
  printf '%s\\n' '{"name":"fixture","services":{}}'
  exit 0
fi
if [[ " $* " == *" logs "* ]]; then printf 'fixture final log\\n'; fi
`,
    "utf8",
  );
  await writeFile(
    nodeStub,
    `#!/usr/bin/env bash
printf 'node' >> "$DEVNET_TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$DEVNET_TEST_COMMAND_LOG"
printf '\\n' >> "$DEVNET_TEST_COMMAND_LOG"
while (($#)); do
  if [[ "$1" == -- ]]; then shift; exec "$@"; fi
  shift
done
exit 64
`,
    "utf8",
  );
  await chmod(dockerStub, 0o755);
  await chmod(nodeStub, 0o755);
  return { commandLog, fixtureBase, root: await realpath(root), stubBin };
}

async function writeOwnershipMarker(root: string): Promise<void> {
  const runtime = join(root, ".runtime", "devnet");
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, "ownership.marker"),
    `repository=${root}\nproject=porep-market-curio-devnet\n`,
    "utf8",
  );
}

test("runtime preparation rejects symlinks at every writable path before outside writes", async () => {
  const targets: Array<{ kind: "directory" | "file"; path: string }> = [
    { kind: "directory", path: "." },
    { kind: "directory", path: ".runtime" },
    { kind: "directory", path: ".runtime/devnet" },
    { kind: "directory", path: ".runtime/devnet/data" },
    ...[
      "lotus",
      "lotus-miner",
      "curio",
      "piece-server",
      "indexer",
      "contracts",
      "genesis",
      "yugabyte",
      "yugabyte-disk0",
      "yugabyte-disk1",
    ].map((name) => ({ kind: "directory" as const, path: `.runtime/devnet/data/${name}` })),
    { kind: "file", path: ".runtime/devnet/compose.env" },
    { kind: "file", path: ".runtime/devnet/ownership.marker" },
    { kind: "directory", path: ".runtime/devnet/logs" },
    { kind: "directory", path: ".runtime/devnet/status" },
    { kind: "directory", path: ".runtime/deployments" },
    { kind: "directory", path: ".runtime/verification-backups" },
    { kind: "directory", path: ".cache" },
    { kind: "directory", path: ".cache/proof-parameters" },
    { kind: "file", path: ".runtime/devnet/data/piece-server/.synapse-sdk.ready" },
  ];

  for (const target of targets) {
    const fixture = await createLifecycleFixture();
    const outside = join(fixture.fixtureBase, "outside");
    const outsideTarget = join(outside, target.kind === "directory" ? "directory" : "file");
    await mkdir(outside, { recursive: true });
    if (target.kind === "directory") {
      await mkdir(outsideTarget);
    } else {
      await writeFile(outsideTarget, "outside sentinel\n", "utf8");
    }
    const before = target.kind === "directory"
      ? await readdir(outsideTarget)
      : await readFile(outsideTarget, "utf8");

    let scriptPath = join(fixture.root, "scripts", "devnet-common.sh");
    if (target.path === ".") {
      const linkedRoot = join(fixture.fixtureBase, "repository-link");
      await symlink(fixture.root, linkedRoot, "dir");
      scriptPath = join(linkedRoot, "scripts", "devnet-common.sh");
    } else {
      const targetPath = join(fixture.root, target.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await symlink(outsideTarget, targetPath, target.kind === "directory" ? "dir" : "file");
    }

    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_prepare_runtime',
        "devnet-path-fixture",
        scriptPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${target.path} symlink was accepted`);
    assert.match(result.stderr, /error: .*symbolic|error: .*real path/);
    const after = target.kind === "directory"
      ? await readdir(outsideTarget)
      : await readFile(outsideTarget, "utf8");
    assert.deepEqual(after, before, `${target.path} wrote outside the fixture repository`);
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("runtime preparation creates the exact tree and never overwrites a mismatched marker", async () => {
  const fixture = await createLifecycleFixture();
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_prepare_runtime',
        "devnet-prepare-fixture",
        join(fixture.root, "scripts", "devnet-common.sh"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const path of [
      ".runtime",
      ".runtime/devnet",
      ".runtime/devnet/data",
      ".runtime/devnet/logs",
      ".cache",
      ".cache/proof-parameters",
      ...[
        "lotus",
        "lotus-miner",
        "curio",
        "piece-server",
        "indexer",
        "contracts",
        "genesis",
        "yugabyte",
        "yugabyte-disk0",
        "yugabyte-disk1",
      ].map((name) => `.runtime/devnet/data/${name}`),
    ]) {
      assert.equal((await lstat(join(fixture.root, path))).isDirectory(), true, path);
    }
    assert.equal(
      await readFile(join(fixture.root, ".runtime", "devnet", "ownership.marker"), "utf8"),
      `repository=${fixture.root}\nproject=porep-market-curio-devnet\n`,
    );
    assert.match(
      await readFile(join(fixture.root, ".runtime", "devnet", "generation"), "utf8"),
      /^generation-[0-9]{8}T[0-9]{6}Z-[0-9]+\n$/,
    );
    assert.equal(
      await readFile(
        join(fixture.root, ".runtime", "devnet", "data", "piece-server", ".synapse-sdk.ready"),
        "utf8",
      ),
      "",
    );

    const marker = join(fixture.root, ".runtime", "devnet", "ownership.marker");
    const mismatch = `repository=${fixture.root}\nproject=porep-market-curio-devnet\nextra=forbidden\n`;
    await writeFile(marker, mismatch, "utf8");
    const rejected = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_prepare_runtime',
        "devnet-marker-fixture",
        join(fixture.root, "scripts", "devnet-common.sh"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ownership marker mismatch/);
    assert.equal(await readFile(marker, "utf8"), mismatch);

    const trailingBlank = `repository=${fixture.root}\nproject=porep-market-curio-devnet\n\n`;
    await writeFile(marker, trailingBlank, "utf8");
    const blankRejected = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_prepare_runtime',
        "devnet-marker-blank-fixture",
        join(fixture.root, "scripts", "devnet-common.sh"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(blankRejected.status, 0);
    assert.match(blankRejected.stderr, /ownership marker mismatch/);
    assert.equal(await readFile(marker, "utf8"), trailingBlank);
  } finally {
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("up requires lsof before its first runtime write", async () => {
  const fixture = await createLifecycleFixture();
  try {
    const result = spawnSync(
      "bash",
      [join(fixture.root, "scripts", "devnet-up.sh")],
      {
        encoding: "utf8",
        env: {
          DEVNET_TEST_COMMAND_LOG: fixture.commandLog,
          PATH: `${fixture.stubBin}:/bin:/usr/bin`,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /error: required command not found: lsof/);
    await assert.rejects(lstat(join(fixture.root, ".runtime")), { code: "ENOENT" });
  } finally {
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("up fixture writes only the validated tree and starts only after typed rendered inspection", async () => {
  const fixture = await createLifecycleFixture();
  const curioCommit = curioSourceCommit;
  const lotusCommit = "1".repeat(40);
  const blstCommit = "b".repeat(40);
  const imageId = `sha256:${"d".repeat(64)}`;
  try {
    await writeFile(join(fixture.root, "docker", "curio-all-in-one.Dockerfile"), "FROM scratch\n", "utf8");
    const dockerfileHash = await sha256DockerSurface(fixture.root);
    const zigzagPatchHash = await sha256File(
      join(fixture.root, "patches", "filecoin-ffi", "0001-zigzag-devnet-ffi.patch"),
    );
    const zigzagApiHash = await sha256ZigzagApiSurface(
      join(dirname(fixture.root), "rust-fil-proofs"),
    );
    const buildDirectory = join(fixture.root, ".runtime", "devnet", "build");
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(
      join(buildDirectory, "images.json"),
      `${JSON.stringify({
        blstCommit,
        curioCommit,
        dockerfileSha256: dockerfileHash,
        images: ["curio-all-in-one", ...derivedImageServices].map((name) => ({
          id: imageId,
          reference: `porep-market-curio-devnet/${name}:${curioCommit.slice(0, 12)}`,
        })),
        lotusCommit,
        namespace: "porep-market-curio-devnet",
        platform: "linux/arm64",
        schemaVersion: 1,
        tag: curioCommit.slice(0, 12),
        zigzagFilecoinFfiPatchSha256: zigzagPatchHash,
        zigzagRustFilProofsApiSha256: zigzagApiHash,
      }, null, 2)}\n`,
      "utf8",
    );
    const npmStub = join(fixture.stubBin, "npm");
    const lsofStub = join(fixture.stubBin, "lsof");
    await writeFile(
      npmStub,
      `#!/usr/bin/env bash
if [[ " $* " == *" sources verify "* ]]; then
  printf 'curio\\t/fixture\\t${curioCommit}\\t${curioCommit}\\tdetached\\tclean\\t\\n'
  printf 'lotus\\t/fixture\\t${lotusCommit}\\t${lotusCommit}\\tdetached\\tclean\\t\\n'
  printf 'blst\\t/fixture\\t${blstCommit}\\t${blstCommit}\\tdetached\\tclean\\t\\n'
  printf 'filecoin_services\\t/fixture\\te485abae3f89775b3c9a0014c74a60ae9e98fe8c\\te485abae3f89775b3c9a0014c74a60ae9e98fe8c\\tdetached\\tclean\\t\\n'
  printf 'multicall3\\t/fixture\\tb667d67ecfa5361a81e8f110234ce242613b0012\\tb667d67ecfa5361a81e8f110234ce242613b0012\\tdetached\\tclean\\t\\n'
  exit 0
fi
if [[ " $* " == *" devnet compose inspect "* ]]; then
  cat >/dev/null
  printf '7 services, 7 images, 13 ports, 32 mounts\\n'
  exit 0
fi
exit 65
`,
      "utf8",
    );
    await writeFile(lsofStub, "#!/usr/bin/env bash\nexit 1\n", "utf8");
    await chmod(npmStub, 0o755);
    await chmod(lsofStub, 0o755);

    const result = spawnSync(
      "bash",
      [join(fixture.root, "scripts", "devnet-up.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEVNET_DATA_DIR: "/tmp/hostile-data",
          DEVNET_IMAGE_NAMESPACE: "hostile-images",
          DEVNET_TEST_BLST_COMMIT: blstCommit,
          DEVNET_TEST_COMMAND_LOG: fixture.commandLog,
          DEVNET_TEST_CURIO_COMMIT: curioCommit,
          DEVNET_TEST_DOCKERFILE_HASH: dockerfileHash,
          DEVNET_TEST_IMAGE_ID: imageId,
          DEVNET_TEST_LOTUS_COMMIT: lotusCommit,
          DEVNET_TEST_ZIGZAG_API_HASH: zigzagApiHash,
          DEVNET_TEST_ZIGZAG_PATCH_HASH: zigzagPatchHash,
          PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const composeEnvironment = await readFile(
      join(fixture.root, ".runtime", "devnet", "compose.env"),
      "utf8",
    );
    assert.match(composeEnvironment, new RegExp(`DEVNET_DATA_DIR=${fixture.root}/\\.runtime/devnet/data`));
    assert.match(composeEnvironment, /DEVNET_IMAGE_NAMESPACE=porep-market-curio-devnet/);
    assert.match(composeEnvironment, /DEVNET_PROOF_BACKEND=stacked/);
    assert.match(composeEnvironment, /FIL_PROOFS_USE_ZIGZAG=0/);
    assert.match(composeEnvironment, /FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=0/);
    assert.doesNotMatch(composeEnvironment, /hostile/);
    assert.equal(
      await readFile(
        join(fixture.root, ".runtime", "devnet", "data", "piece-server", ".synapse-sdk.ready"),
        "utf8",
      ),
      "",
    );

    const commands = await readFile(fixture.commandLog, "utf8");
    const renderedInspection = commands.indexOf("<config> <--format> <json>");
    const start = commands.indexOf("<up> <--detach>");
    assert.ok(renderedInspection >= 0, commands);
    assert.ok(start > renderedInspection, commands);
    assert.equal((commands.match(/<--project-name> <porep-market-curio-devnet>/g) ?? []).length, 4);
    assert.doesNotMatch(commands, /hostile/);
  } finally {
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("port preflight detects collisions on every one of the 13 locked host ports", async () => {
  const ports = [
    2234, 22345, 22300, 22310, 24701, 22320, 25433,
    29042, 25434, 23000, 23001, 23002, 23003,
  ];
  for (const port of ports) {
    const fixture = await createLifecycleFixture();
    const lsofStub = join(fixture.stubBin, "lsof");
    await writeFile(
      lsofStub,
      `#!/usr/bin/env bash
[[ " $* " == *"-iTCP:${port}"* ]]
`,
      "utf8",
    );
    await chmod(lsofStub, 0o755);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_check_ports',
        "devnet-port-fixture",
        join(fixture.root, "scripts", "devnet-common.sh"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.notEqual(result.status, 0, `port ${port} collision was accepted`);
    assert.match(result.stderr, new RegExp(`required host port is already listening: ${port}`));
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("up port preflight permits ports already owned by this Compose project", async () => {
  const fixture = await createLifecycleFixture();
  const lsofStub = join(fixture.stubBin, "lsof");
  try {
    await writeFile(lsofStub, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(lsofStub, 0o755);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_compose() { printf "existing-container\\n"; }; devnet_check_start_ports',
        "devnet-owned-port-fixture",
        join(fixture.root, "scripts", "devnet-common.sh"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("reset keeps bounded evidence and deletes disposable chain state", async () => {
  const fixture = await createLifecycleFixture();
  try {
    await writeOwnershipMarker(fixture.root);
    for (const path of [
      ".runtime/devnet/data/lotus",
      ".runtime/devnet/logs",
      ".runtime/devnet/status",
      ".runtime/deployments",
      ".runtime/devnet/build",
      ".cache/proof-parameters",
      ".cache/sources/curio",
    ]) {
      await mkdir(join(fixture.root, path), { recursive: true });
    }
    await writeFile(join(fixture.root, ".runtime/devnet/data/lotus/state"), "state\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/devnet/logs/old.log"), "old log\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/devnet/status/latest.json"), "{}\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/deployments/active.json"), "{}\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/devnet/compose.env"), "fixture=true\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/devnet/generation"), "generation-one\n", "utf8");
    await writeFile(join(fixture.root, ".runtime/devnet/build/images.json"), "build-cache\n", "utf8");
    await writeFile(join(fixture.root, ".cache/proof-parameters/parameter"), "proof-cache\n", "utf8");
    await writeFile(join(fixture.root, ".cache/sources/curio/source"), "source-cache\n", "utf8");

    const result = spawnSync(
      "bash",
      [join(fixture.root, "scripts", "devnet-reset.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEVNET_TEST_COMMAND_LOG: fixture.commandLog,
          PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = await readdir(join(fixture.root, ".runtime", "reset-evidence"));
    assert.equal(evidence.length, 1);
    const resetEvidence = join(fixture.root, ".runtime", "reset-evidence", evidence[0]!);
    assert.match(await readFile(join(resetEvidence, "final-logs.txt"), "utf8"), /fixture final log/);
    assert.equal(await readFile(join(resetEvidence, "latest.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(resetEvidence, "active.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(resetEvidence, "generation"), "utf8"), "generation-one\n");
    await assert.rejects(
      lstat(join(fixture.root, ".runtime", "verification-backups")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      lstat(join(fixture.root, ".runtime/devnet/data/lotus/state")),
      { code: "ENOENT" },
    );

    for (const stale of [
      ".runtime/devnet/status",
      ".runtime/devnet/compose.env",
      ".runtime/deployments/active.json",
    ]) {
      await assert.rejects(lstat(join(fixture.root, stale)), { code: "ENOENT" });
    }
    assert.match(
      await readFile(join(fixture.root, ".runtime/devnet/generation"), "utf8"),
      /^generation-[0-9]{8}T[0-9]{6}Z-[0-9]+\n$/,
    );
    assert.equal(await readFile(join(fixture.root, ".runtime/devnet/build/images.json"), "utf8"), "build-cache\n");
    assert.equal(await readFile(join(fixture.root, ".cache/proof-parameters/parameter"), "utf8"), "proof-cache\n");
    assert.equal(await readFile(join(fixture.root, ".cache/sources/curio/source"), "utf8"), "source-cache\n");
    assert.equal((await lstat(join(fixture.root, ".runtime/devnet/data"))).isDirectory(), true);
    assert.equal((await lstat(join(fixture.root, ".runtime/devnet/logs"))).isDirectory(), true);

    const commands = await readFile(fixture.commandLog, "utf8");
    assert.equal((commands.match(/^node /gm) ?? []).length, 2);
    assert.match(commands, /node .*<--timeout-ms> <30000>.*docker <compose>/s);
    assert.match(commands, /node .*<--timeout-ms> <120000>.*docker <compose>/s);
    assert.match(
      commands,
      /docker <compose> <--env-file> .*<--project-name> <porep-market-curio-devnet> .*<logs> <--tail> <300>/,
    );
    assert.match(
      commands,
      /docker <compose> <--env-file> .*<--project-name> <porep-market-curio-devnet> .*<down> <--volumes> <--remove-orphans>/,
    );
    assert.doesNotMatch(commands, /--rmi|system prune|porep-market(?!-curio-devnet)/);
  } finally {
    await rm(fixture.fixtureBase, { recursive: true, force: true });
  }
});

test("compose renders exactly the locked services and project-owned mounts", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const compose = await readFile(composePath, "utf8");
  const inspected = inspectCompose(compose, lock);

  assert.deepEqual(inspected.services, [...lock.runtime.services].sort());
  assert.deepEqual(inspected.hostPorts, Object.values(lock.runtime.ports).map((port) => port.host).sort((a, b) => a - b));
  assert.equal(inspected.hasContainerNames, false);
  assert.equal(inspected.hasStaticNetworkIdentity, false);
  assert.equal(inspected.hasAnonymousVolumes, false);
  assert.equal(inspected.hasUnsafeMount, false);
  assert.equal(inspected.hasSynapseDisabledMarker, true);
});

test("compose inspector rejects a macOS home-directory mount", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const source = await readFile(composePath, "utf8");
  const unsafe = source.replace(
    "${DEVNET_DATA_DIR}/lotus:/var/lib/lotus:rw",
    `/${"Users"}/fixture/lotus:/var/lib/lotus:rw`,
  );

  assert.equal(inspectCompose(unsafe, lock).hasUnsafeMount, true);
});

test("compose supplies the pinned piece-server ready marker at its hardcoded path", async () => {
  const compose = await readFile(composePath, "utf8");
  const pinnedEntrypoint = await readFile(
    join(repositoryRoot, ".cache", "sources", "curio", "ce15c0c92209366a5523b803e9c159baa2ffb66a", "docker", "piece-server", "entrypoint.sh"),
    "utf8",
  );

  assert.match(pinnedEntrypoint, /SYNAPSE_SDK_READY_FILE="\/var\/lib\/curio-client\/\.synapse-sdk\.ready"/);
  assert.match(compose, /\.synapse-sdk\.ready:\/var\/lib\/curio-client\/\.synapse-sdk\.ready:ro/);
});

test("compose gives persistent Yugabyte state a stable advertised address", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.match(compose, /--advertise_address=yugabyte/);
});

test("startup preflight validates all pinned build identity labels and Yugabyte volume targets", async () => {
  const common = await readFile(commonScriptPath, "utf8");
  for (const label of ["io.porep-market.curio.commit", "io.porep-market.lotus.commit", "io.porep-market.blst.commit", "io.porep-market.dockerfile.sha256"]) {
    assert.match(common, new RegExp(label.replaceAll(".", "\\.")));
  }
  assert.match(common, /yugabyte-disk0/);
  assert.match(common, /yugabyte-disk1/);
});

test("runtime ownership marker binds the canonical repository path and project", async () => {
  const common = await readFile(commonScriptPath, "utf8");
  assert.match(common, /repository=/);
  assert.match(common, /project=/);
  assert.match(common, /devnet_require_ownership_marker/);
});

test("reset archives active deployment, status, generated environment, and generation evidence", async () => {
  const reset = await readFile(resetScriptPath, "utf8");
  assert.match(reset, /\.runtime\/deployments/);
  assert.match(reset, /DEVNET_RUNTIME_DIR\}\/status/);
  assert.match(reset, /DEVNET_COMPOSE_ENV/);
  assert.match(reset, /DEVNET_RUNTIME_DIR\}\/generation/);
});

test("lifecycle scripts retain project and reset boundaries", async () => {
  const scripts = await Promise.all([upScriptPath, downScriptPath, resetScriptPath, logsScriptPath].map((path) => readFile(path, "utf8")));
  const result = validateLifecycleScript(scripts.join("\n"));

  assert.equal(result.usesOnlyProjectCompose, true);
  assert.equal(result.hasDestructiveDownOnlyInReset, true);
  assert.equal(result.rejectsUnsafeResetPaths, true);
  assert.equal(result.allowlistsLogServices, true);
  assert.equal(result.hasForbiddenCleanup, false);
});

interface DockerfileInstruction {
  arguments: string;
  name: string;
}

function parseDockerfileInstructions(dockerfile: string): DockerfileInstruction[] {
  const logicalLines: string[] = [];
  let current = "";
  for (const sourceLine of dockerfile.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    current = current === "" ? line : `${current} ${line}`;
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    logicalLines.push(current);
    current = "";
  }
  if (current !== "") logicalLines.push(current);

  return logicalLines.map((line) => {
    const separator = line.search(/\s/);
    if (separator === -1) return { arguments: "", name: line.toUpperCase() };
    return {
      arguments: line.slice(separator).trim(),
      name: line.slice(0, separator).toUpperCase(),
    };
  });
}

async function readBuildFiles(): Promise<{
  buildScript: string;
  commonScript: string;
  dockerfile: string;
}> {
  const [buildScript, commonScript, dockerfile] = await Promise.all([
    readFile(buildScriptPath, "utf8"),
    readFile(commonScriptPath, "utf8"),
    readFile(dockerfilePath, "utf8"),
  ]);
  return { buildScript, commonScript, dockerfile };
}

test("devnet build uses only immutable Docker and source inputs", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { buildScript, dockerfile } = await readBuildFiles();
  const productionText = `${dockerfile}\n${buildScript}`;

  assert.doesNotMatch(
    productionText,
    /(?:\blatest\b|@master\b|@main\b|foundryup|nodesource|git\s+clone|git\s+submodule\s+update)/i,
  );
  for (const argument of [
    "LOTUS_TEST_IMAGE",
    "GO_BUILDER_IMAGE",
    "RUST_TOOLCHAIN_IMAGE",
    "UBUNTU_RUNTIME_IMAGE",
    "NODE_RUNTIME_IMAGE",
    "FOUNDRY_IMAGE",
  ]) {
    assert.match(dockerfile, new RegExp(`ARG ${argument}\\b`));
    assert.match(dockerfile, new RegExp(`FROM \\\${${argument}}(?:\\s|$)`));
  }
  for (const imageName of [
    "lotus_devnet",
    "go_builder",
    "rust_toolchain",
    "ubuntu_runtime",
    "node_runtime",
    "foundry",
  ] as const) {
    assert.match(buildScript, new RegExp(`${imageName}_image_reference`));
    assert.match(lock.images[imageName].resolvedReference, /@sha256:[0-9a-f]{64}$/);
  }
});

test("devnet build declares every base-image argument once before the first FROM", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const lock = await loadRuntimeLock(runtimeLockPath);
  const instructions = parseDockerfileInstructions(dockerfile);
  const firstFrom = instructions.findIndex((instruction) => instruction.name === "FROM");
  assert.ok(firstFrom >= 0);

  const expectedArguments = {
    LOTUS_TEST_IMAGE: lock.images.lotus_devnet.resolvedReference,
    RUST_TOOLCHAIN_IMAGE: lock.images.rust_toolchain.resolvedReference,
    GO_BUILDER_IMAGE: lock.images.go_builder.resolvedReference,
    NODE_RUNTIME_IMAGE: lock.images.node_runtime.resolvedReference,
    FOUNDRY_IMAGE: lock.images.foundry.resolvedReference,
    UBUNTU_RUNTIME_IMAGE: lock.images.ubuntu_runtime.resolvedReference,
  };
  for (const [argumentName, expectedReference] of Object.entries(expectedArguments)) {
    const declarations = instructions
      .map((instruction, index) => ({ index, instruction }))
      .filter(({ instruction }) =>
        instruction.name === "ARG"
        && new RegExp(`^${argumentName}(?:=|$)`).test(instruction.arguments));
    assert.equal(declarations.length, 1, `${argumentName} must be declared exactly once`);
    assert.ok(
      declarations[0] !== undefined && declarations[0].index < firstFrom,
      `${argumentName} must be declared before the first FROM`,
    );
    assert.equal(
      declarations[0]?.instruction.arguments,
      `${argumentName}=${expectedReference}`,
      `${argumentName} default must equal the immutable runtime lock reference`,
    );
  }
});

test("devnet build pins every source-built tool to its exact commit", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { dockerfile } = await readBuildFiles();
  const tools = lock.buildTools.sources;

  for (const toolName of ["go_car", "piece_server", "storetheindex", "go_ethereum"] as const) {
    assert.match(tools[toolName].commit, /^[0-9a-f]{40}$/);
    assert.match(dockerfile, new RegExp(`@\\$\\{${toolName.toUpperCase()}_COMMIT\\}`));
  }
  assert.match(dockerfile, /CURIO_TAGS="cunative debug nosupraseal"/);
  assert.match(dockerfile, /make build\b/);
});

test("devnet build installs go-car from the executable package at the pinned commit", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { dockerfile } = await readBuildFiles();

  assert.match(lock.buildTools.sources.go_car.commit, /^[0-9a-f]{40}$/);
  assert.match(
    dockerfile,
    /go install "github\.com\/ipld\/go-car\/cmd\/car@\$\{GO_CAR_COMMIT\}"/,
  );
  assert.doesNotMatch(
    dockerfile,
    /github\.com\/ipld\/go-car\/v2\/cmd\/car/,
  );
});

test("devnet runtime includes xxd required by the pinned contract bootstrap", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const runtimePackages = dockerfile.match(
    /FROM \$\{UBUNTU_RUNTIME_IMAGE\} AS curio-all-in-one[\s\S]*?apt-get install -y --no-install-recommends([\s\S]*?)&& rm -rf \/var\/lib\/apt\/lists/,
  );
  assert.ok(runtimePackages, "runtime package install block is missing");
  assert.match(runtimePackages[1]!, /(?:^|\s)xxd(?:\s|\\|$)/);
});

test("devnet build supplies exact BLST through a minimal verified named context", async () => {
  const lock = await loadRuntimeLock(runtimeLockPath);
  const { buildScript, commonScript, dockerfile } = await readBuildFiles();
  const blst = lock.buildTools.sources.blst;
  const productionText = `${dockerfile}\n${buildScript}`;

  assert.equal(blst.managedSource, "blst");
  assert.match(blst.commit, /^[0-9a-f]{40}$/);
  assert.match(commonScript, /\.cache\/sources\/blst\/\$\{BLST_COMMIT\}/);
  assert.match(buildScript, /blst_tool_commit/);
  assert.match(buildScript, /blst_state/);
  assert.match(buildScript, /blst_source_reported/);
  assert.match(
    buildScript,
    /--build-context "blst-source=\$\{blst_source_relative\}"/,
  );

  for (const input of ["build.sh", "build/", "src/", "bindings/"]) {
    assert.match(
      dockerfile,
      new RegExp(
        `COPY --from=blst-source /${input.replaceAll(".", "\\.")}`,
      ),
    );
  }
  assert.match(dockerfile, /FROM \$\{GO_BUILDER_IMAGE\} AS blst-builder/);
  assert.match(dockerfile, /\.\/build\.sh/);
  assert.match(dockerfile, /test -s libblst\.a/);
  assert.match(
    dockerfile,
    /COPY --from=blst-builder \/opt\/blst \/opt\/curio\/extern\/supraseal\/deps\/blst/,
  );
  assert.doesNotMatch(dockerfile, /COPY --from=blst-source \/(?:\s|\.?$)/m);
  assert.doesNotMatch(dockerfile, /COPY (?:--from=[^ ]+ )?extern\/supraseal/);
  assert.doesNotMatch(dockerfile, /COPY --from=blst-source \/(?:\.git|README|SECURITY)/);
  assert.doesNotMatch(
    productionText,
    /scripts\/build-blst\.sh|git\s+clone|github\.com\/supranational\/blst/i,
  );
  assert.match(dockerfile, /CURIO_TAGS="cunative debug nosupraseal"/);

  for (const fileText of [dockerfile, buildScript]) {
    assert.match(fileText, /io\.porep-market\.blst\.commit/);
  }
  assert.match(buildScript, /blstCommit/);
  assert.match(buildScript, /blstCommit: blstCommit/);
});

test("devnet build confines context and output to the verified project namespace", async () => {
  const { buildScript, commonScript } = await readBuildFiles();

  assert.match(buildScript, /npm --prefix tools run cli -- runtime lock verify/);
  assert.match(buildScript, /npm --prefix tools run cli -- sources verify/);
  assert.match(commonScript, /\.cache\/sources\/curio\/\$\{CURIO_COMMIT\}/);
  assert.match(commonScript, /porep-market-curio-devnet/);
  assert.match(buildScript, /docker\/(?:lotus|contracts-bootstrap|lotus-miner|curio|piece-server|indexer)\/Dockerfile/);
  assert.doesNotMatch(buildScript, /docker\s+(?:compose|container|network|volume)\b/);
  assert.doesNotMatch(buildScript, /docker\s+(?:rm|rmi|system\s+prune|builder\s+prune|buildx\s+prune)\b/);

  for (const image of [
    "curio-all-in-one",
    "lotus",
    "contracts-bootstrap",
    "lotus-miner",
    "curio",
    "piece-server",
    "indexer",
  ]) {
    assert.match(buildScript, new RegExp(`porep-market-curio-devnet/${image}`));
  }
});

test("devnet build is bounded and records inspected local image evidence", async () => {
  const { buildScript, commonScript, dockerfile } = await readBuildFiles();

  assert.match(commonScript, /DEVNET_BUILD_TIMEOUT_MS=5400000/);
  assert.match(buildScript, /run-with-timeout\.mjs/);
  assert.doesNotMatch(buildScript, /docker buildx imagetools inspect/);
  assert.match(buildScript, /\(devnet_write_compose_env >\/dev\/null 2>&1\)/);
  assert.match(buildScript, /reusing validated local images/);
  assert.match(buildScript, /docker image inspect/);
  assert.match(buildScript, /\.runtime\/devnet\/build\/images\.json/);
  assert.match(buildScript, /mktemp/);
  assert.match(buildScript, /devnet_publish_manifest/);
  assert.match(commonScript, /chmod 0644 "\$\{temporary_manifest\}"/);
  assert.match(
    commonScript,
    /chmod 0644 "\$\{temporary_manifest\}"\n  mv -- "\$\{temporary_manifest\}" "\$\{active_manifest\}"/,
  );
  assert.equal((buildScript.match(/docker buildx build \\/g) ?? []).length, 2);
  assert.equal((buildScript.match(/--provenance=false/g) ?? []).length, 2);

  for (const label of [
    "io.porep-market.curio.commit",
    "io.porep-market.lotus.commit",
    "io.porep-market.dockerfile.sha256",
    "io.porep-market.zigzag.filecoin-ffi.patch.sha256",
    "io.porep-market.zigzag.rust-fil-proofs.api.sha256",
  ]) {
    assert.match(dockerfile, new RegExp(label.replaceAll(".", "\\.")));
    assert.match(buildScript, new RegExp(label.replaceAll(".", "\\.")));
  }
  assert.match(buildScript, /Architecture/);
  assert.match(buildScript, /\bOs\b/);
  assert.match(buildScript, /\bId\b/);
});

test("devnet build archives prior evidence before tag mutation and leaves active evidence absent on failure", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devnet-build-evidence-"));
  try {
    const buildDirectory = join(fixtureRoot, "build");
    const activeManifest = join(buildDirectory, "images.json");
    const historyDirectory = join(buildDirectory, "history");
    const archiveName = "images.before-test.json";
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(activeManifest, "prior-manifest\n", "utf8");

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
          source "$1"
          devnet_archive_active_manifest "$2" "$3" "$4"
          exit 23
        `,
        "devnet-evidence-test",
        commonScriptPath,
        activeManifest,
        historyDirectory,
        archiveName,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 23, result.stderr);
    await assert.rejects(readFile(activeManifest, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(historyDirectory), [archiveName]);
    assert.equal(
      await readFile(join(historyDirectory, archiveName), "utf8"),
      "prior-manifest\n",
    );

    const buildScript = await readFile(buildScriptPath, "utf8");
    const archiveCall = buildScript.indexOf("devnet_archive_active_manifest");
    const firstTagMutation = buildScript.indexOf("docker buildx build");
    assert.ok(archiveCall >= 0);
    assert.ok(firstTagMutation >= 0);
    assert.ok(archiveCall < firstTagMutation);
    assert.doesNotMatch(buildScript, /restore.*images\.json/i);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("devnet build diagnostics redact absolute paths and omit container inventory", async () => {
  const buildScript = await readFile(buildScriptPath, "utf8");
  const userHome = homedir();
  const diagnosticInput = [
    `build start=test log=${repositoryRoot}/.runtime/devnet/logs/build-test.log`,
    `building image from verified context ${repositoryRoot}/.cache/sources/curio/commit`,
    `tool detail ${userHome}/outside-repository/private`,
    "active containers before build:",
    "name=unrelated-service project=other status=Up image=private/image",
    "",
  ].join("\n");

  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; devnet_sanitize_build_log',
      "devnet-log-test",
      commonScriptPath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: userHome },
      input: diagnosticInput,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /log=\.runtime\/devnet\/logs\/build-test\.log/);
  assert.match(result.stdout, /\.cache\/sources\/curio\/commit/);
  assert.doesNotMatch(result.stdout, new RegExp(repositoryRoot.replaceAll(".", "\\.")));
  assert.doesNotMatch(result.stdout, new RegExp(userHome.replaceAll(".", "\\.")));
  assert.doesNotMatch(result.stdout, /unrelated-service|private\/image|active containers/);
  assert.doesNotMatch(buildScript, /docker ps -a|name=\{\{\.Names\}\}/);
});

test("devnet manifest publication sets mode 0644 before atomic rename", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devnet-manifest-mode-"));
  try {
    const temporaryManifest = join(fixtureRoot, "images.json.temporary");
    const activeManifest = join(fixtureRoot, "images.json");
    await writeFile(temporaryManifest, "new-manifest\n", "utf8");
    await chmod(temporaryManifest, 0o600);

    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; devnet_publish_manifest "$2" "$3"',
        "devnet-mode-test",
        commonScriptPath,
        temporaryManifest,
        activeManifest,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(activeManifest, "utf8"), "new-manifest\n");
    assert.equal((await stat(activeManifest)).mode & 0o777, 0o644);
    await assert.rejects(readFile(temporaryManifest, "utf8"), { code: "ENOENT" });

    const buildScript = await readFile(buildScriptPath, "utf8");
    assert.match(buildScript, /devnet_publish_manifest/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("project build manifest validation rejects volumes on every inspected image", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devnet-image-volumes-"));
  try {
    const buildScript = await readFile(buildScriptPath, "utf8");
    const validatorSource = buildScript.match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
    assert.ok(validatorSource);

    const inspectPath = join(fixtureRoot, "images.inspect.ndjson");
    const outputPath = join(fixtureRoot, "images.json");
    const curioCommit = "c".repeat(40);
    const lotusCommit = "1".repeat(40);
    const blstCommit = "b".repeat(40);
    const dockerfileSha256 = "d".repeat(64);
    const zigzagPatchSha256 = "e".repeat(64);
    const zigzagApiSha256 = "f".repeat(64);
    const tag = curioCommit.slice(0, 12);
    const namespace = "porep-market-curio-devnet";
    const imageNames = ["curio-all-in-one", ...derivedImageServices];
    const expectedLabels = {
      "io.porep-market.curio.commit": curioCommit,
      "io.porep-market.lotus.commit": lotusCommit,
      "io.porep-market.blst.commit": blstCommit,
      "io.porep-market.dockerfile.sha256": dockerfileSha256,
      "io.porep-market.zigzag.filecoin-ffi.patch.sha256": zigzagPatchSha256,
      "io.porep-market.zigzag.rust-fil-proofs.api.sha256": zigzagApiSha256,
    };

    for (const [volumeIndex, imageName] of imageNames.entries()) {
      const inspections = imageNames.map((name, index) => ({
        Architecture: "arm64",
        Config: {
          Labels: expectedLabels,
          Volumes: index === volumeIndex ? { "/unexpected-anonymous-volume": {} } : null,
        },
        Id: `sha256:${String(index).repeat(64)}`,
        Os: "linux",
        RepoTags: [`${namespace}/${name}:${tag}`],
      }));
      await writeFile(
        inspectPath,
        `${inspections.map((inspection) => JSON.stringify(inspection)).join("\n")}\n`,
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "-",
          inspectPath,
          outputPath,
          "2026-07-24T00:00:00Z",
          "2026-07-24T00:00:01Z",
          "1",
          "linux/arm64",
          curioCommit,
          lotusCommit,
          blstCommit,
          dockerfileSha256,
          zigzagPatchSha256,
          zigzagApiSha256,
          tag,
          namespace,
        ],
        {
          encoding: "utf8",
          input: validatorSource,
        },
      );

      assert.notEqual(result.status, 0, `${imageName} volume metadata was accepted`);
      assert.match(result.stderr, /declares unexpected image volumes/);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("all project Dockerfiles omit VOLUME and derived definitions transparently copy verified Curio", async () => {
  const staticChecks = await readFile(
    join(repositoryRoot, "scripts", "static-checks.sh"),
    "utf8",
  );
  const buildScript = await readFile(buildScriptPath, "utf8");
  const definitions = [
    {
      name: "curio-all-in-one",
      path: dockerfilePath,
    },
    ...derivedImageServices.map((name) => ({
      name,
      path: join(repositoryRoot, "docker", name, "Dockerfile"),
    })),
  ];
  const results = await Promise.allSettled(
    definitions.map(async ({ name, path }) => ({
      name,
      path,
      text: await readFile(path, "utf8"),
    })),
  );
  const violations: string[] = [];
  const exactBaseImage =
    `porep-market-curio-devnet/curio-all-in-one:${curioSourceCommit.slice(0, 12)}`;

  for (const [index, result] of results.entries()) {
    const definition = definitions[index];
    if (result.status === "rejected") {
      violations.push(`${definition?.name ?? "unknown"} Dockerfile is missing`);
      continue;
    }
    if (/^\s*VOLUME(?:\s|$)/m.test(result.value.text)) {
      violations.push(`${result.value.name} Dockerfile declares VOLUME`);
    }
  }

  for (const service of derivedImageServices) {
    const result = results[derivedImageServices.indexOf(service) + 1];
    if (result?.status !== "fulfilled") continue;
    const upstreamPath = join(
      repositoryRoot,
      ".cache",
      "sources",
      "curio",
      curioSourceCommit,
      "docker",
      service,
      "Dockerfile",
    );
    const upstream = await readFile(upstreamPath, "utf8");
    let expected = upstream
      .replace(
        /^ARG CURIO_TEST_IMAGE=.*$/m,
        `ARG CURIO_TEST_IMAGE=${exactBaseImage}`,
      )
      .split("\n")
      .filter((line) => !/^\s*VOLUME(?:\s|$)/.test(line))
      .join("\n");
    if (service === "lotus") {
      expected = expected.replace(
        "COPY entrypoint.sh /app\n\nUSER root",
        [
          "COPY entrypoint.sh /app",
          "COPY --from=harness-overlay patches/curio/0002-lotus-entrypoint-zigzag-runtime-only.patch /tmp/lotus-entrypoint-zigzag-runtime-only.patch",
          "RUN git apply /tmp/lotus-entrypoint-zigzag-runtime-only.patch \\",
          "    && rm -f /tmp/lotus-entrypoint-zigzag-runtime-only.patch",
          "",
          "USER root",
        ].join("\n"),
      );
    }
    if (result.value.text !== expected) {
      violations.push(`${service} Dockerfile differs beyond base default and VOLUME`);
    }
    if (!buildScript.includes(
      `"docker/${service}/Dockerfile|docker/${service}|`,
    )) {
      violations.push(`${service} harness Dockerfile is absent from derived builds`);
    }
    if (!staticChecks.includes(`docker/${service}/Dockerfile`)) {
      violations.push(`${service} harness Dockerfile is absent from static checks`);
    }
  }

  assert.match(
    buildScript,
    /--file "\$\{relative_dockerfile\}"[\s\S]*"\$\{curio_source_relative\}\/\$\{relative_context\}"/,
  );
  assert.doesNotMatch(
    buildScript,
    /--file "\$\{curio_source_relative\}\/\$\{relative_dockerfile\}"/,
  );
  assert.deepEqual(violations, []);
});
