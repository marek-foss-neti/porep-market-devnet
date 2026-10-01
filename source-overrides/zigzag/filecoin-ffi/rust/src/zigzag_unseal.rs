//! File-backed unseal for the dedicated ZigZag adapters only.
//!
//! Reuses the SDR copy -> writable mmap lifecycle and ZigZag's two-buffer decode API.
//! Scratch files are unnamed temporary files on the caller-selected filesystem: no shared
//! names, stale files to trust on retry, or scratch data left after process exit/SIGKILL.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

use anyhow::{ensure, Context, Result};
use filecoin_proofs_zigzag as zigzag;
use memmap2::MmapOptions;
use storage_proofs_core_zigzag::sector::SectorId;

/// Reserve actual blocks before exposing the file to mmap writes. A sparse set_len, a
/// free-space check, or an unsupported-filesystem fallback cannot provide this guarantee.
fn reserve_scratch(file: &File, bytes: u64) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let len = libc::off_t::try_from(bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "scratch size exceeds off_t")
        })?;
        loop {
            // SAFETY: file owns a live descriptor; offset/length are nonnegative. Mode 0
            // allocates blocks and extends the private file without punching holes.
            if unsafe { libc::fallocate(file.as_raw_fd(), 0, 0, len) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (file, bytes);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ZigZag file-backed unseal requires Linux fallocate",
        ))
    }
}

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
    reserve_scratch(&left, sector_bytes).context("preallocate ZigZag unseal input scratch")?;
    reserve_scratch(&right, sector_bytes).context("preallocate ZigZag unseal output scratch")?;
    let started = Instant::now();
    let mut input = sealed.try_clone()?;
    input.seek(SeekFrom::Start(0))?;
    // Do not use io::copy/fs::copy: copy_file_range may replace allocated extents with
    // shared CoW/reflink blocks, reintroducing allocation failures on later mmap writes.
    let mut buffer = vec![0u8; 1 << 20];
    let mut remaining = sector_bytes;
    while remaining != 0 {
        let take = remaining.min(buffer.len() as u64) as usize;
        input
            .read_exact(&mut buffer[..take])
            .context("read ZigZag sealed sector")?;
        left.write_all(&buffer[..take])
            .context("copy ZigZag sealed sector to scratch")?;
        remaining -= take as u64;
    }
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
