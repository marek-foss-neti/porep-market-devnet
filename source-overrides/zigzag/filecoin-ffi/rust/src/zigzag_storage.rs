//! Disk allocation and bounded copying for writable ZigZag replicas and scratch buffers.

use std::fs::File;
use std::io::{self, Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;

/// Reserve private file space without extending the logical length. Keeping the length
/// lets streaming writers detect a short input even though its capacity is preallocated.
pub(super) fn reserve_file(file: &File, bytes: u64) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let len = libc::off_t::try_from(bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "ZigZag file size exceeds off_t",
            )
        })?;
        loop {
            // SAFETY: a live descriptor, a nonnegative offset and a checked length.
            if unsafe { libc::fallocate(file.as_raw_fd(), libc::FALLOC_FL_KEEP_SIZE, 0, len) } == 0
            {
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
            "ZigZag writable file buffers require Linux fallocate",
        ))
    }
}

/// Do not replace preallocated blocks with reflinks via io::copy/copy_file_range.
/// All bytes go through a bounded userspace buffer; allocation/I/O failures are Results.
pub(super) fn copy_exact(
    input: &mut impl Read,
    output: &mut impl Write,
    bytes: u64,
) -> io::Result<()> {
    let mut buffer = vec![0u8; bytes.min(1 << 20) as usize];
    let mut remaining = bytes;
    while remaining != 0 {
        let take = remaining.min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..take])?;
        output.write_all(&buffer[..take])?;
        remaining -= take as u64;
    }
    Ok(())
}
