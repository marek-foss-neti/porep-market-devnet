#!/usr/bin/env python3
"""Summarize an Nsight CUDA trace; device discovery never establishes GPU execution."""
import csv
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


def tree_r_evidence(log, result, kernel_count):
    """Match completed U2 kernels to every published layer, not configuration."""
    records = []
    for line in log.splitlines():
        try:
            structured = json.loads(line)
            if isinstance(structured, dict):
                line = structured.get("message", structured.get("msg", line))
        except ValueError:
            pass
        if not isinstance(line, str):
            continue
        match = re.search(r"\bzigzag_merkle (\{.*\})\s*$", line)
        if match:
            record = json.loads(match[1])
            if isinstance(record.get("stats", {}).get("gpu"), dict):
                records.append(record)
    layers, size = result.get("porep_layers"), result.get("sector_size_bytes")
    valid = (type(layers) is int and layers > 0 and type(size) is int and size >= 64
             and size % 32 == 0 and (size // 32 & (size // 32 - 1)) == 0)
    batches = hashes = 0
    seen = set()
    for record in records:
        stats, layer = record["stats"]["gpu"], record.get("layer")
        counts = [stats.get(name) for name in ("gpu_hashes", "cpu_hashes", "batches")]
        if type(layer) is not int or layer in seen or not all(type(n) is int and n >= 0 for n in counts):
            valid = False
            continue
        seen.add(layer)
        gpu, cpu, count = counts
        valid = valid and record.get("builder") == "binary" and record.get("leaves") == size // 32
        valid = valid and gpu + cpu == size // 32 - 1 and gpu > 0 and count > 0
        batches += count
        hashes += gpu
    valid = valid and seen == set(range(layers)) and len(records) == layers
    return {"completed_layers": len(records), "logged_batches": batches, "logged_gpu_hashes": hashes,
            "all_layers_match_kernels": bool(valid and batches == kernel_count and kernel_count > 0)}


def summarize(directory, profiler_status, export_status, child_status):
    errors = []
    kernels, copies, apis = [], [], []
    export_schema = None
    database = directory / "cuda-trace.sqlite"
    if export_status == 0 and database.is_file():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "META_DATA_EXPORT" in tables:
                row = db.execute("SELECT value FROM META_DATA_EXPORT WHERE name='EXPORT_SCHEMA_VERSION'").fetchone()
                export_schema = row[0] if row else None
            if not isinstance(export_schema, str) or not re.fullmatch(r"3\.\d+\.\d+", export_schema):
                errors.append("missing or unsupported Nsight export schema")
            if "CUPTI_ACTIVITY_KIND_KERNEL" in tables and "StringIds" in tables:
                kernels = [dict(zip(["name", "count", "duration_ns"], row)) for row in db.execute(
                    "SELECT s.value, count(*), sum(k.end-k.start) FROM CUPTI_ACTIVITY_KIND_KERNEL k "
                    "JOIN StringIds s ON s.id=k.demangledName WHERE k.end > k.start GROUP BY s.value")]
            if "CUPTI_ACTIVITY_KIND_MEMCPY" in tables:
                copies = [dict(zip(["copy_kind", "count", "bytes", "duration_ns"], row)) for row in db.execute(
                    "SELECT copyKind, count(*), sum(bytes), sum(end-start) FROM CUPTI_ACTIVITY_KIND_MEMCPY "
                    "WHERE end > start GROUP BY copyKind")]
            if "CUPTI_ACTIVITY_KIND_DRIVER" in tables and "StringIds" in tables:
                apis = [dict(zip(["name", "count", "duration_ns"], row)) for row in db.execute(
                    "SELECT s.value, count(*), sum(a.end-a.start) FROM CUPTI_ACTIVITY_KIND_DRIVER a "
                    "JOIN StringIds s ON s.id=a.nameId WHERE s.value LIKE 'cuInit%' OR s.value LIKE 'cuModuleLoad%' "
                    "OR s.value LIKE 'cuCtxCreate%' GROUP BY s.value")]
    else:
        errors.append("CUDA trace export unavailable")
    samples = []
    path = directory / "gpu-samples.csv"
    if path.exists():
        for row in csv.reader(path.read_text().splitlines()):
            if len(row) != 4:
                continue
            try:
                samples.append({"timestamp": row[0].strip(), "uuid": row[1].strip(),
                                "memory_used_bytes": int(row[2].strip()) * 1024**2,
                                "utilization_percent": int(row[3].strip())})
            except ValueError:
                continue
    log = (directory / "stderr.log").read_text(errors="replace")
    fallbacks = [line for line in log.splitlines() if re.search(
        r"GPU (?:FFT|Multiexp) failed|Cannot instantiate GPU|No working GPUs found|Falling back to CPU", line)]
    fft = sum(k["count"] for k in kernels if "radix_fft" in k["name"])
    msm = sum(k["count"] for k in kernels if "multiexp" in k["name"])
    poseidon = sum(k["count"] for k in kernels if re.search(r"\bhash_preimages_\w+_2_standard\b", k["name"]))
    result = {}
    try:
        result = json.loads((directory / "summary.json").read_text())
        verified = result.get("verify_seal") is True and result.get("raw_unseal_bytes_match") is True
    except (ValueError, FileNotFoundError):
        verified = False
    tree = tree_r_evidence(log, result, poseidon)
    tree_requested = os.environ.get("FIL_PROOFS_ZIGZAG_TREE_R_GPU") == "1"
    tree_required = os.environ.get("ZIGZAG_REQUIRE_TREE_R_GPU") == "1"
    control = os.environ.get("FIL_PROOFS_ZIGZAG_GPU_BACKEND") == "cpu"
    complete = profiler_status == 0 and export_status == 0 and child_status == 0 and not errors
    confirmed = complete and verified and fft > 0 and msm > 0 and not fallbacks
    tree_confirmed = complete and verified and tree["all_layers_match_kernels"] and not fallbacks
    if not complete:
        errors.append("profiler/export/benchmark did not all finish successfully")
    if not verified:
        errors.append("full CPU proof verification and unseal correctness unavailable")
    if control and kernels:
        errors.append("CPU control unexpectedly executed CUDA kernels")
    if not control and not confirmed:
        errors.append("GPU execution not accepted: require completed FFT and MSM kernels, correctness and no recorded fallback")
    if (tree_requested or tree_required) and not tree_confirmed:
        errors.append("GPU TreeR not accepted: require U2 Poseidon kernels matching all published layers and full proof/unseal correctness")
    return {
        "schema_version": 1, "backend": "cuda", "cpu_control": control,
        "required": os.environ.get("ZIGZAG_REQUIRE_GPU") == "1",
        "trace_complete": complete, "gpu_execution_confirmed": confirmed,
        "tree_r_gpu_required": tree_required, "tree_r_gpu_requested": tree_requested,
        "tree_r_gpu_execution_confirmed": tree_confirmed, "tree_r_evidence": tree,
        "export_schema_version": export_schema,
        "fft_kernel_count": fft, "msm_kernel_count": msm, "poseidon_u2_kernel_count": poseidon, "kernels": kernels,
        "transfers": copies, "initialization_driver_calls": apis,
        "known_fallbacks": fallbacks, "errors": errors,
        "profiler_version": (directory / "nsight-version.txt").read_text().strip(),
        "device_inventory_csv": (directory / "gpu-device.csv").read_text(),
        "sampled_device_vram_peak_bytes": max((s["memory_used_bytes"] for s in samples), default=None),
        "vram_sample_count": len(samples), "device_samples": samples,
        "vram_scope": "whole visible device sampled at 1 s, includes other processes; not host RAM",
        "evidence_scope": "C2 FFT/MSM and TreeR U2 Poseidon acceptance are separate; TreeR also requires published-layer/hash/batch counts; not exclusive GPU execution of every operation",
        "timing_scope": "kernel/transfer/API intervals may overlap; do not add to sealing; transfer and initialization totals cover BOTH TreeR and C2; profiling overhead included",
        "cold_warm_scope": "first batch includes cold device/kernel initialization; subsequent batch timings remain in report.c2_suboperations",
        "kernel_compilation": "CUDA fatbin compiled at image build; driver module load/JIT may occur per Bellperson kernel instance",
    }


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    try:
        report = summarize(directory, *map(int, sys.argv[2:5]))
    except Exception as error:
        report = {"schema_version": 1, "gpu_execution_confirmed": False, "trace_complete": False,
                  "errors": [str(error)], "required": os.environ.get("ZIGZAG_REQUIRE_GPU") == "1",
                  "tree_r_gpu_execution_confirmed": False,
                  "tree_r_gpu_required": os.environ.get("ZIGZAG_REQUIRE_TREE_R_GPU") == "1",
                  "cpu_control": os.environ.get("FIL_PROOFS_ZIGZAG_GPU_BACKEND") == "cpu"}
    target = directory / "gpu-summary.json"
    temporary = target.with_suffix(".temporary")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(target)
    if report.get("required") and not report.get("gpu_execution_confirmed"):
        sys.exit(1)
    if report.get("tree_r_gpu_required") and not report.get("tree_r_gpu_execution_confirmed"):
        sys.exit(1)
    if report.get("cpu_control") and report.get("errors"):
        sys.exit(1)
