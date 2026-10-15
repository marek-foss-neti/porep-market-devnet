"""Small synthetic trace tests; no GPU, prover, fixtures or benchmark execution."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "summarize-zigzag-gpu.py"
spec = importlib.util.spec_from_file_location("gpu_summary", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name, text in {
            "stderr.log": "", "nsight-version.txt": "fixture",
            "gpu-device.csv": "uuid,name,memory.total,driver_version\nGPU-test,fixture,32768 MiB,fixture\n",
            "gpu-samples.csv": "timestamp,GPU-test,2048,98\n",
            "summary.json": json.dumps({"verify_seal": True, "raw_unseal_bytes_match": True}),
        }.items():
            (self.root / name).write_text(text)
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.executescript("""
                CREATE TABLE META_DATA_EXPORT(name TEXT, value TEXT);
                INSERT INTO META_DATA_EXPORT VALUES ('EXPORT_SCHEMA_VERSION', '3.29.0');
                CREATE TABLE StringIds(id INTEGER, value TEXT);
                INSERT INTO StringIds VALUES (1, 'Fr_radix_fft'), (2, 'G1_multiexp'), (3, 'cuModuleLoadData');
                CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL(start INTEGER, end INTEGER, demangledName INTEGER);
                INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (10, 20, 1), (30, 70, 2);
                CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY(start INTEGER, end INTEGER, copyKind INTEGER, bytes INTEGER);
                INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (1, 4, 1, 4096);
                CREATE TABLE CUPTI_ACTIVITY_KIND_DRIVER(start INTEGER, end INTEGER, nameId INTEGER);
                INSERT INTO CUPTI_ACTIVITY_KIND_DRIVER VALUES (1, 6, 3);
            """)

    def summary(self, backend="cuda", **statuses):
        with patch.dict(os.environ, {"FIL_PROOFS_ZIGZAG_GPU_BACKEND": backend, "ZIGZAG_REQUIRE_GPU": "1" if backend == "cuda" else "0"}):
            return module.summarize(self.root, statuses.get("profiler", 0), statuses.get("export", 0), statuses.get("child", 0))

    def test_completed_fft_msm_and_cpu_verification(self):
        result = self.summary()
        self.assertTrue(result["gpu_execution_confirmed"])
        self.assertEqual(result["transfers"][0]["bytes"], 4096)
        self.assertEqual(result["initialization_driver_calls"][0]["duration_ns"], 5)
        self.assertEqual(result["sampled_device_vram_peak_bytes"], 2 * 1024**3)

    def test_discovery_vram_or_one_kernel_family_do_not_establish_execution(self):
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("DELETE FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE demangledName=2")
        self.assertFalse(self.summary()["gpu_execution_confirmed"])
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("DELETE FROM CUPTI_ACTIVITY_KIND_KERNEL")
        self.assertFalse(self.summary()["gpu_execution_confirmed"])

    def test_incomplete_kernel_and_failed_verification_are_rejected(self):
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("UPDATE CUPTI_ACTIVITY_KIND_KERNEL SET end=start WHERE demangledName=2")
        self.assertFalse(self.summary()["gpu_execution_confirmed"])
        (self.root / "summary.json").write_text('{"verify_seal": false}')
        self.assertFalse(self.summary()["gpu_execution_confirmed"])

    def test_fallback_after_gpu_work_is_not_accepted(self):
        (self.root / "stderr.log").write_text("GPU FFT failed! Falling back to CPU... Error: fixture")
        result = self.summary()
        self.assertFalse(result["gpu_execution_confirmed"])
        self.assertEqual(len(result["known_fallbacks"]), 1)

    def test_failed_child_profiler_or_export_is_not_accepted(self):
        for statuses in [{"child": 137}, {"profiler": 1}, {"export": 1}]:
            self.assertFalse(self.summary(**statuses)["gpu_execution_confirmed"])

    def test_cpu_control_rejects_kernels_and_accepts_no_kernels(self):
        self.assertTrue(self.summary("cpu")["errors"])
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("DELETE FROM CUPTI_ACTIVITY_KIND_KERNEL")
        result = self.summary("cpu")
        self.assertFalse(result["gpu_execution_confirmed"])
        self.assertEqual(result["errors"], [])

    def test_invalid_trace_fails_cli_for_gpu_and_cpu_control(self):
        (self.root / "cuda-trace.sqlite").write_text("broken")
        for backend, required in [("cuda", "1"), ("cpu", "0")]:
            process = subprocess.run([sys.executable, str(SCRIPT), str(self.root), "0", "0", "0"],
                                     env={**os.environ, "FIL_PROOFS_ZIGZAG_GPU_BACKEND": backend, "ZIGZAG_REQUIRE_GPU": required},
                                     capture_output=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse(json.loads((self.root / "gpu-summary.json").read_text())["gpu_execution_confirmed"])

    def test_missing_trace_or_unknown_schema_is_not_a_complete_cpu_control(self):
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("DELETE FROM CUPTI_ACTIVITY_KIND_KERNEL")
            db.execute("UPDATE META_DATA_EXPORT SET value='4.0.0'")
        self.assertFalse(self.summary("cpu")["trace_complete"])
        self.assertTrue(self.summary("cpu")["errors"])
        (self.root / "cuda-trace.sqlite").unlink()
        self.assertFalse(self.summary("cpu")["trace_complete"])


if __name__ == "__main__":
    unittest.main()
