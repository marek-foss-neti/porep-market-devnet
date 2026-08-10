# Source Overrides

This directory contains the local devnet source overrides that are copied into
the pinned Curio, Lotus, filecoin-ffi, and FVM source trees during Docker builds.

The overrides replace the previous `patches/*.patch` build step. Keeping full
files here makes the ZigZag integration easier to inspect, review, and eventually
promote into upstream branches or dedicated forks. Docker images record the
aggregate override hash in `io.porep-market.zigzag.source-overrides.sha256`, and
startup validation rejects images whose recorded hash does not match the local
override files.

When an override is no longer needed, remove the file here and update the Docker
copy surface plus static tests in the same change.
