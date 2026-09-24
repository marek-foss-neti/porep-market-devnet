# ZigZag `zigzag-512` baseline

This is one additional benchmark profile for the first stage of
`x-files/PROMPT-REPLAN.md`. It runs ZigZag only, using the CPU path. The padded
sector is 512 MiB, while the PoRep proof budget follows the 32 GiB ZigZag
configuration: 11 layers, 10 partitions, minimum 176 challenges, and 18
challenges per layer in each partition (1,980 instances). The graph has
16,777,216 nodes and binary tree paths of depth 24. The graph degrees, hashers,
KDF, API version, PoRep variant, and `porep_id` follow the 32 GiB reference.

The profile is compiled only with the `filecoin-proofs/zigzag-bench` feature.
The normal 512 MiB PoRep configuration and registered sector rules remain as
they were. Its parameter cache identifier is derived from the effective 512 MiB
graph and 11-by-18 circuit. The 32 GiB SRS must not be substituted.

The reference commits before the adapter are `a169e1a00075287e3fd5645a565ea14c19b5dced`
for `rust-fil-proofs` and `ec7c0b0dc45ac225792ae97834c2fef1a19bdade` for the
devnet. The benchmark adapter is committed as
`44276f7e52292719e1bbfc90b1a68a39dda9e6f2` in `rust-fil-proofs` and
pinned in `versions.lock.yaml`. Make that commit available to the remote
machine's source checkout before bootstrapping. Then run:

```bash
just bootstrap
just build
just bench-zigzag-512
```

The command creates a dedicated parameter and parent-cache directory and runs
three full seal → prove → verify → unseal cycles. The first parameter prewarm
starts with an empty directory; later prewarms reuse those files. The runner
does not force the operating system page cache to a cold state, so the labels
in the reports describe the parameter directory, not a guaranteed cold RAM
cache. Parameter preparation and loading are recorded separately from the
measured cycle and remain visible in each report.

Each run checks the effective setup before parameter generation, then verifies
that the full run used the same cache identifier and profile. It requires a
1,920-byte proof for all 10 partitions, successful verification, and byte-for-
byte recovery of the full 532,676,608 unpadded bytes. Data uses the fixed
`((byte_index * 31) + (byte_index >> 3) + 17) & 0xff` pattern; prover ID,
ticket, and seed are recorded in `summary.json`.

The aggregate `baseline.json` points to three reports. Each individual report
contains phase times, total container wall time, process and cgroup memory,
swap, CPU and disk series, parameter-preparation time, cache identifier,
build provenance, and image metadata. The aggregate directory also captures
`lscpu`, memory, disks, filesystem free space, and `nvidia-smi`. Keep all raw
reports and telemetry for comparison with later stages.

This profile measures a 512 MiB graph with a 32 GiB proof budget. Its result is
not a timing for sealing a real 32 GiB sector.
