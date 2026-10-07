#!/usr/bin/env bash
# Build variants affect only dedicated ZigZag images, never the standard SDR image.
zigzag_target_cpu="${DEVNET_ZIGZAG_TARGET_CPU:-default}"
zigzag_lto="${DEVNET_ZIGZAG_LTO:-off}"
zigzag_sha_asm="${DEVNET_ZIGZAG_SHA_ASM:-0}"
case "${zigzag_target_cpu}" in default|generic|native) ;; *) devnet_die "ZigZag target CPU must be default, generic or native" ;; esac
case "${zigzag_lto}" in off|thin|fat) ;; *) devnet_die "ZigZag LTO must be off, thin or fat" ;; esac
case "${zigzag_sha_asm}" in 0|1) ;; *) devnet_die "ZigZag SHA asm must be 0 or 1" ;; esac
zigzag_build_settings_sha256="$(printf '%s\n' "${zigzag_target_cpu}" "${zigzag_lto}" "${zigzag_sha_asm}" | shasum -a 256 | awk '{print $1}')"
