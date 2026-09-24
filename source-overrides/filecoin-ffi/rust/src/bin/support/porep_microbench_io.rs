//! Streaming deterministic input and exact output checks for the benchmark runner.

use std::io::{self, Read, Write};

fn deterministic_byte(index: u64) -> u8 {
    (index
        .wrapping_mul(31)
        .wrapping_add(index >> 3)
        .wrapping_add(17)
        & 0xff) as u8
}

pub(crate) struct DeterministicReader {
    position: u64,
    remaining: u64,
}

impl DeterministicReader {
    pub(crate) fn new(offset: u64, len: u64) -> Self {
        Self {
            position: offset,
            remaining: len,
        }
    }
}

impl Read for DeterministicReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let n = buf.len().min(self.remaining as usize);
        for (index, byte) in buf[..n].iter_mut().enumerate() {
            *byte = deterministic_byte(self.position + index as u64);
        }
        self.position += n as u64;
        self.remaining -= n as u64;
        Ok(n)
    }
}

pub(crate) struct DeterministicVerifySink {
    offset: u64,
    pub(crate) written: u64,
    pub(crate) mismatch_at: Option<u64>,
}

impl DeterministicVerifySink {
    pub(crate) fn new(offset: u64) -> Self {
        Self {
            offset,
            written: 0,
            mismatch_at: None,
        }
    }

    pub(crate) fn matches_expected(&self, expected_len: u64) -> bool {
        self.written == expected_len && self.mismatch_at.is_none()
    }
}

impl Write for DeterministicVerifySink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.mismatch_at.is_none() {
            for (index, actual) in buf.iter().enumerate() {
                let position = self.offset + self.written + index as u64;
                if *actual != deterministic_byte(position) {
                    self.mismatch_at = Some(position);
                    break;
                }
            }
        }
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed bytes from the original full-buffer fixture, independent of the streaming reader.
    const PREFIX: [u8; 16] = [
        17, 48, 79, 110, 141, 172, 203, 234, 10, 41, 72, 103, 134, 165, 196, 227,
    ];

    #[test]
    fn reader_preserves_fixture_across_chunk_and_padding_boundaries() {
        for chunk_size in [1, 7, 127, 128, 4096, 8192] {
            let mut reader = DeterministicReader::new(0, 4097);
            let mut actual = Vec::new();
            let mut chunk = vec![0; chunk_size];
            assert_eq!(reader.read(&mut []).unwrap(), 0);
            loop {
                let n = reader.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                actual.extend_from_slice(&chunk[..n]);
            }
            assert_eq!(actual.len(), 4097);
            assert_eq!(&actual[..16], &PREFIX);
            assert_eq!((actual[127], actual[128]), (129, 161));
            assert_eq!((actual[4095], actual[4096]), (241, 17));
            assert_eq!(reader.read(&mut chunk).unwrap(), 0);
        }
    }

    #[test]
    fn range_reader_and_sink_preserve_absolute_offsets() {
        let mut actual = Vec::new();
        DeterministicReader::new(8, 8)
            .read_to_end(&mut actual)
            .unwrap();
        assert_eq!(&actual, &PREFIX[8..]);
        let mut sink = DeterministicVerifySink::new(8);
        for chunk in PREFIX[8..].chunks(3) {
            sink.write_all(chunk).unwrap();
        }
        assert!(sink.matches_expected(8));
    }

    #[test]
    fn sink_rejects_corruption_and_retains_first_mismatch() {
        for bad_byte in [0, 7, 15] {
            let mut bytes = PREFIX;
            bytes[bad_byte] ^= 1;
            let mut sink = DeterministicVerifySink::new(0);
            for chunk in bytes.chunks(3) {
                sink.write_all(chunk).unwrap();
            }
            assert_eq!(sink.written, 16);
            assert_eq!(sink.mismatch_at, Some(bad_byte as u64));
            assert!(!sink.matches_expected(16));
            sink.write_all(&[0, 0]).unwrap();
            assert_eq!(sink.written, 18);
            assert_eq!(sink.mismatch_at, Some(bad_byte as u64));
        }
        let mut range = DeterministicVerifySink::new(8);
        range.write_all(&[0]).unwrap();
        assert_eq!(range.mismatch_at, Some(8));
    }

    #[test]
    fn sink_rejects_truncated_and_extra_output_even_when_bytes_match() {
        let mut sink = DeterministicVerifySink::new(0);
        assert!(!sink.matches_expected(16));
        sink.write_all(&PREFIX[..15]).unwrap();
        assert!(!sink.matches_expected(16));
        sink.write_all(&PREFIX[15..]).unwrap();
        assert!(sink.matches_expected(16));
        assert!(!sink.matches_expected(15));
        assert_eq!(sink.mismatch_at, None);
    }

    #[test]
    fn streaming_copy_checks_a_full_piece_without_retaining_it() {
        let len = 127 * 1024;
        let mut reader = DeterministicReader::new(0, len);
        let mut sink = DeterministicVerifySink::new(0);
        assert_eq!(io::copy(&mut reader, &mut sink).unwrap(), len);
        assert!(sink.matches_expected(len));
    }
}
