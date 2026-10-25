package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/filecoin-project/curio/lib/fastparamfetch"
	"github.com/filecoin-project/curio/lib/offlinebench"
	proofparams "github.com/filecoin-project/lotus/build/proof-params"
	"github.com/urfave/cli/v2"
)

func init() { testCmd.Subcommands = append(testCmd.Subcommands, offlineSealBenchCmd) }

var offlineSealBenchCmd = &cli.Command{
	Name:  "bench-seal-unseal",
	Usage: "Offline CPU SDR benchmark through Curio storage, TreeD, FFI and native unseal; no chain or database",
	Flags: []cli.Flag{
		&cli.StringFlag{Name: "run-dir", Required: true},
		&cli.Uint64Flag{Name: "sector-size", Value: 32 << 30},
		&cli.DurationFlag{Name: "sample-interval", Value: 500 * time.Millisecond},
		&cli.BoolFlag{Name: "fetch-params-only", Usage: "Fetch and verify only official PoRep parameters for this sector size"},
	},
	Action: func(c *cli.Context) error {
		size := c.Uint64("sector-size")
		if _, err := offlinebench.ProofType(size); err != nil {
			return err
		}
		if os.Getenv("FIL_PROOFS_USE_ZIGZAG") != "0" {
			return fmt.Errorf("offline SDR benchmark requires FIL_PROOFS_USE_ZIGZAG=0")
		}
		if c.Bool("fetch-params-only") {
			// Do not download WindowPoSt, WinningPoSt, update or aggregation
			// parameters: none is used by this single-sector offline benchmark.
			var all map[string]json.RawMessage
			if err := json.Unmarshal(proofparams.ParametersJSON(), &all); err != nil {
				return err
			}
			selected := map[string]json.RawMessage{}
			for name, entry := range all {
				var info struct {
					SectorSize uint64 `json:"sector_size"`
				}
				if err := json.Unmarshal(entry, &info); err != nil {
					return err
				}
				if strings.Contains(name, "stacked-proof-of-replication-") && info.SectorSize == size && (strings.HasSuffix(name, ".params") || strings.HasSuffix(name, ".vk")) {
					selected[name] = entry
				}
			}
			if len(selected) == 0 {
				return fmt.Errorf("no official PoRep parameters for %d bytes", size)
			}
			manifest, err := json.Marshal(selected)
			if err != nil {
				return err
			}
			return fastparamfetch.GetParams(c.Context, manifest, []byte("{}"), size)
		}
		return offlinebench.Run(c.Context, offlinebench.Config{RunDir: c.String("run-dir"), SectorSize: size, Interval: c.Duration("sample-interval")})
	},
}
