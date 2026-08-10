# ADR 0001: Self-contained pinned Curio DevNet

Status: accepted by the repository goal

Date: 2026-07-24

## Decision

This repository owns the complete local integration harness. It fetches exact
source commits into `.cache/sources/`, builds immutable local images from those
managed checkouts, keeps chain state and run artifacts under `.runtime/`, and
exposes all supported operations through root `just` recipes.

The provider runtime is Curio from `CodeWarriorr/curio` at
`ce15c0c92209366a5523b803e9c159baa2ffb66a`. At the time of selection this
commit is identical to upstream Curio `main`. It is compiled against Lotus
`v1.36.0` and run with the exact arm64 Lotus DevNet image manifest recorded in
`versions.lock.yaml`. Its recursive `filecoin-ffi` and `sppark` gitlinks are
also locked and verified.

The chain starts at network version 27 with actors v17 and upgrades at epoch
20 to network version 28 with actors v18. FIP-0109 notifications are available
at NV27. FIP-0112 sector methods are not available until NV28, so live
preflight must reject FIP-0112 scenarios before the upgrade and must verify the
actors-v18 manifest after it.

Boost is read-only migration evidence. No finished command, container, source
fetch, TypeScript module, or runtime path may depend on Boost.

## Alternatives considered

### Keep Boost as the provider runtime

Rejected. The existing TypeScript harness is useful migration evidence, but
stock Boost still builds direct activation manifests with no arbitrary
notification receiver. It cannot prove the required real FIP-0109 callback.

### Pin Curio v1.28.2

Rejected as the default. The release is NV28-compatible, but its Docker
makefile defaults to Lotus `v1.35.1` while its Go dependency is Lotus
`v1.36.0`. A wrapper could override the version, but current Curio also contains
the corrected Docker default and later MK20 duration and FFI fixes.

### Pin current Curio source and every runtime dependency

Selected. The fork and upstream currently resolve to the same exact commit.
The commit uses Lotus `v1.36.0`, contains the required MK20 notification fields
and ingestion path, and supports a clean NV27-to-NV28 DevNet upgrade. The
harness runs that upgrade at epoch 20 to keep local benchmark resets fast while
still exercising the upgrade path. Pinning the commit prevents later branch
drift.

## Repository boundaries

- `versions.lock.yaml`: authoritative source, image, tool, chain, and actor pins.
- `scripts/`: idempotent fetch, build, lifecycle, diagnostics, and deployment
  orchestration. Scripts may prepare the environment but do not contain
  scenario assertions or state-changing scenario composition.
- `docker/`: harness-owned Compose and transparent Docker build definitions.
  They may wrap a managed Curio checkout but must not mutate it.
- `e2e/`: TypeScript provider adapter, contract flows, assertions, scenarios,
  CLI, unit tests, and generated run reports.
- `contracts/test/`: only harness-specific contracts such as MockUSDC,
  notification receivers, and FEVM sector-status helpers.
- `docs/migration/`: old-path-to-new-path provenance and scenario coverage.
- `.cache/sources/<name>/<commit>/`: ignored detached source checkouts managed
  only by the fetcher.
- `.runtime/`: ignored chain state, DevNet identities, deployment manifests,
  logs, and per-run evidence.

The default workflow must not read sibling repositories, environment variables
that point at sibling repositories, Git submodules in this repository, or
globally installed project dependencies.

## Curio integration

The harness builds stock Curio source from the managed checkout. A tracked
harness Dockerfile replaces upstream build-time `latest` references with the
exact tool pins in `versions.lock.yaml`; this is a visible build wrapper, not a
mutation or hidden patch to Curio source.

The harness owns a uniquely named Compose project, services, network, ports,
volumes, and data paths. It does not call upstream `make devnet/up` because that
target unconditionally deletes `docker/data` and uses global container names
that collide with other DevNets.

`just up` is non-destructive. `just down` stops only this Compose project.
`just reset` removes only this repository's named project state and invalidates
deployment manifests. Every wait has a timeout and captures Lotus, Curio,
HarmonyDB, miner, piece, indexer, chain-head, and deployment diagnostics.

The TypeScript Curio provider adapter owns:

- lifecycle readiness and diagnostics;
- piece creation and CommP;
- allocation creation;
- authenticated MK20 DDO submission;
- claim and activation polling;
- notification decoding and correlation;
- sector location, status, and expiration calls.

The MK20 client uses Curio's current `CurioAuth` signing contract and sends
`notification_address` and base64 `notification_payload` together. It does not
replace authentication with a test bypass and does not require a Curio source
patch.

## Contract integration

Canonical sources are fetched at exact commits. The initial deployment uses
current PoRep Market `746bd19d89f3d55eb0f253e2f3fd92657e29984a`,
FilecoinPay `755ca20054dae88e9e28dc569e696e822c59907f`, and
MetaAllocator `41811a8bd6478ffbce4db47720fd9ac521b9e048`.

The old PoRep Market harness pin
`803942a5f439e0a588da245727197ca22546bb1f` is migration provenance only. The
current pin contains later offer, manifest ownership, service metadata, and
terminal settlement changes. Migrated scenarios must adapt to current behavior
instead of restoring stale expectations.

PoRep Market's vendored FilecoinPay submodule remains pinned to
`f0a40fe287ecb08c2c20b828bdbadd2437988bba` for compilation. The separately
deployed FilecoinPay uses `755ca20054dae88e9e28dc569e696e822c59907f`.
The deployment manifest records both facts and never claims bytecode identity.

Harness-owned Solidity is limited to test dependencies that canonical
repositories do not provide: MockUSDC, success/failure FIP-0109 receivers,
termination fixtures, and an FIP-0112 caller/helper. The notification receiver
must authenticate a registered miner actor, require method `2034386435` and
CBOR codec `0x51`, decode the real tuple-CBOR payload, return a shape-matched
acceptance response, and persist replay-safe piece/sector evidence.

## Reproducibility and safety

- The fetcher checks exact detached commits, rejects dirty managed checkouts,
  and is safe to rerun.
- Builds use exact source refs and image digests where published.
- A generated local image digest is recorded after every successful build.
- Preflight verifies chain ID, network and actor versions, source refs,
  deployed bytecode and proxy slots, roles, balances, allowances, provider
  identity, and deployment-manifest freshness before mutation.
- Test-only private keys live only under `.runtime/` and are never printed by
  public address commands.
- Docker cleanup is limited to the exact Compose project and repository-owned
  `.runtime/` paths.

## Consequences

The first build is heavier than reusing sibling checkouts, and the 8 GiB Docker
VM may require serial image builds and one-sector sealing. This cost is accepted
because a clean checkout must reproduce the environment. Resource sufficiency
remains unproven until measured by the live Phase 2 gates.

FIP-0109 and FIP-0112 are separate gates. A notification pass before epoch 20
does not prove sector status. Completion requires the real callback, the
post-NV28 built-in actor calls, every migrated scenario, and two independent
clean full-matrix runs.
