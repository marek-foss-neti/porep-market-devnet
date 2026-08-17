# Curio DevNet runtime

This is a local, test-only Filecoin/Curio machine. The generated keys and
contracts are not production credentials or deployments.

## Ownership and reproducibility

Tracked orchestration lives in this repository. Exact detached source
checkouts are managed under `.cache/sources/<name>/<commit>/`; chain state,
test identities, deployment manifests, logs, and run evidence live under
`.runtime/`. Neither path is committed.

The default workflow does not use sibling checkouts, Git submodules, or global
project dependencies. `versions.lock.yaml` defines the source, image, build
tool, and network inputs.

## Lifecycle

```sh
just bootstrap
just build
just up
just status
just deploy
just test-contracts
just test-e2e suite=contract
just test-all
just test-fresh
just logs
just down
just reset
```

`up` and `down` preserve bind-mounted chain, miner, Curio, database, and
contract-bootstrap state. `reset` keeps bounded logs and identity JSON under
`.runtime/reset-evidence/`, deletes disposable chain/private identity state,
creates a new runtime generation, and preserves public deployment revisions,
scenario runs, managed sources, images, the build manifest, and proof
parameters.

Before startup, `up` checks required services and locked images,
loopback/unique ports, project-owned bind mounts, and the absence of fixed
container identities. Logging options, restart policy, service ordering, and
exact healthcheck command text are not treated as protocol contracts.

`status` validates the Lotus and Curio versions, FEVM chain ID, network and
actor versions, provider, sector size, Curio APIs, Market endpoint, database,
and task readiness. It writes the latest snapshot to
`.runtime/devnet/status/latest.json`.

## Command bounds and diagnostics

Lifecycle and test commands use `scripts/run-with-timeout.mjs` around work that
can hang:

- Node version check: 15 seconds
- lock verification and typecheck/static checks: 60 seconds
- `npm ci` and unit tests: 10 minutes
- source verification: 5 minutes
- source fetch: 20 minutes
- complete image build: 90 minutes
- one E2E scenario: 2 hours
- one E2E matrix: 12 hours

On timeout or external SIGINT/SIGTERM, the helper forwards the signal to the
command process group, waits five seconds, and then sends SIGKILL if needed.
Timeout exits use status 124; external SIGINT/SIGTERM exits use 130 or 143.
Diagnostics identify the executable and retain a bounded stderr tail without
printing environment variables or command arguments.

BuildKit output is retained under `.runtime/devnet/logs/` on success or
failure. Re-running `just build` safely reuses the same pinned tags and
BuildKit cache.

## Contract targets and deployments

`test-contracts` and `deploy` use the clean PoRep Market revision from
`versions.lock.yaml` unless an explicit absolute `source` checkout is passed.
The checkout may be dirty. The harness creates an immutable snapshot before
building, testing, or deploying it.

Every deployment is append-only under
`.runtime/deployments/<deployment-id>/revisions/`. Deploying again creates a
new contract graph. `.runtime/deployments/active.json` selects the revision
used by scenarios.

A revision records its contract target, chain generation, flexible contract
map, proxy and beacon implementations, and live runtime code hashes. Selection
checks the chain ID, generation, genesis CID, provider, and deployed bytecode
before exposing addresses or running scenarios.

`just tooling-env` performs the same validation before printing public dotenv
values for external Python tooling and the oracle. Signing keys remain in the
ignored deployment directory.

## Upgrade execution

`upgrade` supports PoRep Market UUPS contracts and the Validator beacon through
the selected checkout's upstream upgrade scripts. It checks that the deployment
is current, the caller has upgrade authority, and every requested contract has
a supported script.

A per-deployment lock prevents concurrent upgrades. The prepared target, plan,
and successful transaction receipts form a resumable journal because multiple
EOA upgrades cannot be atomic. Rerunning an interrupted command resumes the
same plan. A new deployment revision is published only when every live
implementation and compiled runtime bytecode hash match the selected source.

`test-upgrade` creates populated deal and payment state, performs the upgrade,
checks proxy addresses and stored state, continues the old deal, and creates a
new deal. Upgrade testing is intentionally excluded from ordinary scenario
matrices.

## Endpoints

- Filecoin/FEVM JSON-RPC: `http://127.0.0.1:2234/rpc/v1`
- Lotus Miner API: `127.0.0.1:22345`
- Curio API: `127.0.0.1:22300`
- Curio Market 2.0: `http://127.0.0.1:22310`
- Curio UI: `http://127.0.0.1:24701`
- piece server: `http://127.0.0.1:22320`
- Yugabyte YSQL/UI: `127.0.0.1:25433` / `http://127.0.0.1:25434`
- indexer ports: `127.0.0.1:23000-23003`

The chain ID is `31415926` (`0x1df5e76`). Do not assume a provider actor ID;
read `.runtime/devnet/status/latest.json`:

```sh
jq -r '.miner.provider' .runtime/devnet/status/latest.json
```

## Bundled CLI access

Use the project Compose file and generated environment; no global Lotus,
Curio, or Foundry installation is required:

```sh
docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T lotus lotus chain head --height

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T lotus lotus state miner-info \
  "$(jq -r '.miner.provider' .runtime/devnet/status/latest.json)"

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T curio curio cli --machine curio:12300 info

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T piece-server sptool --help

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T contracts-bootstrap cast --version
```

The `contracts-bootstrap` service normally exits successfully after startup.
Use `docker compose run --rm --no-deps --entrypoint cast contracts-bootstrap
...` if a later manual `cast` invocation is needed while it is stopped.

## Runtime evidence

- image IDs and source commits: `.runtime/devnet/build/images.json`
- latest validated readiness: `.runtime/devnet/status/latest.json`
- active generation: `.runtime/devnet/generation`
- service/build/status logs: `.runtime/devnet/logs/`
- bounded reset evidence: `.runtime/reset-evidence/`
- active deployment selector: `.runtime/deployments/active.json`
- deployment revisions: `.runtime/deployments/<deployment-id>/revisions/`
- active sector fixture: `.runtime/fixtures/<generation>/active-sector.json`
- scenario and matrix reports: `.runtime/runs/`

## Safety boundaries

`up`, `status`, `logs`, and `down` are non-destructive. `reset` is the only
destructive public lifecycle command.

Before a write, lifecycle scripts validate the exact repository, expected path
type, canonical real path, ownership marker, and absence of symbolic links.
Reset is limited to this Compose project and never removes shared proof
parameters, source/build caches, images, or resources owned by another
project.

## Measured arm64 run

Measurements were taken on an Apple arm64 host with 10 CPUs, 24 GiB host RAM,
7.65 GiB Docker memory, Docker 29.2.1, and the original epoch-200 FireHorse
schedule:

- corrected cold image build: 467 seconds;
- first chain startup through NV28 and validated status: about 12 minutes;
- non-destructive `down -> up -> status`: about 28 seconds;
- project reset through a new genesis, provider, and NV28 status: about
  14 minutes;
- proof parameter cache after the live gates: 5.8 GiB;
- active runtime data: about 450 MiB;
- steady six-service memory after reset: about 1.9 GiB total; sampled CPU was
  about 19%, dominated by Yugabyte.

The first validated chain used provider `t01003`. Restart preserved its
generation and genesis while the head advanced from 254 to 265. The scoped
reset changed the genesis from
`bafy2bzacec7prtzexq5yud2azjz3qbpvhftly6vofg3wgd7r25qtm5u7hyepe` to
`bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw`,
changed the runtime generation, created provider `t01004`, and passed
NV28/actors-v18 status at epoch 201. The current benchmark harness uses
FireHorse epoch 20, so fresh reset readiness is expected earlier; rerun the
measurement before citing exact current timings. The unrelated Boost Compose
container IDs were unchanged.

## Whole-system proof

`just test-all` preserves the current chain, runs the selected PoRep Market
checkout's canonical Foundry tests, creates a new contract graph, and runs the
selected suite. `just test-fresh` is the destructive qualification path:
reset, locked clean deployment, contract and Curio suites, and runtime identity
verification. Those suites already contain every security-tagged scenario. The
contract suite is the fast non-sealing development loop; Curio and focused
security suites may perform real sealing or restart work. Use individual
lifecycle and suite commands during normal development.

Contract deployment and upgrade Forge processes use a private loopback RPC
adapter that represents Lotus null epochs as empty Ethereum-shaped blocks.
This prevents Foundry's block lookup retries from stalling deployment while
leaving Lotus, Curio, and scenario RPC traffic unchanged.

## Proof backend selection

The local DevNet defaults to the Stacked DRG proof backend and `8mib` sectors.
Start from a fresh runtime to select a backend and sector size explicitly:

```sh
just reset stacked 8mib
just reset zigzag 8mib
just reset zigzag 512mib
```

The selected backend is recorded in `.runtime/devnet/proof-backend`; the selected
sector size is recorded in `.runtime/devnet/sector-size`. Both are also recorded
in `.runtime/devnet/status/latest.json` and every deployment revision. Lifecycle
commands refuse to reuse an existing runtime or deployment revision whose proof
backend or sector size differs from the selected runtime identity.

`DEVNET_PROOF_BACKEND=stacked|zigzag` and
`DEVNET_SECTOR_SIZE=2kib|8mib|512mib|32gib` are the public selectors. Lifecycle
scripts render the effective container proof environment into the generated
Compose environment: `SECTOR_SIZE=<bytes>`, `FIL_PROOFS_USE_ZIGZAG=1` only for
ZigZag, and `FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=1` only for ZigZag Curio.
Curio and Lotus also receive the same `FIL_PROOFS_ZIGZAG_SIDECAR_DIR`, backed by
`.runtime/devnet/zigzag-proof-sidecars`, so Lotus verification can read the
per-proof `comm_r_star` sidecar written during ZigZag proving. They also receive
the backend-specific `FIL_PROOFS_PARENT_CACHE`, backed by
`.cache/stacked-parent-cache` or `.cache/zigzag-parent-cache`, plus matching SDR
and ZigZag parent-cache window settings. Manual Compose YAML edits are not part
of the supported workflow.

Proof parameters under `.cache/proof-parameters/` and backend parent caches under
`.cache/*-parent-cache/` survive resets. Benchmark recipes warm the required
static ZigZag Groth16 `*.params` and `*.vk` files outside measured windows and write
`.cache/proof-parameters/.zigzag-devnet-prewarm-<sector>.json`. Per-sector
ZigZag proof sidecars are runtime artifacts, not proof parameters; reset clears
them so they cannot leak between backend benchmark runs.

The Docker build does not apply `.patch` files to managed checkouts. Devnet-only
changes live as full source-file overrides under `source-overrides/` and are
copied into the pinned Curio, Lotus, `filecoin-ffi`, and FVM source trees during
image construction. Images record the aggregate override hash in
`io.porep-market.zigzag.source-overrides.sha256`; startup validation rejects
images when that hash no longer matches the local override set.
