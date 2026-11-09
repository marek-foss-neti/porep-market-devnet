//! Private-state unseal for the dedicated ZigZag adapters only.
//!
//! Retains the two-buffer mmap reference and offers one private RAM/file state with
//! a bounded output block. Scratch files are unnamed on the selected filesystem: no shared
//! names, stale files to trust on retry, or scratch data left after process exit/SIGKILL.

use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;
use std::time::Instant;

use anyhow::{ensure, Context, Result};
use filecoin_proofs_zigzag as zigzag;
use memmap2::MmapOptions;
use storage_proofs_core_zigzag::{drgraph::Graph, sector::SectorId, settings::SETTINGS};
use storage_proofs_porep_zigzag::zigzag::{
    decode_state::{DecodeMode, DecodeRamAdmission, DecodeStateConfig, DecodeStorage},
    DecodeConfig,
};

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
    let decode = DecodeStateConfig::from_env()?;
    let output_config = zigzag::ZigZagUnsealOutputConfig::from_env()?;
    let cpu_config = storage_proofs_porep_zigzag::zigzag::decode_cpu::DecodeCpuConfig::from_env()?;
    if decode.mode == DecodeMode::Blockwise {
        let started = Instant::now();
        let block_bytes = decode.block_bytes(len)?;
        let parent_config = DecodeConfig::from_env()?;
        let params = zigzag::parameters::zigzag_public_params::<zigzag::ZigZagTree>(config)?;
        let cpu_workspace = cpu_config.workspace_bytes(params.graph.degree())?;
        let active_table_bytes = if SETTINGS.use_zigzag_parent_cache {
            params
                .graph
                .size()
                .checked_mul(params.graph.degree())
                .and_then(|n| n.checked_mul(4))
                .context("ZigZag parent table size overflow")?
        } else {
            0
        };
        let mut ram = if decode.storage != DecodeStorage::File {
            let admitted = DecodeRamAdmission::acquire(
                len,
                // Include the bounded FR32 output in the owned-buffer budget.
                block_bytes
                    .checked_add(output_config.buffer_bytes(len)?)
                    .and_then(|bytes| bytes.checked_add(cpu_workspace))
                    .context("ZigZag unseal buffer budget overflow")?,
                parent_config.parent_buffer_mib * (1 << 20),
                active_table_bytes,
            )
            .and_then(|admission| {
                Ok(RamState {
                    bytes: zeroed_buffer(len)?,
                    _admission: admission,
                })
            });
            match admitted {
                Ok(state) => Some(state),
                Err(error) if decode.storage == DecodeStorage::Auto => {
                    log::info!(target: "zigzag_unseal", "zigzag_decode_state {}", serde_json::json!({
                        "event": "fallback", "storage": "file", "reason": error.to_string(),
                    }));
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let mut block = zeroed_buffer(block_bytes)?;
        let use_ram = ram.is_some();
        let mut scratch_allocated_bytes = 0;
        let (file, mut mapping);
        let data: &mut [u8] = if let Some(state) = ram.as_mut() {
            sealed
                .read_exact_at(&mut state.bytes, 0)
                .context("read ZigZag sealed sector into RAM")?;
            &mut state.bytes
        } else {
            file = prepare_blockwise_scratch(
                sealed,
                scratch_dir,
                u64::from(config.padded_bytes_amount()),
            )?;
            scratch_allocated_bytes = file.metadata()?.blocks() * 512;
            // SAFETY: a private, fully preallocated file, with no writable aliases.
            mapping = unsafe { MmapOptions::new().len(len).map_mut(&file)? };
            &mut mapping
        };
        log::info!(target: "zigzag_unseal", "zigzag_decode_state {}", serde_json::json!({
            "event": "storage", "mode": decode.mode, "requested_storage": decode.storage,
            "storage": if use_ram { "ram" } else { "file" },
            "state_bytes": len, "block_bytes": block_bytes,
            "cpu_workspace_budget_bytes": cpu_workspace,
            "scratch_logical_bytes": if use_ram { 0 } else { len },
            "scratch_allocated_bytes": scratch_allocated_bytes,
            "prepare_ns": started.elapsed().as_nanos(),
        }));
        if output_config.mode == zigzag::ZigZagUnsealOutputMode::Stream {
            return zigzag::zigzag_unseal_range_streaming::<zigzag::ZigZagTree, _>(
                config,
                prover_id,
                sector_id,
                ticket,
                comm_d,
                data,
                &mut block,
                DecodeMode::Blockwise,
                output,
                offset,
                count,
                None,
            );
        }
        return zigzag::zigzag_unseal_range_with_block::<zigzag::ZigZagTree, _>(
            config, prover_id, sector_id, ticket, comm_d, data, &mut block, output, offset, count,
        );
    }
    let sector_bytes = u64::from(config.padded_bytes_amount());
    let (left, right) = prepare_scratch(sealed, scratch_dir, sector_bytes)?;
    // SAFETY: both backing files are private to this call and cannot be accessed or resized
    // by another task. File handles outlive the mappings; neither map aliases the sealed file.
    let mut data = unsafe { MmapOptions::new().len(len).map_mut(&left)? };
    let mut scratch = unsafe { MmapOptions::new().len(len).map_mut(&right)? };
    log::info!(target: "zigzag_unseal", "zigzag_decode_state {}", serde_json::json!({
        "event": "storage", "mode": "ping_pong", "requested_storage": decode.storage,
        "storage": "file", "state_bytes": len, "secondary_state_bytes": len, "block_bytes": 0,
        "scratch_logical_bytes": 2 * sector_bytes,
    }));
    let result = if output_config.mode == zigzag::ZigZagUnsealOutputMode::Stream {
        zigzag::zigzag_unseal_range_streaming::<zigzag::ZigZagTree, _>(
            config,
            prover_id,
            sector_id,
            ticket,
            comm_d,
            &mut data,
            &mut scratch,
            DecodeMode::PingPong,
            output,
            offset,
            count,
            None,
        )
    } else {
        zigzag::zigzag_unseal_range_with_scratch::<zigzag::ZigZagTree, _>(
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
        )
    };
    if let (Ok(left), Ok(right)) = (left.metadata(), right.metadata()) {
        log::info!(target: "zigzag_unseal", "phase=unseal_scratch scratch_logical_bytes={} scratch_allocated_bytes={}",
            left.len() + right.len(), (left.blocks() + right.blocks()) * 512);
    }
    // The scratch files are disposable. Do not force persistence with flush/sync at every layer;
    // dirty pages still count toward cgroup RAM and may cause writeback under memory pressure.
    result
}

struct RamState {
    bytes: Vec<u8>,
    // Drop the large allocation before releasing same-process RAM admission.
    _admission: DecodeRamAdmission,
}

fn zeroed_buffer(bytes: usize) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(bytes)
        .context("allocate ZigZag decode state/block")?;
    buffer.resize(bytes, 0);
    Ok(buffer)
}

pub(crate) fn prepare_blockwise_scratch(
    sealed: &File,
    scratch_dir: &Path,
    bytes: u64,
) -> Result<File> {
    fs::create_dir_all(scratch_dir).context("create ZigZag unseal scratch directory")?;
    let mut file =
        tempfile::tempfile_in(scratch_dir).context("create ZigZag unseal state scratch")?;
    reserve_file(&file, bytes).context("preallocate ZigZag unseal state scratch")?;
    file.set_len(bytes)?;
    let mut input = sealed.try_clone()?;
    input.seek(SeekFrom::Start(0))?;
    copy_exact(&mut input, &mut file, bytes)
        .context("copy ZigZag sealed sector to private state")?;
    Ok(file)
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn blockwise_scratch_is_private_preallocated_and_dropped() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut sealed = tempfile::tempfile()?;
        let original = vec![17; 4096];
        sealed.write_all(&original)?;
        {
            let file = prepare_blockwise_scratch(&sealed, root.path(), 4096)?;
            assert!(file.metadata()?.blocks() * 512 >= 4096);
            let mut mapping = unsafe { MmapOptions::new().map_mut(&file)? };
            assert_eq!(&*mapping, original.as_slice());
            mapping.fill(42);
        }
        sealed.rewind()?;
        let mut actual = Vec::new();
        sealed.read_to_end(&mut actual)?;
        assert_eq!(actual, original);
        assert_eq!(fs::read_dir(root.path())?.count(), 0);
        // A short copy fails and drops the private allocation; a retry is fresh.
        assert!(prepare_blockwise_scratch(&sealed, root.path(), 8192).is_err());
        assert_eq!(fs::read_dir(root.path())?.count(), 0);
        let retry = prepare_blockwise_scratch(&sealed, root.path(), 4096)?;
        assert_eq!(retry.metadata()?.len(), 4096);
        Ok(())
    }
}
