//! File-backed ZigZag pre-commit, used only by the dedicated ZigZag adapters.
//!
//! Adapts the copy -> writable mmap -> `Data` lifecycle from rust-fil-proofs
//! filecoin-proofs/src/api/seal.rs and storage-proofs-core/src/data.rs at
//! e1f017407e0bbadf4b3dd9880d92d750b41b0a85. The existing SDR implementation is
//! unchanged. ZigZag additionally publishes its aux manifest last, after both
//! the replica and its historical Merkle trees are durable.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use storage_proofs_core_zigzag::data::Data;

use super::zigzag_storage::{copy_exact, reserve_file};

const AUX: &str = "zigzag-aux.json";
const WORK: &str = ".zigzag-precommit-work";

/// A retry always starts with fresh input, never with a partially encoded file.
/// Writers for one cache are serialized. As with the seal API, callers must not
/// run other sealing/proving phases concurrently for the same sector cache.
pub(crate) struct FileReplica {
    cache: PathBuf,
    work: PathBuf,
    sealed: PathBuf,
    pending: PathBuf,
    file: File,
    sector_size: u64,
    encoded: bool,
    _lock: File,
}

impl FileReplica {
    pub(crate) fn new(cache: &Path, sealed: &Path, sector_size: u64) -> Result<Self> {
        ensure!(sector_size > 0, "empty ZigZag sector");
        usize::try_from(sector_size).context("ZigZag sector exceeds address space")?;
        fs::create_dir_all(cache)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(cache.join(".zigzag-precommit.lock"))?;
        let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) };
        ensure!(
            rc == 0,
            "lock ZigZag pre-commit: {}",
            io::Error::last_os_error()
        );

        let work = cache.join(WORK);
        // This reserved workspace belongs to this adapter. SIGKILL may leave
        // incomplete trees here; they are never reused as completed cache.
        if let Some(metadata) = metadata_if_present(&work)? {
            ensure!(
                metadata.is_dir(),
                "ZigZag workspace is not a real directory"
            );
            fs::remove_dir_all(&work)?;
        }
        let mut pending_name = sealed
            .file_name()
            .context("replica has no file name")?
            .to_os_string();
        pending_name.push(".zigzag-precommit-pending");
        let pending = sealed.with_file_name(pending_name);
        remove_regular_file(&pending)?;
        fs::create_dir(&work)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&pending)?;
        Ok(Self {
            cache: cache.to_path_buf(),
            work,
            sealed: sealed.to_path_buf(),
            pending,
            file,
            sector_size,
            encoded: false,
            _lock: lock,
        })
    }

    /// Streams add_piece output directly into the future replica file.
    pub(crate) fn prepare<T>(&mut self, write: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        ensure!(!self.encoded, "cannot replace an encoded ZigZag replica");
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        reserve_file(&self.file, self.sector_size).context("preallocate ZigZag replica")?;
        let result = write(&mut self.file)?;
        ensure!(
            self.file.metadata()?.len() == self.sector_size,
            "ZigZag replica length mismatch"
        );
        Ok(result)
    }

    /// Copies either an exact staged sector or only the leaf prefix of TreeD.
    /// A bounded copy preserves the original file, including TreeD's nodes.
    pub(crate) fn copy_from(&mut self, source: &Path, prefix_only: bool) -> Result<()> {
        if self.sealed.exists() {
            ensure!(
                fs::canonicalize(source)? != fs::canonicalize(&self.sealed)?,
                "ZigZag source and replica must be separate files"
            );
        }
        let mut input =
            File::open(source).with_context(|| format!("open ZigZag input {:?}", source))?;
        let size = input.metadata()?.len();
        ensure!(
            if prefix_only {
                size >= self.sector_size
            } else {
                size == self.sector_size
            },
            "ZigZag input length mismatch"
        );
        let sector_size = self.sector_size;
        self.prepare(|output| {
            copy_exact(&mut input, output, sector_size).context("copy ZigZag input to replica")?;
            Ok(())
        })
    }

    pub(crate) fn encode<T>(
        &mut self,
        encode: impl FnOnce(&mut [u8], &Path) -> Result<T>,
    ) -> Result<T> {
        ensure!(!self.encoded, "ZigZag replica already encoded");
        ensure!(
            self.file.metadata()?.len() == self.sector_size,
            "ZigZag replica length mismatch"
        );
        // The private file is held by this transaction and cannot be resized
        // by another adapter writer while its sector lock is held.
        // Let Data own its mapping. Its memmap2 version can differ from FFI's,
        // so pass the path through the existing API instead of a MmapMut.
        let mut data = Data::from_path(self.pending.clone());
        data.ensure_data_of_len(usize::try_from(self.sector_size)?)?;
        let output = encode(data.as_mut(), &self.work)?;
        // Data::drop_data flushes the shared mapping before unmapping it.
        data.drop_data()?;
        self.file.sync_all()?;
        self.encoded = true;
        Ok(output)
    }

    /// The aux manifest is the publication point. Until then a crash leaves
    /// either the previous complete generation or no published generation.
    pub(crate) fn publish(self) -> Result<()> {
        ensure!(self.encoded, "ZigZag encoding did not complete");
        let aux = self.work.join(AUX);
        ensure!(
            metadata_if_present(&aux)?.is_some_and(|m| m.is_file()),
            "missing ZigZag aux manifest"
        );
        let mut trees = Vec::new();
        for entry in fs::read_dir(&self.work)? {
            let entry = entry?;
            ensure!(
                entry.file_type()?.is_file(),
                "unexpected ZigZag cache entry"
            );
            File::open(entry.path())?.sync_all()?;
            if entry.file_name() != AUX {
                trees.push(entry.file_name());
            }
        }
        ensure!(!trees.is_empty(), "missing ZigZag trees");

        // Invalidate readiness before replacing any published tree or replica.
        remove_regular_file(&self.cache.join(AUX))?;
        remove_regular_file(&self.cache.join("zigzag-commit-phase1-v2.json"))?;
        File::open(&self.cache)?.sync_all()?;
        for name in trees {
            fs::rename(self.work.join(&name), self.cache.join(&name))?;
        }
        File::open(&self.cache)?.sync_all()?;
        fs::rename(&self.pending, &self.sealed).context("publish ZigZag replica")?;
        let sealed_parent = self
            .sealed
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        File::open(sealed_parent)?.sync_all()?;
        fs::rename(aux, self.cache.join(AUX)).context("publish ZigZag aux")?;
        File::open(&self.cache)?.sync_all()?;
        Ok(())
    }
}

impl Drop for FileReplica {
    fn drop(&mut self) {
        // Cleanup removes only private work, never the published paths.
        // The lock remains held until cleanup and field destruction finish.
        let _ = fs::remove_file(&self.pending);
        let _ = fs::remove_dir_all(&self.work);
    }
}

fn metadata_if_present(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn remove_regular_file(path: &Path) -> Result<()> {
    if let Some(metadata) = metadata_if_present(path)? {
        ensure!(
            metadata.is_file(),
            "expected a regular ZigZag artifact: {:?}",
            path
        );
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn artifacts(cache: &Path) -> Result<()> {
        fs::write(cache.join("tree.dat"), b"tree")?;
        fs::write(cache.join(AUX), b"completed aux")?;
        Ok(())
    }

    #[test]
    fn preallocation_does_not_hide_a_short_writer() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut replica =
            FileReplica::new(&root.path().join("cache"), &root.path().join("sealed"), 8)?;
        assert!(replica
            .prepare(|file| Ok(file.write_all(b"short")?))
            .is_err());
        assert_eq!(replica.file.metadata()?.len(), 5);
        replica.prepare(|file| Ok(file.write_all(b"complete")?))?;
        replica.encode(|data, work| {
            assert_eq!(data, b"complete");
            artifacts(work)
        })?;
        replica.publish()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "remote-only: private small reflink filesystem at ZIGZAG_REPLICA_TEST_DIR"]
    fn replica_copy_reserves_private_blocks_before_mmap() -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let scratch = PathBuf::from(std::env::var("ZIGZAG_REPLICA_TEST_DIR")?);
        let disk = File::open(&scratch)?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        ensure!(
            unsafe { libc::fstatvfs(disk.as_raw_fd(), stat.as_mut_ptr()) } == 0,
            "fstatvfs: {}",
            io::Error::last_os_error()
        );
        let stat = unsafe { stat.assume_init() };
        let capacity = stat.f_blocks as u64 * stat.f_frsize as u64;
        ensure!(
            (128 << 20..=1024 << 20).contains(&capacity),
            "refuse to fill a non-test filesystem"
        );
        ensure!(
            fs::read_dir(&scratch)?.next().is_none(),
            "test filesystem must be empty"
        );
        let root = tempfile::tempdir_in(&scratch)?;
        // Cache metadata stays on a separate filesystem so this test isolates replica mmap.
        let cache = tempfile::tempdir()?;
        let source = root.path().join("source");
        let sealed = root.path().join("sealed");
        let sector_size = 8 << 20;
        let original = vec![0x31; sector_size as usize];
        fs::write(&source, &original)?;
        let input = File::open(&source)?;
        input.sync_all()?;
        let cloned = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(root.path().join("reflink-control"))?;
        // Positive control: the test must really run on a filesystem supporting shared extents.
        ensure!(
            unsafe { libc::ioctl(cloned.as_raw_fd(), libc::FICLONE, input.as_raw_fd()) } == 0,
            "filesystem must support reflinks: {}",
            io::Error::last_os_error()
        );
        cloned.sync_all()?;

        let fill_remaining = || -> Result<File> {
            let file = tempfile::tempfile_in(root.path())?;
            let mut offset: libc::off_t = 0;
            let mut chunk: libc::off_t = 8 << 20;
            while chunk >= 4096 {
                if unsafe { libc::fallocate(file.as_raw_fd(), 0, offset, chunk) } == 0 {
                    offset += chunk;
                } else {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    ensure!(error.raw_os_error() == Some(libc::ENOSPC), "{error}");
                    chunk /= 2;
                }
            }
            file.sync_all()?;
            Ok(file)
        };

        // Insufficient capacity must be a Result before encoding, with a clean retry.
        let mut replica = FileReplica::new(cache.path(), &sealed, sector_size)?;
        let filler = fill_remaining()?;
        let error = replica.copy_from(&source, false).unwrap_err();
        assert!(format!("{error:#}").contains("preallocate ZigZag replica"));
        assert_eq!(
            error
                .root_cause()
                .downcast_ref::<io::Error>()
                .and_then(|e| e.raw_os_error()),
            Some(libc::ENOSPC)
        );
        drop(replica);
        drop(filler);

        let mut replica = FileReplica::new(cache.path(), &sealed, sector_size)?;
        replica.copy_from(&source, false)?;
        replica.file.sync_all()?;
        assert!(replica.file.metadata()?.blocks() * 512 >= sector_size);
        let filler = fill_remaining()?;
        // Touch every byte after exhausting allocatable space. A shared copy would need CoW
        // blocks here and could kill this isolated test process with SIGBUS.
        replica.encode(|data, work| {
            assert_eq!(data, original);
            data.fill(0x5a);
            artifacts(work)
        })?;
        assert!(fs::read(&replica.pending)?.iter().all(|b| *b == 0x5a));
        assert_eq!(fs::read(&source)?, original);
        assert_eq!(fs::read(root.path().join("reflink-control"))?, original);
        drop(filler);
        drop(replica);
        Ok(())
    }

    #[test]
    fn prefix_copy_preserves_tree_d_and_publishes_encoded_replica() -> Result<()> {
        let root = tempfile::tempdir()?;
        let cache = root.path().join("cache");
        let source = root.path().join("tree-d");
        let sealed = root.path().join("sealed");
        fs::write(&source, b"dataTREE-NODES")?;
        fs::write(&sealed, b"old!")?;
        let mut replica = FileReplica::new(&cache, &sealed, 4)?;
        replica.copy_from(&source, true)?;
        replica.encode(|data, work| {
            assert_eq!(data, b"data");
            data.copy_from_slice(b"new!");
            artifacts(work)
        })?;
        assert_eq!(fs::read(&sealed)?, b"old!");
        assert!(!cache.join(AUX).exists());
        replica.publish()?;
        assert_eq!(fs::read(&source)?, b"dataTREE-NODES");
        assert_eq!(fs::read(&sealed)?, b"new!");
        assert_eq!(fs::read(cache.join(AUX))?, b"completed aux");
        Ok(())
    }

    #[test]
    fn failed_encode_preserves_previous_generation_and_retry_starts_from_input() -> Result<()> {
        let root = tempfile::tempdir()?;
        let cache = root.path().join("cache");
        let sealed = root.path().join("sealed");
        fs::create_dir(&cache)?;
        fs::write(&sealed, b"old!")?;
        fs::write(cache.join(AUX), b"old aux")?;
        {
            let mut replica = FileReplica::new(&cache, &sealed, 4)?;
            replica.prepare(|file| Ok(file.write_all(b"data")?))?;
            let result: Result<()> = replica.encode(|data, work| {
                data.fill(0xff);
                artifacts(work)?;
                anyhow::bail!("interrupted encode")
            });
            assert!(result.is_err());
        }
        assert_eq!(fs::read(&sealed)?, b"old!");
        assert_eq!(fs::read(cache.join(AUX))?, b"old aux");
        // Emulate scratch artifacts left behind by SIGKILL (no Rust Drop).
        fs::create_dir(cache.join(WORK))?;
        fs::write(cache.join(WORK).join(AUX), b"partial")?;
        fs::write(
            sealed.with_file_name("sealed.zigzag-precommit-pending"),
            b"partial",
        )?;
        let mut replica = FileReplica::new(&cache, &sealed, 4)?;
        replica.prepare(|file| Ok(file.write_all(b"data")?))?;
        replica.encode(|data, work| {
            assert_eq!(data, b"data");
            assert!(!work.join(AUX).exists());
            artifacts(work)
        })?;
        replica.publish()?;
        assert_eq!(fs::read(&sealed)?, b"data");
        Ok(())
    }

    #[test]
    fn rejects_short_or_oversized_staged_input_and_unencoded_publication() -> Result<()> {
        let root = tempfile::tempdir()?;
        let input = root.path().join("input");
        for bytes in [b"bad".as_slice(), b"oversized".as_slice()] {
            fs::write(&input, bytes)?;
            let mut replica =
                FileReplica::new(&root.path().join("cache"), &root.path().join("sealed"), 4)?;
            assert!(replica.copy_from(&input, false).is_err());
            assert!(replica.publish().is_err());
        }
        Ok(())
    }

    #[test]
    fn failed_publication_leaves_no_ready_manifest_or_reusable_c1() -> Result<()> {
        let root = tempfile::tempdir()?;
        let cache = root.path().join("cache");
        let sealed = root.path().join("sealed");
        fs::create_dir(&cache)?;
        fs::create_dir(&sealed)?; // Makes the final replica rename fail.
        fs::write(cache.join(AUX), b"old aux")?;
        fs::write(cache.join("zigzag-commit-phase1-v2.json"), b"old C1")?;
        let mut replica = FileReplica::new(&cache, &sealed, 4)?;
        replica.prepare(|file| Ok(file.write_all(b"data")?))?;
        replica.encode(|_, work| artifacts(work))?;
        assert!(replica.publish().is_err());
        assert!(!cache.join(AUX).exists());
        assert!(!cache.join("zigzag-commit-phase1-v2.json").exists());
        assert!(!cache.join(WORK).exists());
        Ok(())
    }

    #[test]
    fn refuses_to_publish_over_the_input_file() -> Result<()> {
        let root = tempfile::tempdir()?;
        let source = root.path().join("source");
        fs::write(&source, b"data")?;
        let mut replica = FileReplica::new(&root.path().join("cache"), &source, 4)?;
        assert!(replica.copy_from(&source, false).is_err());
        assert_eq!(fs::read(&source)?, b"data");
        Ok(())
    }
}
