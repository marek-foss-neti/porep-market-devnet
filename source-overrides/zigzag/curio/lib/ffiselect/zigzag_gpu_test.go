package ffiselect

import "testing"

// These tests can run using only these two Go files, without linking FFI or
// loading a driver: go test zigzag_gpu.go zigzag_gpu_test.go.
func TestZigzagGPUChildPreservesSharedLocks(t *testing.T) {
	shared := t.TempDir()
	t.Setenv("FIL_PROOFS_USE_ZIGZAG", "1")
	t.Setenv("BELLMAN_NO_GPU", "0")
	t.Setenv("FIL_PROOFS_ZIGZAG_GPU_LOCK_DIR", shared)
	for _, backend := range []string{"cuda", "opencl"} {
		t.Setenv("FIL_PROOFS_ZIGZAG_GPU_BACKEND", backend)
		actual, err := zigzagGPUTempDir("/private/call")
		if err != nil || actual != shared {
			t.Fatalf("%s: got %q, %v", backend, actual, err)
		}
	}
}

func TestZigzagGPUChildRejectsMissingSharedDirectory(t *testing.T) {
	t.Setenv("FIL_PROOFS_USE_ZIGZAG", "1")
	t.Setenv("FIL_PROOFS_ZIGZAG_GPU_BACKEND", "cuda")
	t.Setenv("BELLMAN_NO_GPU", "0")
	for _, directory := range []string{"", "relative", t.TempDir() + "/missing"} {
		t.Setenv("FIL_PROOFS_ZIGZAG_GPU_LOCK_DIR", directory)
		if _, err := zigzagGPUTempDir("/private/call"); err == nil {
			t.Fatalf("accepted invalid lock directory %q", directory)
		}
	}
}

func TestCPUAndSDRKeepPrivateTemporaryDirectory(t *testing.T) {
	for _, config := range [][3]string{{"0", "cuda", "0"}, {"1", "cpu", "1"}, {"1", "auto", "0"}, {"1", "cuda", "1"}} {
		t.Setenv("FIL_PROOFS_USE_ZIGZAG", config[0])
		t.Setenv("FIL_PROOFS_ZIGZAG_GPU_BACKEND", config[1])
		t.Setenv("BELLMAN_NO_GPU", config[2])
		t.Setenv("FIL_PROOFS_ZIGZAG_GPU_LOCK_DIR", "")
		actual, err := zigzagGPUTempDir("/private/call")
		if err != nil || actual != "/private/call" {
			t.Fatalf("%v: got %q, %v", config, actual, err)
		}
	}
}
