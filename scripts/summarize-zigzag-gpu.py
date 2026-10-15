#!/usr/bin/env python3
"""Summarize an Nsight CUDA trace; device discovery never establishes GPU execution."""
import csv
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


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
    try:
        result = json.loads((directory / "summary.json").read_text())
        verified = result.get("verify_seal") is True and result.get("raw_unseal_bytes_match") is True
    except (ValueError, FileNotFoundError):
        verified = False
    control = os.environ.get("FIL_PROOFS_ZIGZAG_GPU_BACKEND") == "cpu"
    complete = profiler_status == 0 and export_status == 0 and child_status == 0 and not errors
    confirmed = complete and verified and fft > 0 and msm > 0 and not fallbacks
    if not complete:
        errors.append("profiler/export/benchmark did not all finish successfully")
    if not verified:
        errors.append("full CPU proof verification and unseal correctness unavailable")
    if control and kernels:
        errors.append("CPU control unexpectedly executed CUDA kernels")
    if not control and not confirmed:
        errors.append("GPU execution not accepted: require completed FFT and MSM kernels, correctness and no recorded fallback")
    return {
        "schema_version": 1, "backend": "cuda", "cpu_control": control,
        "required": os.environ.get("ZIGZAG_REQUIRE_GPU") == "1",
        "trace_complete": complete, "gpu_execution_confirmed": confirmed,
        "export_schema_version": export_schema,
        "fft_kernel_count": fft, "msm_kernel_count": msm, "kernels": kernels,
        "transfers": copies, "initialization_driver_calls": apis,
        "known_fallbacks": fallbacks, "errors": errors,
        "profiler_version": (directory / "nsight-version.txt").read_text().strip(),
        "device_inventory_csv": (directory / "gpu-device.csv").read_text(),
        "sampled_device_vram_peak_bytes": max((s["memory_used_bytes"] for s in samples), default=None),
        "vram_sample_count": len(samples), "device_samples": samples,
        "vram_scope": "whole visible device sampled at 1 s, includes other processes; not host RAM",
        "evidence_scope": "completed CUDA activities in this process; proves FFT and MSM execution, not exclusive GPU execution of every operation",
        "timing_scope": "kernel/transfer/API intervals may overlap; do not add to C2; profiling overhead included",
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
                  "cpu_control": os.environ.get("FIL_PROOFS_ZIGZAG_GPU_BACKEND") == "cpu"}
    target = directory / "gpu-summary.json"
    temporary = target.with_suffix(".temporary")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(target)
    if report.get("required") and not report.get("gpu_execution_confirmed"):
        sys.exit(1)
    if report.get("cpu_control") and report.get("errors"):
        sys.exit(1)
