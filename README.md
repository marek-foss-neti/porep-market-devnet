# PoRep Market Curio DevNet

Local integration and E2E test harness for PoRep Market on a pinned Curio
DevNet. Source, image, tool, and chain versions are fixed in
`versions.lock.yaml`.

This is a test-only network. Generated keys and deployed contracts are not for
production use.

## Prerequisites

- Git
- Docker with Compose
- `just` 1.46 or newer
- Node.js 20 or newer
- `curl`, `jq`, and `lsof`
- at least 14 GiB free disk space

The harness was verified on Apple arm64 with 10 CPUs, 24 GiB host RAM, and
7.65 GiB assigned to Docker.

## Quick start

```sh
just bootstrap
just build
just up
just status
just test-unit
just test-contracts
just deploy
just test-e2e contract
```

`bootstrap` fetches the pinned source checkouts. `build` creates the
project-scoped Curio images. `status` waits for a usable chain, miner, Curio
API, Market endpoint, and database.

The first build and chain startup can take several minutes. Commands are
bounded and retain diagnostics under `.runtime/` when they fail.

Use `just --list` to see the complete command surface.

## Test a PoRep Market checkout

With no `source`, contract tests and deployments use the clean revision pinned
in `versions.lock.yaml`.

To test local contract changes:

```sh
just test-contracts /absolute/path/to/porep-market
just deploy /absolute/path/to/porep-market
just test-e2e contract
```

The checkout may be dirty. The harness snapshots it before testing or
deployment, so later edits cannot change the running test.

## Run the seal/unseal baseline

The baseline uses the pinned, unmodified Curio and Filecoin Stacked PoRep path.
Run a fresh end-to-end roundtrip against the active deployment with:

```sh
just test-seal-unseal
```

The scenario generates a fresh CAR and CommP, submits an MK20 deal, waits for
Curio to seal the sector and publish ProveCommit, and confirms that the sealed
replica exists while the unsealed replica does not. It then requests unseal,
checks the resulting CommD, recovers the exact CAR bytes from `FTUnsealed`, and
verifies the source and recovered SHA-256, CommP, padded piece size, sealed
replica, and on-chain sector.

The test starts unseal as soon as the sector is committed on-chain. It does not
wait for the first WindowPoSt or require the sector to enter the active-sector
set. This keeps the baseline faithful to the normal seal/unseal implementation
without adding the proving-period delay to the local test.

Each run writes `summary.json` and a descriptive `summary.md` under
`.runtime/runs/<run-id>/`. The Markdown report contains the final verdict,
per-step timings, seal/unseal checks, recovered hashes, and failure diagnostics.

## Run scenarios

Run one scenario:

```sh
just test-scenario proposal-smoke
just test-scenario settlement-guards
just test-scenario direct-onboarding-notification
```

Run a suite:

```sh
just test-e2e contract
just test-e2e curio
just test-e2e security
just test-e2e full
```

| Suite | Purpose |
| --- | --- |
| `contract` | Fast contract development loop without Curio sealing |
| `curio` | Market notification, onboarding, and sector flows |
| `security` | Access control, rejection, termination, and replay cases |
| `full` | Every registered scenario |

Scenarios assert intended contract behavior, which may be newer than the
currently pinned deployment. A deterministic assertion failure can therefore
be a contract finding rather than a harness failure. Matrix reports separate
infrastructure failures from behavior failures and record skipped
capabilities.

Run summaries are written under `.runtime/runs/` as both machine-readable
`summary.json` and a descriptive `summary.md`. The Markdown report includes
the final verdict, per-step timings, seal/unseal checks, recorded state, and
the failing step and diagnostics link when a run fails.

## Deployments and external tooling

Each deployment is immutable and tied to one chain generation. Inspect the
active deployment with:

```sh
just addresses
```

Select another recorded deployment:

```sh
just use-deployment deployment-... latest
```

Export validated public values for the Python tooling or oracle:

```sh
just tooling-env > /tmp/porep-market-devnet.env
```

The export contains the RPC URL, chain ID, and public contract addresses. It
does not contain signing keys or configure the oracle database, roles, or
scheduler.

## Full qualification and upgrades

Run the unit gate, upstream contract tests, a fresh deployment, and one suite
without resetting the chain:

```sh
just test-all /absolute/path/to/porep-market contract
```

Run the destructive clean qualification lane:

```sh
just test-fresh
```

Test an in-place upgrade:

```sh
just test-upgrade deployment-... \
  'PoRepMarket,DataCapEvidenceAdapter' \
  /absolute/path/to/new-porep-market
```

`test-fresh` resets the chain. Ordinary `up`, `down`, tests, and deployments
preserve it.

## Common operations

```sh
just status
just logs
just logs curio
just down
just up
just reset
```

`reset` is the only destructive public lifecycle command. It deletes this
project's disposable chain, database, fixture, and private deployment identity
state, then starts a new generation. It preserves managed sources, images,
proof parameters, public deployment records, and prior scenario reports.

Default local endpoints:

- Filecoin JSON-RPC: `http://127.0.0.1:2234/rpc/v1`
- Curio API: `http://127.0.0.1:22300`
- Curio Market: `http://127.0.0.1:22310`
- Curio UI: `http://127.0.0.1:24701`

See [Curio DevNet runtime](docs/runtime/curio-devnet.md) for all endpoints,
bundled CLI access, runtime evidence, timeout behavior, deployment and upgrade
internals, safety boundaries, and measured runtime characteristics.
