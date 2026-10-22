package seal

import "testing"

func TestZigzagTreeRCResources(t *testing.T) {
	t.Setenv("CURIO_NEW_MINER_SECTOR_SIZE", "32gib")
	t.Setenv("FIL_PROOFS_USE_ZIGZAG", "1")
	t.Setenv("FIL_PROOFS_ZIGZAG_GPU_BACKEND", "cuda")
	t.Setenv("FIL_PROOFS_ZIGZAG_TREE_R_GPU", "1")
	t.Setenv("BELLMAN_NO_GPU", "0")
	cpu, gpu, ram, max := zigzagTreeRCResources(1, 0, 512<<20, 4)
	if cpu != zigzagPoRepCpu() || gpu != 1 || ram != 60<<30 || max != 1 {
		t.Fatalf("GPU PC1 resources: cpu=%d gpu=%v ram=%d max=%d", cpu, gpu, ram, max)
	}
	for _, setting := range []struct{ key, value string }{
		{"FIL_PROOFS_USE_ZIGZAG", "0"},
		{"FIL_PROOFS_ZIGZAG_TREE_R_GPU", "0"},
		{"FIL_PROOFS_ZIGZAG_GPU_BACKEND", "cpu"},
		{"BELLMAN_NO_GPU", "1"},
	} {
		t.Run(setting.key, func(t *testing.T) {
			t.Setenv(setting.key, setting.value)
			cpu, gpu, ram, max := zigzagTreeRCResources(1, 0.5, 8<<30, 4)
			if cpu != 1 || gpu != 0.5 || ram != 8<<30 || max != 4 {
				t.Fatal("changed resources outside the explicit ZigZag GPU TreeR path")
			}
		})
	}
}
