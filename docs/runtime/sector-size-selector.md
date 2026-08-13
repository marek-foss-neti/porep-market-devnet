# Sector Size Selector

The local devnet exposes sector size as a first-class runtime selector alongside
the proof backend selector. The default remains `8mib`.

## Supported Sizes

This branch wires both Stacked/SDR and ZigZag for:

| Selector | Bytes | Registered seal proof |
| --- | ---: | --- |
| `2kib` | 2,048 | `StackedDrg2KiBV1_1` |
| `8mib` | 8,388,608 | `StackedDrg8MiBV1_1` |
| `512mib` | 536,870,912 | `StackedDrg512MiBV1_1` |
| `32gib` | 34,359,738,368 | `StackedDrg32GiBV1_1` |

`32gib` is the larger production-size target. It is registered and meaningful
for Stacked and ZigZag comparison, but it requires enough Docker memory, disk,
proof parameters, and wall-clock budget.

`1gib`, `2gib`, `4gib`, and `8gib` are rejected because they are not registered
Filecoin seal proof sector sizes in this dependency set. `64gib` is registered
upstream, but this branch intentionally limits the large ZigZag comparison
surface to `512mib` and `32gib`.

## Lifecycle

Sector size must be chosen before genesis is generated. Use:

```bash
just reset zigzag 512mib
just deploy
just test-deliver-seal-unseal-retrieval active
```

or:

```bash
just reset stacked 512mib
just deploy
just bench-deliver-seal-unseal-retrieval active
```

Changing sector size requires a fresh reset. The lifecycle scripts persist the
selected value in `.runtime/devnet/sector-size`, render `DEVNET_SECTOR_SIZE` and
`SECTOR_SIZE=<bytes>` into `.runtime/devnet/compose.env`, and reject attempts to
start an existing runtime with a different selector.

`just bench-proof-backends <sector-size>` passes the selector through the
prewarm, reset, deploy, and benchmark sequence:

```bash
just bench-proof-backends 512mib
just bench-proof-backends 32gib
```

The comparison runner keeps ZigZag prewarm markers sector-specific under
`.cache/proof-parameters/.zigzag-devnet-prewarm-<sector>.json`.
On first large-sector startup, Lotus may still fetch production proof
parameters before Curio can initialize its market config. `devnet-up` therefore
uses a longer bounded market-config wait for `512mib` and `32gib` and reports
the proof-parameter cache size in its heartbeat. Set
`DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS=<seconds>` only to override that
startup wait; it does not change any measured benchmark phase.

Stacked microbench runs use an isolated run-local parameter cache, because local
Groth parameter generation produces valid benchmark params but not the official
Filecoin production params checked by Lotus. If older local Stacked params are
found in `.cache/proof-parameters/` beside a parameter-cache `.meta` file,
`devnet-up` checks them against the pinned official manifest and quarantines
only mismatched files before startup. ZigZag params remain in the shared cache
because they are devnet-specific for this restore-ZigZag integration.

## Reporting

`scripts/devnet-status.sh` writes the selected sector identity to
`.runtime/devnet/status/latest.json`:

```json
{
  "sector": {
    "selector": "512mib",
    "bytes": 536870912,
    "registeredSealProof": "StackedDrg512MiBV1_1"
  }
}
```

Deployment revisions record the same selector under `proof.sectorSize`, and
`just use-deployment` rejects stale deployments whose backend or sector size
does not match the current runtime.

The full deliver/seal/unseal/retrieval scenarios still generate a small test
piece by default. Larger sector selectors therefore test the proof path and
sector lifecycle size without trying to fill the sector.
