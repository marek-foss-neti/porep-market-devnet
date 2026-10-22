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

    def tree_fixture(self):
        (self.root / "summary.json").write_text(json.dumps({"verify_seal": True, "raw_unseal_bytes_match": True,
                                                         "porep_layers": 2, "sector_size_bytes": 512}))
        records = [{"builder": "binary", "layer": layer, "leaves": 16,
                    "stats": {"gpu": {"gpu_hashes": 12, "cpu_hashes": 3, "batches": 3}}} for layer in range(2)]
        # Exercise both plain Rust and structured log formats.
        (self.root / "stderr.log").write_text("zigzag_merkle " + json.dumps(records[0]) + "\n" +
            json.dumps({"message": "zigzag_merkle " + json.dumps(records[1])}) + "\n")
        with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
            db.execute("INSERT INTO StringIds VALUES (4, 'hash_preimages_blstrs__scalar__Scalar_2_standard')")
            db.executemany("INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (?, ?, 4)", [(100 + i * 10, 105 + i * 10) for i in range(6)])

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

    def test_tree_acceptance_requires_all_layers_and_correctness(self):
        self.tree_fixture()
        result = self.summary()
        self.assertTrue(result["gpu_execution_confirmed"])
        self.assertTrue(result["tree_r_gpu_execution_confirmed"])
        self.assertEqual(result["poseidon_u2_kernel_count"], 6)
        self.assertEqual(result["tree_r_evidence"]["logged_gpu_hashes"], 24)
        original = (self.root / "stderr.log").read_text()
        for broken in [original.splitlines()[0], original + original,
                       original.replace('"gpu_hashes": 12', '"gpu_hashes": 11')]:
            (self.root / "stderr.log").write_text(broken)
            self.assertFalse(self.summary()["tree_r_gpu_execution_confirmed"])
        (self.root / "stderr.log").write_text(original)
        (self.root / "summary.json").write_text('{"verify_seal": false}')
        self.assertFalse(self.summary()["tree_r_gpu_execution_confirmed"])

    def test_other_poseidon_arity_or_incomplete_trace_does_not_pass(self):
        self.tree_fixture()
        for name in ["hash_preimages_blstrs__scalar__Scalar_8_standard", "hash_preimages_blstrs__scalar__Scalar_2_strengthened"]:
            with sqlite3.connect(self.root / "cuda-trace.sqlite") as db:
                db.execute("UPDATE StringIds SET value=? WHERE id=4", (name,))
            result = self.summary()
            self.assertTrue(result["gpu_execution_confirmed"])
            self.assertFalse(result["tree_r_gpu_execution_confirmed"])
        self.assertFalse(self.summary(child=137)["tree_r_gpu_execution_confirmed"])

    def test_required_tree_cli_rejects_c2_only_and_corrupt_trace(self):
        env = {**os.environ, "FIL_PROOFS_ZIGZAG_GPU_BACKEND": "cuda", "ZIGZAG_REQUIRE_GPU": "0",
               "ZIGZAG_REQUIRE_TREE_R_GPU": "1"}
        for corrupt in [False, True]:
            if corrupt:
                (self.root / "cuda-trace.sqlite").write_text("broken")
            process = subprocess.run([sys.executable, str(SCRIPT), str(self.root), "0", "0", "0"], env=env, capture_output=True)
            self.assertNotEqual(process.returncode, 0)
            result = json.loads((self.root / "gpu-summary.json").read_text())
            self.assertFalse(result["tree_r_gpu_execution_confirmed"])


if __name__ == "__main__":
    unittest.main()
