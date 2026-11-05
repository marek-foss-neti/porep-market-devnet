//! Fixed benchmark profiles: 512 MiB comparison and 8 MiB development.

use anyhow::{ensure, Result};
use filecoin_proofs_api::RegisteredSealProof;
use filecoin_proofs_zigzag as zigzag;
use serde::Serialize;
use storage_proofs_core_zigzag::{api_version::ApiVersion, parameter_cache::CacheableParameters};
use storage_proofs_porep_zigzag::zigzag::circuit::{ZigZagCircuit, ZigZagCompound};

pub const NAME: &str = zigzag::zigzag_bench::NAME;
pub const DEV_NAME: &str = zigzag::zigzag_bench::DEV_NAME;

#[derive(Debug, Serialize)]
pub struct EffectiveProfile {
    pub name: &'static str,
    pub padded_sector_bytes: u64,
    pub nodes: usize,
    pub binary_tree_depth: u32,
    pub layers: usize,
    pub partitions: usize,
    pub minimum_challenges: usize,
    pub challenges_per_layer_per_partition: usize,
    pub total_challenge_instances: usize,
    pub degree: usize,
    pub expansion_degree: usize,
    pub porep_id_hex: String,
    pub api_version: String,
    pub parameter_cache_identifier: String,
    pub deterministic_data_pattern: &'static str,
    pub prover_id_hex: String,
    pub ticket_hex: String,
    pub seed_hex: String,
}

pub fn config() -> zigzag::PoRepConfig {
    let porep_id = RegisteredSealProof::StackedDrg32GiBV1_1
        .as_v1_config()
        .porep_id;
    zigzag::zigzag_bench::config(porep_id, ApiVersion::V1_2_0)
}

pub fn config_8mib() -> zigzag::PoRepConfig {
    zigzag::zigzag_bench::config_8mib(config().porep_id, ApiVersion::V1_2_0)
}

pub fn effective(
    name: Option<&str>,
    registered_proof: RegisteredSealProof,
) -> Result<Option<EffectiveProfile>> {
    if name.is_none() {
        return Ok(None);
    }
    let (
        name,
        config,
        expected_proof,
        sector_bytes,
        expected_partitions,
        minimum,
        expected_challenges,
    ) = match name {
        Some(NAME) => (
            NAME,
            config(),
            RegisteredSealProof::StackedDrg512MiBV1_1,
            1u64 << 29,
            10,
            176,
            18,
        ),
        Some(DEV_NAME) => (
            DEV_NAME,
            config_8mib(),
            RegisteredSealProof::StackedDrg8MiBV1_1,
            1u64 << 23,
            2,
            4,
            2,
        ),
        _ => anyhow::bail!("unexpected ZigZag profile"),
    };
    ensure!(
        registered_proof == expected_proof,
        "{name} has the wrong registered sector geometry"
    );
    let setup = zigzag::parameters::zigzag_setup_params(&config)?;
    let reference = zigzag::PoRepConfig::new_groth16(1 << 35, config.porep_id, config.api_version);
    let reference_setup = zigzag::parameters::zigzag_setup_params(&reference)?;
    let public =
        zigzag::parameters::zigzag_public_params::<zigzag::constants::ZigZagTree>(&config)?;
    let partitions = usize::from(config.partitions);
    let layers = setup.layer_challenges.layers();
    let challenges = setup.layer_challenges.challenges_for_layer(0);
    ensure!(
        u64::from(config.sector_size) == sector_bytes,
        "wrong sector geometry"
    );
    ensure!(
        setup.nodes == (sector_bytes / 32) as usize && setup.nodes.is_power_of_two(),
        "wrong graph geometry"
    );
    ensure!(
        layers == 17 && partitions == expected_partitions && config.minimum_challenges() == minimum,
        "wrong ZigZag proof budget"
    );
    ensure!(
        (0..layers)
            .all(|layer| setup.layer_challenges.challenges_for_layer(layer) == expected_challenges),
        "wrong challenges in ZigZag layer"
    );
    ensure!(setup.porep_id == config.porep_id, "wrong PoRep identifier");
    ensure!(
        setup.degree == reference_setup.degree
            && setup.expansion_degree == reference_setup.expansion_degree
            && setup.porep_id == reference_setup.porep_id
            && setup.api_version == reference_setup.api_version
            && (name == DEV_NAME
                || (challenges == reference_setup.layer_challenges.challenges_for_layer(0)
                    && config.partitions.0 == reference.partitions.0
                    && config.minimum_challenges() == reference.minimum_challenges())),
        "ZigZag profile differs from its reference setup"
    );
    let cache_identifier = <ZigZagCompound<
        zigzag::constants::ZigZagTree,
        zigzag::constants::DefaultPieceHasher,
    > as CacheableParameters<
        ZigZagCircuit<zigzag::constants::ZigZagTree, zigzag::constants::DefaultPieceHasher>,
        _,
    >>::cache_identifier(&public);
    Ok(Some(EffectiveProfile {
        name,
        padded_sector_bytes: u64::from(config.sector_size),
        nodes: setup.nodes,
        binary_tree_depth: setup.nodes.trailing_zeros(),
        layers,
        partitions,
        minimum_challenges: config.minimum_challenges(),
        challenges_per_layer_per_partition: challenges,
        total_challenge_instances: layers * partitions * challenges,
        degree: setup.degree,
        expansion_degree: setup.expansion_degree,
        porep_id_hex: config
            .porep_id
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        api_version: format!("{:?}", config.api_version),
        parameter_cache_identifier: cache_identifier,
        deterministic_data_pattern: "((byte_index * 31) + (byte_index >> 3) + 17) & 0xff",
        prover_id_hex: "04".repeat(32),
        ticket_hex: "07".repeat(32),
        seed_hex: "ff".repeat(32),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_profile_uses_distinct_parameters_and_rejects_wrong_geometry() {
        let dev = effective(Some(DEV_NAME), RegisteredSealProof::StackedDrg8MiBV1_1)
            .unwrap()
            .unwrap();
        let comparison = effective(Some(NAME), RegisteredSealProof::StackedDrg512MiBV1_1)
            .unwrap()
            .unwrap();
        assert_eq!(dev.total_challenge_instances, 68);
        assert_eq!(dev.layers, comparison.layers);
        assert_eq!(dev.partitions, 2);
        assert_ne!(
            dev.parameter_cache_identifier,
            comparison.parameter_cache_identifier
        );
        assert!(effective(Some(DEV_NAME), RegisteredSealProof::StackedDrg512MiBV1_1).is_err());
        assert!(effective(Some(NAME), RegisteredSealProof::StackedDrg8MiBV1_1).is_err());
    }
}
