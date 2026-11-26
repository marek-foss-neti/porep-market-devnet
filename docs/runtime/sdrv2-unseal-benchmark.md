# SDR v2 unseal-only benchmark

SDR v2 is the Stacked DRG variant with keyed-PRP labels (Threefish-256) and
parallel decoding from "Parallel decoding for Filecoin's PoRep: SDR v2 and
ZigZag" (draft of 16 November 2026). This benchmark measures only its raw
unseal, on the same host and with the same runner as the ZigZag raw unseal.

Status: built and run only on a development laptop (Docker Desktop, Linux arm64
image, 8 CPUs). `just bench-proof-micro-unseal sdr-v2 2kib` and `... 8mib` with
16-block and 5-block keys prepared their fixtures, unsealed with matching bytes
and produced `summary.md`, `report.json` and provenance. An x86-64 host and
sectors of 512 MiB and above are untested, and nothing here is a performance
result.

## Scope

- `sdr-v2` supports `prepare-fixture` and `unseal-only`. There are no replica
  commitments, proofs or Groth16 parameters, so `full` and `prewarm-only` are
  rejected.
- The fixture is deterministic sector data sealed with a simple encoder: one
  sequential thread per layer. Fixture time is not a sealing measurement.
- The byte-level label layout is a working specification that the report does
  not fix. A change of that layout invalidates existing fixtures.
- The backend runs in the ZigZag microbench image with the ZigZag container
  settings (100 GiB base memory limit, CPU set, telemetry). Provenance therefore
  records backend `zigzag`; `summary.json` records backend `sdr-v2` and an
  `sdr_v2` object with the replica parameters and decoder settings.

## Commands

Run on the remote benchmark host only.

```sh
# Correctness on a small sector first.
just bench-proof-micro-prepare-fixture sdr-v2 8mib
just bench-proof-micro-unseal sdr-v2 8mib

# 32 GiB, shortest key hash (5 SHA-256 blocks).
BENCH_SDRV2_KEY_BLOCKS=5 just bench-proof-micro-prepare-fixture sdr-v2 32gib
BENCH_SDRV2_KEY_BLOCKS=5 just bench-proof-micro-unseal sdr-v2 32gib

# 32 GiB, default key hash (16 blocks: the report's label as costly as an SDR label).
just bench-proof-micro-prepare-fixture sdr-v2 32gib
just bench-proof-micro-unseal sdr-v2 32gib

# The ZigZag side of the comparison, same host and session.
just bench-proof-micro-unseal zigzag 32gib
```

`unseal-only` prepares a missing fixture first, outside the measured phase.

## Settings

| Host variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_SDRV2_LAYERS` | `11` | Layers; the last one is the replica. Changes the replica. |
| `BENCH_SDRV2_KEY_BLOCKS` | `16` | SHA-256 compressions of one label key, 5 to 21. Changes the replica. |
| `BENCH_SDRV2_DECODE_BATCH` | `8` | Nodes whose memory accesses the decoder prefetches together, 1 to 64. |
| `BENCH_SDRV2_HUGE_PAGES` | `1` | Ask for transparent huge pages on the two sector buffers. |
| `BENCH_SDRV2_DRG_PARENT_TABLE` | `1` | Keep the DRG parents of the sector in memory, computed once, instead of computing them in every layer. |
| `BENCH_SDRV2_MICRO_FIXTURE_DIR` | unset | Fixture directory override (falls back to `BENCH_MICRO_FIXTURE_DIR`). |

A fixture holds one replica format. The default fixture directory is
`.runtime/proof-micro-fixtures/sdr-v2-<sector>-l<layers>-b<key blocks>-minimal-unseal`,
and `fixture.json` records both values. Pointing a run at a fixture made with
other values fails before the measured phase. `BENCH_PROOF_MICRO_LAYERS` does not apply to SDR v2.
The existing `BENCH_UNSEAL_RANGE_OFFSET` / `BENCH_UNSEAL_RANGE_SIZE` settings
apply; the whole sector is decoded whatever the range.

## What is measured

`raw_unseal_retrieval` covers, in order: building the graph and its Feistel
table, allocating two sector-sized buffers, reading the sealed file into memory
with one positional read, decoding all layers in parallel, and writing the
unpadded range through the ZigZag FR32 output writer to the byte-checking sink.
This is the same boundary as the ZigZag RAM-state path. Per-layer decode
operations appear in telemetry as `sdrv2_decode_layer` with zero-based layers,
and the container log has `phase=unseal_setup`, `unseal_load`, `decode_layer`,
`unseal_decode` and `unseal_output` lines with elapsed milliseconds
(`RUST_LOG` target `sdrv2`).

Memory: two sector buffers (64 GiB for 32 GiB sectors) plus the page cache of
the sealed file, which is reclaimable. The DRG parent table adds 20 bytes per
node: 20 GiB for 32 GiB sectors, 84 GiB in total. It is skipped, with a
`phase=drg_parent_table used=false reason=memory_limit` log line, when the
table, the two buffers and a 2 GiB reserve exceed the memory limit of the
container or the physical memory. Building it is inside the measured phase and
appears as the `sdrv2_drg_parent_table` operation. No parent tables and no proof parameters
are read. Fixture preparation uses the same two buffers and writes the sealed
file once at the end.

## Comparing with ZigZag

- Use the same host, image and memory limit, and run both backends in one
  session; do not reuse ZigZag numbers from earlier sessions.
- Run ZigZag with generated parents and with parent tables. SDR v2 has no
  tables, so both comparisons are informative.
- Run SDR v2 with `BENCH_SDRV2_KEY_BLOCKS=5` and with the default.
- Repeat each run three times and report the first run and the median
  separately: the first run reads the sealed file from disk.
- The two constructions use different layer counts and security models (13
  layers for ZigZag, 11 for SDR v2). The result compares cost at the report's
  parameters, not the constructions' guarantees.
- The ZigZag decoder has been optimized over several rounds; this SDR v2 decoder
  is a first version with scalar SHA-256 and Threefish.

## Building

Devnet pins the SDR v2 module at Rust revision
`20eabca3c6e30cff681fbd0b8bb73d17a2a13a44` (branch `restore-sdrv2`), which has
`storage_proofs_porep::sdr_v2` and the `sdr_v2_*` functions of
`filecoin-proofs`. Fetch the managed sources and rebuild the dedicated image
(`just build-zigzag`); no development-source override is required. No Cargo
dependency was added, so the locked overlay `Cargo.lock` is unchanged.
