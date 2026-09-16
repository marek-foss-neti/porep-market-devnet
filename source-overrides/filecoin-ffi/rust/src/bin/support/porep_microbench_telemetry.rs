use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, ensure, Context, Result};
use serde::Serialize;

const TELEMETRY_PATH_ENV: &str = "POREP_PROOF_MICROBENCH_TELEMETRY_PATH";
const TELEMETRY_INTERVAL_ENV: &str = "POREP_PROOF_MICROBENCH_TELEMETRY_INTERVAL_MS";
const DEFAULT_INTERVAL_MS: u64 = 500;
const MIN_INTERVAL_MS: u64 = 100;
const MAX_INTERVAL_MS: u64 = 60_000;

static ACTIVE_RECORDER: OnceLock<Arc<TelemetryRecorder>> = OnceLock::new();

#[derive(Debug, Serialize)]
struct TelemetrySample {
    schema_version: u8,
    sequence: u64,
    pid: u32,
    sampling_interval_ms: u64,
    timestamp_unix_ms: u128,
    elapsed_ms: u128,
    trigger: &'static str,
    phase: &'static str,
    process: ProcessSample,
    cgroup: CgroupSample,
    disk: DiskSample,
    warnings: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
struct ProcessSample {
    vm_size_bytes: Option<u64>,
    rss_bytes: Option<u64>,
    rss_anon_bytes: Option<u64>,
    rss_file_bytes: Option<u64>,
    rss_shmem_bytes: Option<u64>,
    vm_swap_bytes: Option<u64>,
    threads: Option<u64>,
    cpu_ms: u128,
}

#[derive(Debug, Default, Serialize)]
struct CgroupSample {
    memory_current_bytes: Option<u64>,
    memory_peak_bytes: Option<u64>,
    memory_max_bytes: Option<u64>,
    memory_max_unlimited: bool,
    memory_swap_current_bytes: Option<u64>,
    memory_swap_max_bytes: Option<u64>,
    memory_swap_max_unlimited: bool,
    memory_stat: BTreeMap<String, u64>,
    memory_events: BTreeMap<String, u64>,
    cpu_quota_usec: Option<u64>,
    cpu_period_usec: Option<u64>,
    cpu_quota_unlimited: bool,
    cpuset_cpus_effective: Option<String>,
    cpuset_mems_effective: Option<String>,
    cpu_weight: Option<u64>,
    cpu_stat: BTreeMap<String, u64>,
    io_stat: BTreeMap<String, u64>,
    memory_pressure: PressureSample,
    io_pressure: PressureSample,
}

#[derive(Debug, Default, Serialize)]
struct PressureSample {
    some: Option<PressureLine>,
    full: Option<PressureLine>,
}

#[derive(Debug, Serialize)]
struct PressureLine {
    avg10: f64,
    avg60: f64,
    avg300: f64,
    total_usec: u64,
}

#[derive(Debug, Serialize)]
struct DiskSample {
    paths: Vec<DiskPathSample>,
    total_apparent_bytes: u64,
    total_allocated_bytes: u64,
}

#[derive(Debug, Serialize)]
struct DiskPathSample {
    label: String,
    path: String,
    exists: bool,
    apparent_bytes: u64,
    allocated_bytes: u64,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct DiskPath {
    label: String,
    path: PathBuf,
}

struct TelemetryRecorder {
    started: Instant,
    interval_ms: u64,
    cgroup_root: PathBuf,
    disk_paths: Vec<DiskPath>,
    writer: Mutex<BufWriter<File>>,
    phase: Mutex<&'static str>,
    sequence: AtomicU64,
    stopping: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    write_error: Mutex<Option<String>>,
}

pub struct TelemetrySession {
    recorder: Arc<TelemetryRecorder>,
    finished: bool,
}

pub struct PhaseGuard {
    recorder: Option<Arc<TelemetryRecorder>>,
    previous: &'static str,
}

impl TelemetrySession {
    pub fn start(
        work_dir: &Path,
        proof_parameter_cache: &Path,
        parent_cache: &Path,
    ) -> Result<Option<Self>> {
        let Some(output_path) = std::env::var_os(TELEMETRY_PATH_ENV) else {
            return Ok(None);
        };
        let output_path = PathBuf::from(output_path);
        ensure!(
            !output_path.as_os_str().is_empty(),
            "{TELEMETRY_PATH_ENV} must not be empty"
        );
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("create telemetry output directory {}", parent.display())
            })?;
        }
        let interval_ms = telemetry_interval_ms()?;
        let output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output_path)
            .with_context(|| format!("create telemetry output {}", output_path.display()))?;

        let recorder = Arc::new(TelemetryRecorder {
            started: Instant::now(),
            interval_ms,
            cgroup_root: std::env::var_os("POREP_PROOF_MICROBENCH_CGROUP_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/sys/fs/cgroup")),
            disk_paths: telemetry_disk_paths(work_dir, proof_parameter_cache, parent_cache),
            writer: Mutex::new(BufWriter::new(output)),
            phase: Mutex::new("unattributed"),
            sequence: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            worker: Mutex::new(None),
            write_error: Mutex::new(None),
        });
        ACTIVE_RECORDER
            .set(Arc::clone(&recorder))
            .map_err(|_| anyhow!("microbenchmark telemetry was initialized more than once"))?;
        recorder.record_sample("session_start");

        let worker_recorder = Arc::clone(&recorder);
        let worker = thread::Builder::new()
            .name("porep-telemetry".to_string())
            .spawn(move || loop {
                thread::park_timeout(Duration::from_millis(interval_ms));
                if worker_recorder.stopping.load(Ordering::Acquire) {
                    break;
                }
                worker_recorder.record_sample("interval");
            })
            .context("start microbenchmark telemetry sampler")?;
        *recorder
            .worker
            .lock()
            .unwrap_or_else(|lock| lock.into_inner()) = Some(worker);

        Ok(Some(Self {
            recorder,
            finished: false,
        }))
    }

    pub fn finish(mut self) -> Result<()> {
        self.stop();
        self.finished = true;
        if let Some(error) = self
            .recorder
            .write_error
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .clone()
        {
            return Err(anyhow!("microbenchmark telemetry failed: {error}"));
        }
        Ok(())
    }

    fn stop(&mut self) {
        if self.finished {
            return;
        }
        self.recorder.stopping.store(true, Ordering::Release);
        let worker = self
            .recorder
            .worker
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .take();
        if let Some(worker) = worker {
            worker.thread().unpark();
            if worker.join().is_err() {
                self.recorder
                    .remember_write_error("telemetry sampler thread panicked".to_string());
            }
        }
        *self
            .recorder
            .phase
            .lock()
            .unwrap_or_else(|lock| lock.into_inner()) = "finalize";
        self.recorder.record_sample("session_end");
        if let Err(error) = self
            .recorder
            .writer
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .flush()
        {
            self.recorder
                .remember_write_error(format!("flush telemetry output: {error}"));
        }
    }
}

impl Drop for TelemetrySession {
    fn drop(&mut self) {
        self.stop();
    }
}

impl PhaseGuard {
    pub fn enter(name: &'static str) -> Self {
        let Some(recorder) = ACTIVE_RECORDER.get().cloned() else {
            return Self {
                recorder: None,
                previous: "unattributed",
            };
        };
        let previous = {
            let mut phase = recorder
                .phase
                .lock()
                .unwrap_or_else(|lock| lock.into_inner());
            let previous = *phase;
            *phase = name;
            previous
        };
        recorder.record_sample("phase_start");
        Self {
            recorder: Some(recorder),
            previous,
        }
    }
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        if let Some(recorder) = &self.recorder {
            recorder.record_sample("phase_end");
            *recorder
                .phase
                .lock()
                .unwrap_or_else(|lock| lock.into_inner()) = self.previous;
        }
    }
}

impl TelemetryRecorder {
    fn record_sample(&self, trigger: &'static str) {
        let mut warnings = Vec::new();
        let phase = *self.phase.lock().unwrap_or_else(|lock| lock.into_inner());
        let sample = TelemetrySample {
            schema_version: 1,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            pid: std::process::id(),
            sampling_interval_ms: self.interval_ms,
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            elapsed_ms: self.started.elapsed().as_millis(),
            trigger,
            phase,
            process: process_sample(&mut warnings),
            cgroup: cgroup_sample(&self.cgroup_root, &mut warnings),
            disk: disk_sample(&self.disk_paths),
            warnings,
        };

        let write_result = (|| -> Result<()> {
            let mut writer = self.writer.lock().unwrap_or_else(|lock| lock.into_inner());
            serde_json::to_writer(&mut *writer, &sample).context("serialize telemetry sample")?;
            writer.write_all(b"\n").context("write telemetry newline")?;
            writer.flush().context("flush telemetry sample")?;
            Ok(())
        })();
        if let Err(error) = write_result {
            self.remember_write_error(error.to_string());
        }
    }

    fn remember_write_error(&self, error: String) {
        let mut stored = self
            .write_error
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        if stored.is_none() {
            *stored = Some(error);
        }
    }
}

fn telemetry_interval_ms() -> Result<u64> {
    let raw =
        std::env::var(TELEMETRY_INTERVAL_ENV).unwrap_or_else(|_| DEFAULT_INTERVAL_MS.to_string());
    let interval = raw
        .parse::<u64>()
        .with_context(|| format!("{TELEMETRY_INTERVAL_ENV} must be an integer"))?;
    ensure!(
        (MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&interval),
        "{TELEMETRY_INTERVAL_ENV} must be between {MIN_INTERVAL_MS} and {MAX_INTERVAL_MS}"
    );
    Ok(interval)
}

fn telemetry_disk_paths(
    work_dir: &Path,
    proof_parameter_cache: &Path,
    parent_cache: &Path,
) -> Vec<DiskPath> {
    let mut candidates = vec![
        ("work", work_dir.to_path_buf()),
        ("proof-parameters", proof_parameter_cache.to_path_buf()),
        ("parent-cache", parent_cache.to_path_buf()),
    ];
    if let Some(sidecars) = std::env::var_os("FIL_PROOFS_ZIGZAG_SIDECAR_DIR") {
        candidates.push(("zigzag-sidecars", PathBuf::from(sidecars)));
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|(label, path)| {
            let key = path.as_os_str().to_owned();
            if seen.insert(key) {
                Some(DiskPath {
                    label: label.to_string(),
                    path,
                })
            } else {
                None
            }
        })
        .collect()
}

fn process_sample(warnings: &mut Vec<String>) -> ProcessSample {
    let status = match fs::read_to_string("/proc/self/status") {
        Ok(status) => parse_process_status(&status),
        Err(error) => {
            warnings.push(format!("read /proc/self/status: {error}"));
            ProcessSample::default()
        }
    };
    ProcessSample {
        cpu_ms: process_cpu_ms(),
        ..status
    }
}

fn parse_process_status(status: &str) -> ProcessSample {
    let mut sample = ProcessSample::default();
    for line in status.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let mut fields = value.split_ascii_whitespace();
        let Some(raw) = fields.next().and_then(|raw| raw.parse::<u64>().ok()) else {
            continue;
        };
        let bytes = raw.saturating_mul(1024);
        match name {
            "VmSize" => sample.vm_size_bytes = Some(bytes),
            "VmRSS" => sample.rss_bytes = Some(bytes),
            "RssAnon" => sample.rss_anon_bytes = Some(bytes),
            "RssFile" => sample.rss_file_bytes = Some(bytes),
            "RssShmem" => sample.rss_shmem_bytes = Some(bytes),
            "VmSwap" => sample.vm_swap_bytes = Some(bytes),
            "Threads" => sample.threads = Some(raw),
            _ => {}
        }
    }
    sample
}

fn cgroup_sample(root: &Path, warnings: &mut Vec<String>) -> CgroupSample {
    let (memory_max_bytes, memory_max_unlimited) = read_limit(root.join("memory.max"), warnings);
    let (memory_swap_max_bytes, memory_swap_max_unlimited) =
        read_limit(root.join("memory.swap.max"), warnings);
    let (cpu_quota_usec, cpu_period_usec, cpu_quota_unlimited) =
        read_cpu_max(root.join("cpu.max"), warnings);
    CgroupSample {
        memory_current_bytes: read_number(root.join("memory.current"), warnings),
        memory_peak_bytes: read_number(root.join("memory.peak"), warnings),
        memory_max_bytes,
        memory_max_unlimited,
        memory_swap_current_bytes: read_number(root.join("memory.swap.current"), warnings),
        memory_swap_max_bytes,
        memory_swap_max_unlimited,
        memory_stat: read_key_value_file(root.join("memory.stat"), warnings),
        memory_events: read_key_value_file(root.join("memory.events"), warnings),
        cpu_quota_usec,
        cpu_period_usec,
        cpu_quota_unlimited,
        cpuset_cpus_effective: read_trimmed(root.join("cpuset.cpus.effective"), warnings),
        cpuset_mems_effective: read_trimmed(root.join("cpuset.mems.effective"), warnings),
        cpu_weight: read_number(root.join("cpu.weight"), warnings),
        cpu_stat: read_key_value_file(root.join("cpu.stat"), warnings),
        io_stat: read_io_stat(root.join("io.stat"), warnings),
        memory_pressure: read_pressure(root.join("memory.pressure"), warnings),
        io_pressure: read_pressure(root.join("io.pressure"), warnings),
    }
}

fn read_cpu_max(path: PathBuf, warnings: &mut Vec<String>) -> (Option<u64>, Option<u64>, bool) {
    match fs::read_to_string(&path) {
        Ok(content) => match parse_cpu_max(&content) {
            Some(values) => values,
            None => {
                warnings.push(format!("parse {}: expected QUOTA PERIOD", path.display()));
                (None, None, false)
            }
        },
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            (None, None, false)
        }
    }
}

fn parse_cpu_max(content: &str) -> Option<(Option<u64>, Option<u64>, bool)> {
    let mut fields = content.split_ascii_whitespace();
    let raw_quota = fields.next()?;
    let period = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some() {
        return None;
    }
    if raw_quota == "max" {
        Some((None, Some(period), true))
    } else {
        Some((Some(raw_quota.parse::<u64>().ok()?), Some(period), false))
    }
}

fn read_trimmed(path: PathBuf, warnings: &mut Vec<String>) -> Option<String> {
    match fs::read_to_string(&path) {
        Ok(content) => {
            let value = content.trim();
            if value.is_empty() {
                warnings.push(format!("read {}: value is empty", path.display()));
                None
            } else {
                Some(value.to_string())
            }
        }
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            None
        }
    }
}

fn read_number(path: PathBuf, warnings: &mut Vec<String>) -> Option<u64> {
    match fs::read_to_string(&path) {
        Ok(value) => match value.trim().parse::<u64>() {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(format!("parse {}: {error}", path.display()));
                None
            }
        },
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            None
        }
    }
}

fn read_limit(path: PathBuf, warnings: &mut Vec<String>) -> (Option<u64>, bool) {
    match fs::read_to_string(&path) {
        Ok(value) if value.trim() == "max" => (None, true),
        Ok(value) => match value.trim().parse::<u64>() {
            Ok(value) => (Some(value), false),
            Err(error) => {
                warnings.push(format!("parse {}: {error}", path.display()));
                (None, false)
            }
        },
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            (None, false)
        }
    }
}

fn read_key_value_file(path: PathBuf, warnings: &mut Vec<String>) -> BTreeMap<String, u64> {
    match fs::read_to_string(&path) {
        Ok(content) => parse_key_value_lines(&content),
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            BTreeMap::new()
        }
    }
}

fn parse_key_value_lines(content: &str) -> BTreeMap<String, u64> {
    content
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_ascii_whitespace();
            Some((
                fields.next()?.to_string(),
                fields.next()?.parse::<u64>().ok()?,
            ))
        })
        .collect()
}

fn read_io_stat(path: PathBuf, warnings: &mut Vec<String>) -> BTreeMap<String, u64> {
    match fs::read_to_string(&path) {
        Ok(content) => {
            let mut totals = BTreeMap::new();
            for line in content.lines() {
                for field in line.split_ascii_whitespace().skip(1) {
                    let Some((name, raw)) = field.split_once('=') else {
                        continue;
                    };
                    let Some(value) = raw.parse::<u64>().ok() else {
                        continue;
                    };
                    *totals.entry(name.to_string()).or_insert(0) += value;
                }
            }
            totals
        }
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            BTreeMap::new()
        }
    }
}

fn read_pressure(path: PathBuf, warnings: &mut Vec<String>) -> PressureSample {
    match fs::read_to_string(&path) {
        Ok(content) => parse_pressure(&content),
        Err(error) => {
            warnings.push(format!("read {}: {error}", path.display()));
            PressureSample::default()
        }
    }
}

fn parse_pressure(content: &str) -> PressureSample {
    let mut pressure = PressureSample::default();
    for line in content.lines() {
        let mut fields = line.split_ascii_whitespace();
        let Some(kind) = fields.next() else {
            continue;
        };
        let values: BTreeMap<&str, &str> =
            fields.filter_map(|field| field.split_once('=')).collect();
        let parsed = (|| {
            Some(PressureLine {
                avg10: values.get("avg10")?.parse().ok()?,
                avg60: values.get("avg60")?.parse().ok()?,
                avg300: values.get("avg300")?.parse().ok()?,
                total_usec: values.get("total")?.parse().ok()?,
            })
        })();
        match kind {
            "some" => pressure.some = parsed,
            "full" => pressure.full = parsed,
            _ => {}
        }
    }
    pressure
}

fn disk_sample(paths: &[DiskPath]) -> DiskSample {
    let mut samples = Vec::with_capacity(paths.len());
    let mut total_apparent_bytes = 0u64;
    let mut total_allocated_bytes = 0u64;
    for disk_path in paths {
        let (exists, apparent_bytes, allocated_bytes, error) = match disk_usage(&disk_path.path) {
            Ok(Some((apparent, allocated))) => (true, apparent, allocated, None),
            Ok(None) => (false, 0, 0, None),
            Err(error) => (true, 0, 0, Some(error.to_string())),
        };
        total_apparent_bytes = total_apparent_bytes.saturating_add(apparent_bytes);
        total_allocated_bytes = total_allocated_bytes.saturating_add(allocated_bytes);
        samples.push(DiskPathSample {
            label: disk_path.label.clone(),
            path: disk_path.path.display().to_string(),
            exists,
            apparent_bytes,
            allocated_bytes,
            error,
        });
    }
    DiskSample {
        paths: samples,
        total_apparent_bytes,
        total_allocated_bytes,
    }
}

fn disk_usage(root: &Path) -> Result<Option<(u64, u64)>> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("stat disk path {}", root.display()))
        }
    };
    let mut stack = vec![(root.to_path_buf(), root_metadata)];
    let mut apparent = 0u64;
    let mut allocated = 0u64;
    while let Some((path, metadata)) = stack.pop() {
        allocated = allocated.saturating_add(metadata.blocks().saturating_mul(512));
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            apparent = apparent.saturating_add(metadata.len());
            continue;
        }
        if metadata.is_dir() {
            for entry in
                fs::read_dir(&path).with_context(|| format!("read disk path {}", path.display()))?
            {
                let entry =
                    entry.with_context(|| format!("read entry under {}", path.display()))?;
                let child = entry.path();
                let child_metadata = fs::symlink_metadata(&child)
                    .with_context(|| format!("stat disk path {}", child.display()))?;
                stack.push((child, child_metadata));
            }
        }
    }
    Ok(Some((apparent, allocated)))
}

fn process_cpu_ms() -> u128 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if rc != 0 {
        return 0;
    }
    let usage = unsafe { usage.assume_init() };
    timeval_ms(usage.ru_utime) + timeval_ms(usage.ru_stime)
}

fn timeval_ms(value: libc::timeval) -> u128 {
    (value.tv_sec as u128) * 1000 + (value.tv_usec as u128) / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_process_status_in_bytes() {
        let sample = parse_process_status(
            "VmSize:\t100 kB\nVmRSS:\t80 kB\nRssAnon:\t60 kB\nRssFile:\t20 kB\nRssShmem:\t0 kB\nVmSwap:\t4 kB\nThreads:\t9\n",
        );
        assert_eq!(sample.vm_size_bytes, Some(102_400));
        assert_eq!(sample.rss_bytes, Some(81_920));
        assert_eq!(sample.rss_anon_bytes, Some(61_440));
        assert_eq!(sample.rss_file_bytes, Some(20_480));
        assert_eq!(sample.vm_swap_bytes, Some(4_096));
        assert_eq!(sample.threads, Some(9));
    }

    #[test]
    fn parses_pressure_totals() {
        let pressure = parse_pressure(
            "some avg10=1.25 avg60=2.50 avg300=3.75 total=42\nfull avg10=0.10 avg60=0.20 avg300=0.30 total=7\n",
        );
        assert_eq!(pressure.some.as_ref().map(|line| line.total_usec), Some(42));
        assert_eq!(pressure.full.as_ref().map(|line| line.total_usec), Some(7));
    }

    #[test]
    fn sums_io_stats_across_devices() {
        let path =
            std::env::temp_dir().join(format!("porep-telemetry-io-stat-{}", std::process::id()));
        fs::write(
            &path,
            "8:0 rbytes=10 wbytes=20 rios=1 wios=2\n8:16 rbytes=30 wbytes=40 rios=3 wios=4\n",
        )
        .expect("write io.stat fixture");
        let mut warnings = Vec::new();
        let values = read_io_stat(path.clone(), &mut warnings);
        fs::remove_file(path).expect("remove io.stat fixture");
        assert!(warnings.is_empty());
        assert_eq!(values.get("rbytes"), Some(&40));
        assert_eq!(values.get("wbytes"), Some(&60));
        assert_eq!(values.get("rios"), Some(&4));
        assert_eq!(values.get("wios"), Some(&6));
    }

    #[test]
    fn parses_limited_and_unlimited_cpu_max() {
        assert_eq!(
            parse_cpu_max("250000 100000\n"),
            Some((Some(250_000), Some(100_000), false))
        );
        assert_eq!(
            parse_cpu_max("max 100000\n"),
            Some((None, Some(100_000), true))
        );
        assert_eq!(parse_cpu_max("invalid"), None);
    }
}
