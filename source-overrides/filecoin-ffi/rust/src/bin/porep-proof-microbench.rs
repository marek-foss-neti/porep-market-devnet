use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use filecoin_proofs_api::seal;
use filecoin_proofs_api::{
    PaddedBytesAmount as ApiPaddedBytesAmount, RegisteredSealProof, SectorId as ApiSectorId,
    UnpaddedByteIndex as ApiUnpaddedByteIndex, UnpaddedBytesAmount as ApiUnpaddedBytesAmount,
};
use filecoin_proofs_zigzag as zigzag;
use filecoin_proofs_zigzag::with_shape;
use rand::rngs::OsRng;
use serde::Serialize;
use storage_proofs_core_zigzag::{
    api_version::ApiVersion as ZigZagApiVersion,
    compound_proof::CompoundProof,
    merkle::MerkleTreeTrait,
    parameter_cache::CacheableParameters,
    sector::SectorId as ZigZagSectorId,
};
use storage_proofs_porep_zigzag::{
    stacked::{StackedCircuit, StackedCompound, StackedDrg},
    zigzag::{
        circuit::{ZigZagCircuit, ZigZagCompound},
        ZigZagDrgPoRep,
    },
};

const PROVER_ID: [u8; 32] = [4u8; 32];
const TICKET: [u8; 32] = [7u8; 32];
const SEED: [u8; 32] = [0xffu8; 32];
const SECTOR_SIZE_2_KIB: u64 = 2 * 1024;
const SECTOR_SIZE_8_MIB: u64 = 8 * 1024 * 1024;
const SECTOR_SIZE_512_MIB: u64 = 512 * 1024 * 1024;
const SECTOR_SIZE_32_GIB: u64 = 32 * 1024 * 1024 * 1024;
const DEFAULT_MAX_LOCAL_SECTOR_SIZE: u64 = SECTOR_SIZE_8_MIB;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Backend {
    Stacked,
    ZigZag,
}

#[derive(Debug, Serialize)]
struct PhaseMetric {
    name: &'static str,
    wall_ms: u128,
    cpu_ms: u128,
    max_rss_bytes: u64,
}

#[derive(Debug, Serialize)]
struct BenchmarkSummary {
    schema_version: u8,
    backend: Backend,
    sector_size_label: String,
    sector_size_bytes: u64,
    registered_seal_proof: String,
    registered_seal_proof_id: i32,
    work_dir: String,
    proof_parameter_cache: String,
    proof_len: usize,
    unsealed_bytes: usize,
    verify_seal: bool,
    raw_unseal_bytes_match: bool,
    phases: Vec<PhaseMetric>,
}

#[derive(Debug, Serialize)]
struct ParamPrewarmSummary {
    schema_version: u8,
    backend: Backend,
    sector_size_label: String,
    sector_size_bytes: u64,
    registered_seal_proof: String,
    registered_seal_proof_id: i32,
    proof_parameter_cache: String,
    parameter_cache_identifier: String,
    parameter_cache_metadata_path: String,
    parameter_cache_params_path: String,
    parameter_cache_verifying_key_path: String,
    verifying_key_matches_params: bool,
    verifying_key_rewritten: bool,
    wall_ms: u128,
    cpu_ms: u128,
    max_rss_bytes: u64,
}

#[derive(Debug)]
struct ParamPrewarmResult {
    cache_identifier: String,
    metadata_path: PathBuf,
    params_path: PathBuf,
    verifying_key_path: PathBuf,
    verifying_key_matches_params: bool,
    verifying_key_rewritten: bool,
}

fn main() -> Result<()> {
    let args = Args::parse(std::env::args().skip(1).collect())?;
    fs::create_dir_all(&args.work_dir).context("create work directory")?;

    if args.prewarm_only {
        let summary = prewarm_params(&args)?;
        println!("{}", serde_json::to_string_pretty(&summary)?);
        return Ok(());
    }

    let summary = match args.backend {
        Backend::Stacked => run_stacked(&args)?,
        Backend::ZigZag => run_zigzag(&args)?,
    };
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

struct Args {
    backend: Backend,
    sector_size_label: String,
    sector_size_bytes: u64,
    work_dir: PathBuf,
    prewarm_only: bool,
}

impl Args {
    fn parse(raw: Vec<String>) -> Result<Self> {
        let mut backend = None;
        let mut sector_size = None;
        let mut work_dir = None;
        let mut prewarm_only = false;
        let mut iter = raw.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--backend" => {
                    backend = Some(parse_backend(&required_arg(&mut iter, "--backend")?)?)
                }
                "--sector-size" => {
                    sector_size =
                        Some(parse_sector_size(&required_arg(&mut iter, "--sector-size")?)?)
                }
                "--work-dir" => {
                    work_dir = Some(PathBuf::from(required_arg(&mut iter, "--work-dir")?))
                }
                "--prewarm-only" => prewarm_only = true,
                "--help" | "-h" => {
                    println!("usage: porep-proof-microbench --backend stacked|zigzag --sector-size 2kib|8mib|512mib|32gib --work-dir PATH [--prewarm-only]");
                    std::process::exit(0);
                }
                _ => bail!("unknown argument: {arg}"),
            }
        }

        let backend = backend.unwrap_or(Backend::Stacked);
        let (sector_size_label, sector_size_bytes) =
            sector_size.unwrap_or_else(|| ("8mib".to_string(), 8 * 1024 * 1024));
        if sector_size_bytes > DEFAULT_MAX_LOCAL_SECTOR_SIZE && !large_sector_microbench_enabled() {
            bail!(
                "sector size {sector_size_label} is intentionally disabled for the local microbench because it allocates and verifies a full sector; set POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 to opt in"
            );
        }
        if backend == Backend::ZigZag
            && !matches!(
                sector_size_bytes,
                SECTOR_SIZE_2_KIB | SECTOR_SIZE_8_MIB | SECTOR_SIZE_512_MIB | SECTOR_SIZE_32_GIB
            )
        {
            bail!("ZigZag microbench supports only 2KiB, 8MiB, 512MiB, and 32GiB sectors in this restore-zigzag overlay");
        }
        let work_dir = work_dir.unwrap_or_else(default_work_dir);
        Ok(Self {
            backend,
            sector_size_label,
            sector_size_bytes,
            work_dir,
            prewarm_only,
        })
    }
}

fn large_sector_microbench_enabled() -> bool {
    std::env::var("POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS")
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn required_arg(iter: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    iter.next().with_context(|| format!("{name} requires a value"))
}

fn parse_backend(value: &str) -> Result<Backend> {
    match value.to_ascii_lowercase().as_str() {
        "stacked" | "sdr" => Ok(Backend::Stacked),
        "zigzag" => Ok(Backend::ZigZag),
        _ => bail!("invalid backend: {value}"),
    }
}

fn parse_sector_size(value: &str) -> Result<(String, u64)> {
    let normalized = value
        .to_ascii_lowercase()
        .replace(['_', '-', ' '], "")
        .replace("kb", "kib")
        .replace("mb", "mib")
        .replace("gb", "gib");
    let bytes = match normalized.as_str() {
        "2kib" => 2 * 1024,
        "8mib" => 8 * 1024 * 1024,
        "512mib" => 512 * 1024 * 1024,
        "32gib" => 32 * 1024 * 1024 * 1024,
        "64gib" => bail!("64GiB is a registered Filecoin sector size, but this branch wires ZigZag comparison for 512MiB and 32GiB as the large-sector targets"),
        "2mib" | "2gib" | "8gib" => bail!(
            "{value} is not a Filecoin registered seal proof sector size; use 2KiB, 8MiB, 512MiB, or 32GiB"
        ),
        _ => bail!("unsupported sector size: {value}"),
    };
    Ok((normalized, bytes))
}

fn default_work_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "porep-proof-microbench-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    ))
}

fn prewarm_params(args: &Args) -> Result<ParamPrewarmSummary> {
    let registered_proof = registered_proof_for_sector_size(args.sector_size_bytes)?;
    eprintln!(
        "prewarming {:?} PoRep parameters for {} in {}",
        args.backend,
        args.sector_size_label,
        proof_parameter_cache_dir().display()
    );
    let cpu_before = process_cpu_ms();
    let started = Instant::now();
    let prewarm = match args.backend {
        Backend::Stacked => prewarm_stacked_params(args, registered_proof)?,
        Backend::ZigZag => prewarm_zigzag_params(args, registered_proof)?,
    };
    let summary = ParamPrewarmSummary {
        schema_version: 1,
        backend: args.backend,
        sector_size_label: args.sector_size_label.clone(),
        sector_size_bytes: args.sector_size_bytes,
        registered_seal_proof: format!("{registered_proof:?}"),
        registered_seal_proof_id: registered_proof as i32,
        proof_parameter_cache: proof_parameter_cache_dir().display().to_string(),
        parameter_cache_identifier: prewarm.cache_identifier,
        parameter_cache_metadata_path: prewarm.metadata_path.display().to_string(),
        parameter_cache_params_path: prewarm.params_path.display().to_string(),
        parameter_cache_verifying_key_path: prewarm.verifying_key_path.display().to_string(),
        verifying_key_matches_params: prewarm.verifying_key_matches_params,
        verifying_key_rewritten: prewarm.verifying_key_rewritten,
        wall_ms: started.elapsed().as_millis(),
        cpu_ms: process_cpu_ms().saturating_sub(cpu_before),
        max_rss_bytes: max_rss_bytes(),
    };
    eprintln!(
        "prewarmed {:?} PoRep parameters for {} in {} ms",
        args.backend, args.sector_size_label, summary.wall_ms
    );
    Ok(summary)
}

fn prewarm_stacked_params(
    args: &Args,
    registered_proof: RegisteredSealProof,
) -> Result<ParamPrewarmResult> {
    let porep_config = zigzag::PoRepConfig::new_groth16(
        args.sector_size_bytes,
        registered_proof.as_v1_config().porep_id,
        ZigZagApiVersion::V1_1_0,
    );
    with_shape!(args.sector_size_bytes, prewarm_stacked_params_for_shape, porep_config)
}

fn prewarm_stacked_params_for_shape<Tree: 'static + MerkleTreeTrait>(
    porep_config: zigzag::PoRepConfig,
) -> Result<ParamPrewarmResult> {
    let public_params = zigzag::parameters::public_params::<Tree>(&porep_config)
        .context("get Stacked public params")?;
    let cache_identifier = <StackedCompound<
        Tree,
        zigzag::constants::DefaultPieceHasher,
    > as CacheableParameters<
        StackedCircuit<Tree, zigzag::constants::DefaultPieceHasher>,
        _,
    >>::cache_identifier(&public_params);
    let metadata_path =
        storage_proofs_core_zigzag::parameter_cache::parameter_cache_metadata_path(
            &cache_identifier,
        );
    let params_path = storage_proofs_core_zigzag::parameter_cache::parameter_cache_params_path(
        &cache_identifier,
    );
    let verifying_key_path =
        storage_proofs_core_zigzag::parameter_cache::parameter_cache_verifying_key_path(
            &cache_identifier,
        );
    let circuit = <StackedCompound<Tree, zigzag::constants::DefaultPieceHasher> as CompoundProof<
        StackedDrg<Tree, zigzag::constants::DefaultPieceHasher>,
        StackedCircuit<Tree, zigzag::constants::DefaultPieceHasher>,
    >>::blank_circuit(&public_params);

    let _ = StackedCompound::<Tree, zigzag::constants::DefaultPieceHasher>::get_param_metadata(
        circuit.clone(),
        &public_params,
    )
    .context("cache Stacked parameter metadata")?;
    let groth_params =
        StackedCompound::<Tree, zigzag::constants::DefaultPieceHasher>::get_groth_params(
            Some(&mut OsRng),
            circuit.clone(),
            &public_params,
        )
        .context("cache Stacked Groth params")?;
    let verifying_key =
        StackedCompound::<Tree, zigzag::constants::DefaultPieceHasher>::get_verifying_key(
            Some(&mut OsRng),
            circuit,
            &public_params,
        )
        .context("cache Stacked verifying key")?;
    let verifying_key_matches_params = verifying_key == groth_params.vk;
    let verifying_key_rewritten = if verifying_key_matches_params {
        false
    } else {
        eprintln!(
            "cached Stacked verifying key did not match Groth params; rewriting {}",
            verifying_key_path.display()
        );
        let mut file = File::create(&verifying_key_path).with_context(|| {
            format!(
                "create repaired Stacked verifying key cache file {}",
                verifying_key_path.display()
            )
        })?;
        groth_params
            .vk
            .write(&mut file)
            .with_context(|| {
                format!(
                    "write repaired Stacked verifying key {}",
                    verifying_key_path.display()
                )
            })?;
        file.flush()
            .with_context(|| {
                format!(
                    "flush repaired Stacked verifying key {}",
                    verifying_key_path.display()
                )
            })?;
        true
    };
    Ok(ParamPrewarmResult {
        cache_identifier,
        metadata_path,
        params_path,
        verifying_key_path,
        verifying_key_matches_params: true,
        verifying_key_rewritten,
    })
}

fn prewarm_zigzag_params(
    args: &Args,
    registered_proof: RegisteredSealProof,
) -> Result<ParamPrewarmResult> {
    let porep_config = zigzag_porep_config(args, registered_proof);
    let public_params =
        zigzag::parameters::zigzag_public_params::<zigzag::constants::ZigZagTree>(&porep_config)
            .context("get ZigZag public params")?;
    let cache_identifier = <ZigZagCompound<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    > as CacheableParameters<
        ZigZagCircuit<zigzag::constants::ZigZagTree, zigzag::constants::DefaultPieceHasher>,
        _,
    >>::cache_identifier(&public_params);
    let metadata_path =
        storage_proofs_core_zigzag::parameter_cache::parameter_cache_metadata_path(
            &cache_identifier,
        );
    let params_path = storage_proofs_core_zigzag::parameter_cache::parameter_cache_params_path(
        &cache_identifier,
    );
    let verifying_key_path =
        storage_proofs_core_zigzag::parameter_cache::parameter_cache_verifying_key_path(
            &cache_identifier,
        );
    let circuit = <ZigZagCompound<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    > as CompoundProof<
        ZigZagDrgPoRep<zigzag::constants::ZigZagTree, zigzag::constants::DefaultPieceHasher>,
        _,
    >>::blank_circuit(&public_params);

    let _ = ZigZagCompound::<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    >::get_param_metadata(circuit.clone(), &public_params)
    .context("cache ZigZag parameter metadata")?;
    let groth_params = ZigZagCompound::<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    >::get_groth_params(Some(&mut OsRng), circuit.clone(), &public_params)
    .context("cache ZigZag Groth params")?;
    let verifying_key = ZigZagCompound::<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    >::get_verifying_key(Some(&mut OsRng), circuit, &public_params)
    .context("cache ZigZag verifying key")?;
    let verifying_key_matches_params = verifying_key == groth_params.vk;
    let verifying_key_rewritten = if verifying_key_matches_params {
        false
    } else {
        eprintln!(
            "cached ZigZag verifying key did not match Groth params; rewriting {}",
            verifying_key_path.display()
        );
        let mut file = File::create(&verifying_key_path).with_context(|| {
            format!(
                "create repaired ZigZag verifying key cache file {}",
                verifying_key_path.display()
            )
        })?;
        groth_params
            .vk
            .write(&mut file)
            .with_context(|| {
                format!(
                    "write repaired ZigZag verifying key {}",
                    verifying_key_path.display()
                )
            })?;
        file.flush()
            .with_context(|| {
                format!(
                    "flush repaired ZigZag verifying key {}",
                    verifying_key_path.display()
                )
            })?;
        true
    };
    Ok(ParamPrewarmResult {
        cache_identifier,
        metadata_path,
        params_path,
        verifying_key_path,
        verifying_key_matches_params: true,
        verifying_key_rewritten,
    })
}

fn run_stacked(args: &Args) -> Result<BenchmarkSummary> {
    let registered_proof = registered_proof_for_sector_size(args.sector_size_bytes)?;
    let cache_dir = args.work_dir.join("seal-cache");
    fs::create_dir_all(&cache_dir).context("create seal cache")?;
    let staged_path = args.work_dir.join("staged.dat");
    let sealed_path = args.work_dir.join("sealed.dat");

    let raw = deterministic_bytes(usize::from(ApiUnpaddedBytesAmount::from(ApiPaddedBytesAmount(
        args.sector_size_bytes,
    ))));
    let mut staged = File::create(&staged_path).context("create staged sector")?;
    let (piece_info, _written) = seal::write_and_preprocess(
        registered_proof,
        Cursor::new(&raw),
        &mut staged,
        ApiUnpaddedBytesAmount(raw.len() as u64),
    )?;
    let piece_infos = vec![piece_info];
    drop(staged);
    File::create(&sealed_path).context("create sealed sector")?;

    let mut phases = Vec::new();
    let sector_id = ApiSectorId::from(0);

    let phase1_out = measure(&mut phases, "pre_commit_phase1", || {
        seal::seal_pre_commit_phase1(
            registered_proof,
            &cache_dir,
            &staged_path,
            &sealed_path,
            PROVER_ID,
            sector_id,
            TICKET,
            &piece_infos,
        )
    })?;

    let pre_commit = measure(&mut phases, "pre_commit_phase2", || {
        seal::seal_pre_commit_phase2(phase1_out, &cache_dir, &sealed_path)
    })?;

    let commit_phase1 = measure(&mut phases, "prove_from_cache_equivalent_phase1", || {
        seal::seal_commit_phase1(
            &cache_dir,
            &sealed_path,
            PROVER_ID,
            sector_id,
            TICKET,
            SEED,
            pre_commit.clone(),
            &piece_infos,
        )
    })?;

    let proof = measure(&mut phases, "prove_from_cache_equivalent_phase2", || {
        seal::seal_commit_phase2(commit_phase1, PROVER_ID, sector_id)
    })?
    .proof;

    let verify = measure(&mut phases, "verify", || {
        seal::verify_seal(
            registered_proof,
            pre_commit.comm_r,
            pre_commit.comm_d,
            PROVER_ID,
            sector_id,
            TICKET,
            SEED,
            &proof,
        )
    })?;

    let mut unsealed = Vec::new();
    measure(&mut phases, "raw_unseal", || {
        seal::get_unsealed_range_mapped(
            registered_proof,
            &cache_dir,
            &sealed_path,
            &mut unsealed,
            PROVER_ID,
            sector_id,
            pre_commit.comm_d,
            TICKET,
            ApiUnpaddedByteIndex(0),
            ApiUnpaddedBytesAmount(raw.len() as u64),
        )
    })?;

    Ok(BenchmarkSummary {
        schema_version: 1,
        backend: Backend::Stacked,
        sector_size_label: args.sector_size_label.clone(),
        sector_size_bytes: args.sector_size_bytes,
        registered_seal_proof: format!("{registered_proof:?}"),
        registered_seal_proof_id: registered_proof as i32,
        work_dir: args.work_dir.display().to_string(),
        proof_parameter_cache: proof_parameter_cache_dir().display().to_string(),
        proof_len: proof.len(),
        unsealed_bytes: unsealed.len(),
        verify_seal: verify,
        raw_unseal_bytes_match: raw == unsealed,
        phases,
    })
}

fn run_zigzag(args: &Args) -> Result<BenchmarkSummary> {
    let registered_proof = registered_proof_for_sector_size(args.sector_size_bytes)?;
    let cache_dir = args.work_dir.join("zigzag-cache");
    fs::create_dir_all(&cache_dir).context("create ZigZag cache")?;
    let sealed_path = args.work_dir.join("zigzag-sealed.dat");

    let porep_config = zigzag_porep_config(args, registered_proof);
    let raw = deterministic_bytes(usize::from(zigzag::UnpaddedBytesAmount::from(
        zigzag::PaddedBytesAmount(args.sector_size_bytes),
    )));
    let mut staged = Vec::new();
    let (piece_info, _written) = zigzag::add_piece(
        Cursor::new(&raw),
        &mut staged,
        zigzag::UnpaddedBytesAmount(raw.len() as u64),
        &[],
    )?;
    let piece_infos = vec![piece_info];

    let mut phases = Vec::new();
    let sector_id = ZigZagSectorId::from(0);

    let (phase1_out, state) = measure(&mut phases, "pre_commit_phase1", || {
        zigzag::zigzag_pre_commit_phase1::<zigzag::constants::ZigZagTree>(
            &porep_config,
            &cache_dir,
            PROVER_ID,
            sector_id,
            TICKET,
            &mut staged,
            &piece_infos,
        )
    })?;
    drop(state);
    fs::write(&sealed_path, &staged).context("write ZigZag sealed sector")?;

    let pre_commit = measure(&mut phases, "pre_commit_phase2", || {
        zigzag::zigzag_pre_commit_phase2(&cache_dir, &phase1_out)
    })?;

    let commit = measure(&mut phases, "prove_from_cache", || {
        zigzag::zigzag_prove_from_cache::<zigzag::constants::ZigZagTree>(
            &porep_config,
            &cache_dir,
            pre_commit.comm_d,
            pre_commit.comm_r,
            pre_commit.comm_r_star,
            PROVER_ID,
            sector_id,
            TICKET,
            Some(SEED),
        )
    })?;

    let verify = measure(&mut phases, "verify", || {
        zigzag::zigzag_verify_seal::<zigzag::constants::ZigZagTree>(
            &porep_config,
            pre_commit.comm_r,
            pre_commit.comm_d,
            pre_commit.comm_r_star,
            PROVER_ID,
            sector_id,
            TICKET,
            Some(SEED),
            &commit.proof,
        )
    })?;

    let mut sealed = Vec::new();
    File::open(&sealed_path)
        .context("open ZigZag sealed sector")?
        .read_to_end(&mut sealed)
        .context("read ZigZag sealed sector")?;
    let mut unsealed = Vec::new();
    measure(&mut phases, "raw_unseal", || {
        zigzag::zigzag_unseal_range::<zigzag::constants::ZigZagTree, _>(
            &porep_config,
            PROVER_ID,
            sector_id,
            TICKET,
            pre_commit.comm_d,
            &mut sealed,
            &mut unsealed,
            zigzag::UnpaddedByteIndex(0),
            zigzag::UnpaddedBytesAmount(raw.len() as u64),
        )
    })?;

    Ok(BenchmarkSummary {
        schema_version: 1,
        backend: Backend::ZigZag,
        sector_size_label: args.sector_size_label.clone(),
        sector_size_bytes: args.sector_size_bytes,
        registered_seal_proof: format!("{registered_proof:?}"),
        registered_seal_proof_id: registered_proof as i32,
        work_dir: args.work_dir.display().to_string(),
        proof_parameter_cache: proof_parameter_cache_dir().display().to_string(),
        proof_len: commit.proof.len(),
        unsealed_bytes: unsealed.len(),
        verify_seal: verify,
        raw_unseal_bytes_match: raw == unsealed,
        phases,
    })
}

fn zigzag_porep_config(
    args: &Args,
    registered_proof: RegisteredSealProof,
) -> zigzag::PoRepConfig {
    zigzag::PoRepConfig::new_groth16(
        args.sector_size_bytes,
        registered_proof.as_v1_config().porep_id,
        ZigZagApiVersion::V1_2_0,
    )
}

fn measure<T>(phases: &mut Vec<PhaseMetric>, name: &'static str, action: impl FnOnce() -> Result<T>) -> Result<T> {
    let cpu_before = process_cpu_ms();
    let started = Instant::now();
    let result = action();
    let wall_ms = started.elapsed().as_millis();
    let cpu_ms = process_cpu_ms().saturating_sub(cpu_before);
    phases.push(PhaseMetric {
        name,
        wall_ms,
        cpu_ms,
        max_rss_bytes: max_rss_bytes(),
    });
    result
}

fn registered_proof_for_sector_size(sector_size: u64) -> Result<RegisteredSealProof> {
    Ok(match sector_size {
        2_048 => RegisteredSealProof::StackedDrg2KiBV1_1,
        8_388_608 => RegisteredSealProof::StackedDrg8MiBV1_1,
        536_870_912 => RegisteredSealProof::StackedDrg512MiBV1_1,
        34_359_738_368 => RegisteredSealProof::StackedDrg32GiBV1_1,
        _ => bail!("unsupported registered sector size: {sector_size}"),
    })
}

fn deterministic_bytes(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| {
            let value = index as u64;
            (value.wrapping_mul(31).wrapping_add(value >> 3).wrapping_add(17) & 0xff) as u8
        })
        .collect()
}

fn proof_parameter_cache_dir() -> PathBuf {
    std::env::var("FIL_PROOFS_PARAMETER_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/var/tmp/filecoin-proof-parameters"))
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

fn max_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if rc != 0 {
        return 0;
    }
    let usage = unsafe { usage.assume_init() };
    #[cfg(target_os = "macos")]
    {
        usage.ru_maxrss as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        (usage.ru_maxrss as u64) * 1024
    }
}
