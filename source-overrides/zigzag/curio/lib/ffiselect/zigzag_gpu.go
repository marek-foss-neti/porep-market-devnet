package ffiselect

import (
	"fmt"
	"os"
	"path/filepath"
)

// Bellperson uses TMPDIR for its GPU and PoSt priority locks. Preserve the
// shared directory in explicit ZigZag GPU workers, including their FFI children.
// CPU controls and SDR retain upstream's private per-call temporary directory.
func zigzagGPUTempDir(private string) (string, error) {
	backend := os.Getenv("FIL_PROOFS_ZIGZAG_GPU_BACKEND")
	if os.Getenv("FIL_PROOFS_USE_ZIGZAG") != "1" ||
		(backend != "cuda" && backend != "opencl") || os.Getenv("BELLMAN_NO_GPU") != "0" {
		return private, nil
	}
	shared := os.Getenv("FIL_PROOFS_ZIGZAG_GPU_LOCK_DIR")
	if !filepath.IsAbs(shared) {
		return "", fmt.Errorf("ZigZag GPU FFI requires an absolute shared lock directory")
	}
	info, err := os.Stat(shared)
	if err != nil {
		return "", fmt.Errorf("ZigZag GPU lock directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("ZigZag GPU lock path is not a directory")
	}
	return shared, nil
}
