//! File-backed unseal for the dedicated ZigZag adapters only.
//!
//! Reuses the SDR copy -> writable mmap lifecycle and ZigZag's two-buffer decode API.
//! Scratch files are unnamed temporary files on the caller-selected filesystem: no shared
//! names, stale files to trust on retry, or scratch data left after process exit/SIGKILL.

use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

use anyhow::{ensure, Context, Result};
use filecoin_proofs_zigzag as zigzag;
use memmap2::MmapOptions;
use storage_proofs_core_zigzag::sector::SectorId;

use super::zigzag_storage::{copy_exact, reserve_file};

pub(crate) fn prepare_scratch(
    sealed: &File,
    scratch_dir: &Path,
    sector_bytes: u64,
) -> Result<(File, File)> {
    fs::create_dir_all(scratch_dir).context("create ZigZag unseal scratch directory")?;
    let mut left =
        tempfile::tempfile_in(scratch_dir).context("create ZigZag unseal input scratch")?;
    let right =
        tempfile::tempfile_in(scratch_dir).context("create ZigZag unseal output scratch")?;
    // Reserve BOTH buffers before copying or mapping. ENOSPC/EDQUOT/EOPNOTSUPP must be
    // ordinary errors here, rather than SIGBUS inside the parallel mmap decoder.
    reserve_file(&left, sector_bytes).context("preallocate ZigZag unseal input scratch")?;
    reserve_file(&right, sector_bytes).context("preallocate ZigZag unseal output scratch")?;
    left.set_len(sector_bytes)?;
    right.set_len(sector_bytes)?;
    let started = Instant::now();
    let mut input = sealed.try_clone()?;
    input.seek(SeekFrom::Start(0))?;
    copy_exact(&mut input, &mut left, sector_bytes)
        .context("copy ZigZag sealed sector to scratch")?;
    log::info!(target: "zigzag_unseal", "phase=unseal_copy elapsed_ms={}", started.elapsed().as_millis());
    Ok((left, right))
}

/// The sealed file is copied, never mapped writable. The caller must keep it stable during
/// the copy and must use an independent output writer. All temporary resources drop on error.
#[allow(clippy::too_many_arguments)]
pub(crate) fn unseal_range<W: Write>(
    config: &zigzag::PoRepConfig,
    sealed: &File,
    scratch_dir: &Path,
    output: W,
    prover_id: [u8; 32],
    sector_id: SectorId,
    ticket: [u8; 32],
    comm_d: [u8; 32],
    offset: zigzag::UnpaddedByteIndex,
    count: zigzag::UnpaddedBytesAmount,
) -> Result<zigzag::UnpaddedBytesAmount> {
    let len = validate_range(config, sealed, offset, count)?;
    if count.0 == 0 {
        return Ok(count);
    }
    let sector_bytes = u64::from(config.padded_bytes_amount());
    let (left, right) = prepare_scratch(sealed, scratch_dir, sector_bytes)?;
    // SAFETY: both backing files are private to this call and cannot be accessed or resized
    // by another task. File handles outlive the mappings; neither map aliases the sealed file.
    let mut data = unsafe { MmapOptions::new().len(len).map_mut(&left)? };
    let mut scratch = unsafe { MmapOptions::new().len(len).map_mut(&right)? };
    let result = zigzag::zigzag_unseal_range_with_scratch::<zigzag::ZigZagTree, _>(
        config,
        prover_id,
        sector_id,
        ticket,
        comm_d,
        &mut data,
        &mut scratch,
        output,
        offset,
        count,
    );
    if let (Ok(left), Ok(right)) = (left.metadata(), right.metadata()) {
        log::info!(target: "zigzag_unseal", "phase=unseal_scratch scratch_logical_bytes={} scratch_allocated_bytes={}",
            left.len() + right.len(), (left.blocks() + right.blocks()) * 512);
    }
    // The scratch files are disposable. Do not force persistence with flush/sync at every layer;
    // dirty pages still count toward cgroup RAM and may cause writeback under memory pressure.
    result
}

/// Validate metadata and bounds without selecting, creating or accessing scratch storage.
pub(crate) fn validate_range(
    config: &zigzag::PoRepConfig,
    sealed: &File,
    offset: zigzag::UnpaddedByteIndex,
    count: zigzag::UnpaddedBytesAmount,
) -> Result<usize> {
    let sector_bytes = u64::from(config.padded_bytes_amount());
    let len = usize::try_from(sector_bytes).context("ZigZag sector exceeds address space")?;
    let metadata = sealed.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() == sector_bytes,
        "invalid ZigZag sealed file size/type"
    );
    let end = offset
        .0
        .checked_add(count.0)
        .context("unseal range overflow")?;
    ensure!(
        end <= zigzag::UnpaddedBytesAmount::from(config.padded_bytes_amount()).0,
        "unseal range exceeds sector size"
    );
    Ok(len)
}
