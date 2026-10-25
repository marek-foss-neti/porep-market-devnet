// Package offlinebench runs Curio's single-sector CPU sealing implementation
// without a chain, market contracts, wallets, or a Harmony database.
package offlinebench

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/filecoin-project/curio/lib/ffi"
	"github.com/filecoin-project/curio/lib/ffiselect"
	"github.com/filecoin-project/curio/lib/paths"
	"github.com/filecoin-project/curio/lib/storiface"
	filecoinffi "github.com/filecoin-project/filecoin-ffi"
	"github.com/filecoin-project/go-state-types/abi"
	"github.com/filecoin-project/go-state-types/proof"
	"github.com/filecoin-project/lotus/storage/sealer/fr32"
	"github.com/google/uuid"
	"github.com/ipfs/go-cid"
)

type Config struct {
	RunDir     string
	SectorSize uint64
	Interval   time.Duration
}

type Result struct {
	SchemaVersion  int                     `json:"schema_version"`
	Kind           string                  `json:"kind"`
	Status         string                  `json:"status"`
	Error          string                  `json:"error,omitempty"`
	SectorSize     uint64                  `json:"sector_size_bytes"`
	Host           map[string]any          `json:"host"`
	ProofType      abi.RegisteredSealProof `json:"registered_seal_proof"`
	Miner          uint64                  `json:"miner_id"`
	Sector         uint64                  `json:"sector_number"`
	Ticket         string                  `json:"ticket_hex"`
	Seed           string                  `json:"seed_hex"`
	CommD          string                  `json:"comm_d,omitempty"`
	CommR          string                  `json:"comm_r,omitempty"`
	SourceSHA256   string                  `json:"source_sha256,omitempty"`
	UnsealedSHA256 string                  `json:"unsealed_sha256,omitempty"`
	ProofBytes     int                     `json:"proof_bytes"`
	Verified       bool                    `json:"verify_seal"`
	UnsealMatch    bool                    `json:"unseal_matches_source"`
	StartedAt      time.Time               `json:"started_at"`
	FinishedAt     *time.Time              `json:"finished_at,omitempty"`
	Phases         []*Phase                `json:"phases"`
}

func ProofType(size uint64) (abi.RegisteredSealProof, error) {
	switch size {
	case 8 << 20:
		return abi.RegisteredSealProof_StackedDrg8MiBV1_1, nil
	case 32 << 30:
		return abi.RegisteredSealProof_StackedDrg32GiBV1_1, nil
	default:
		return 0, fmt.Errorf("offline benchmark supports 32 GiB and the 8 MiB smoke test only")
	}
}

// Run requires a fresh work directory; it never attaches to existing sectors.
func Run(ctx context.Context, cfg Config) (err error) {
	pt, err := ProofType(cfg.SectorSize)
	if err != nil {
		return err
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("run this benchmark inside the Linux Docker image")
	}
	if cfg.Interval < 100*time.Millisecond || cfg.Interval > time.Minute {
		return fmt.Errorf("telemetry interval must be 100ms..60s")
	}
	if !filepath.IsAbs(cfg.RunDir) {
		return fmt.Errorf("run directory must be absolute")
	}
	work := filepath.Join(cfg.RunDir, "work")
	if err := os.Mkdir(work, 0755); err != nil {
		return fmt.Errorf("create fresh benchmark work directory: %w", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ticket := sha256.Sum256([]byte("curio-offline-benchmark-ticket-v1"))
	seed := sha256.Sum256([]byte("curio-offline-benchmark-seed-v1"))
	sn := storiface.SectorRef{ID: abi.SectorID{Miner: 1000, Number: 1}, ProofType: pt}
	result := &Result{SchemaVersion: 1, Kind: "curio-seal-unseal", Status: "running", SectorSize: cfg.SectorSize, ProofType: pt, Miner: 1000, Sector: 1, Ticket: hex.EncodeToString(ticket[:]), Seed: hex.EncodeToString(seed[:]), StartedAt: time.Now().UTC(), Phases: []*Phase{}}
	result.Host = hostInfo()
	defer func() {
		finished := time.Now().UTC()
		result.FinishedAt = &finished
		result.Status = "complete"
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		}
		if saveErr := writeJSON(filepath.Join(cfg.RunDir, "summary.json"), result); saveErr != nil && err == nil {
			err = saveErr
		}
	}()
	m, err := newRecorder(cfg, result)
	if err != nil {
		return err
	}
	defer m.close()
	storageDir := filepath.Join(work, "storage")
	if err = os.Mkdir(storageDir, 0755); err != nil {
		return err
	}
	meta := storiface.LocalStorageMeta{ID: storiface.ID(uuid.NewString()), Weight: 1, CanSeal: true, CanStore: true}
	if err = writeJSON(filepath.Join(storageDir, paths.MetaFile), meta); err != nil {
		return err
	}
	storageConfig := filepath.Join(work, "storage.json")
	if err = paths.WriteStorageFile(storageConfig, storiface.StorageConfig{StoragePaths: []storiface.LocalPath{{Path: storageDir}}}); err != nil {
		return err
	}
	index := &localIndex{sector: sn.ID}
	local, err := paths.NewLocal(ctx, &paths.BasicLocalStorage{PathToJSON: storageConfig}, index, "")
	if err != nil {
		return err
	}
	remote, err := paths.NewRemote(local, index, nil, 1, &paths.DefaultPartialFileHandler{})
	if err != nil {
		return err
	}
	sealer := ffi.NewSealCalls(remote, local, index)
	size := abi.PaddedPieceSize(cfg.SectorSize)
	inputPath := filepath.Join(work, "source.unpadded")
	var commD, commR cid.Cid
	err = m.measure("prepare_input", func() error {
		f, err := os.OpenFile(inputPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		defer f.Close()
		hash := sha256.New()
		key := sha256.Sum256([]byte("curio-offline-benchmark-input-v1"))
		block, err := aes.NewCipher(key[:])
		if err != nil {
			return err
		}
		reader := &cipher.StreamReader{S: cipher.NewCTR(block, make([]byte, aes.BlockSize)), R: zeroReader{}}
		if _, err = io.CopyN(io.MultiWriter(f, hash), reader, int64(size.Unpadded())); err != nil {
			return err
		}
		if err = f.Sync(); err != nil {
			return err
		}
		result.SourceSHA256 = hex.EncodeToString(hash.Sum(nil))
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		commD, err = filecoinffi.GeneratePieceCIDFromFile(pt, f, size.Unpadded())
		if err == nil {
			result.CommD = commD.String()
		}
		return err
	})
	if err != nil {
		return err
	}
	if err = m.measure("sdr", func() error { return sealer.GenerateSDR(ctx, 0, storiface.FTCache, sn, ticket[:], commD) }); err != nil {
		return err
	}
	if err = m.measure("tree_d", func() error {
		f, err := os.Open(inputPath)
		if err != nil {
			return err
		}
		defer f.Close()
		p, ids, release, err := sealer.PreFetch(ctx, sn, nil)
		if err != nil {
			return err
		}
		defer release()
		return sealer.TreeD(ctx, sn, commD, size, f, true, p, ids)
	}); err != nil {
		return err
	}
	if err = m.measure("tree_rc", func() error {
		var gotD cid.Cid
		commR, gotD, err = sealer.TreeRC(ctx, nil, sn, commD, ticket[:], []abi.PieceInfo{{Size: size, PieceCID: commD}})
		if err != nil {
			return err
		}
		if !gotD.Equals(commD) {
			return fmt.Errorf("TreeRC changed CommD")
		}
		result.CommR = commR.String()
		return nil
	}); err != nil {
		return err
	}
	// The same three calls as SealCalls.PoRepSnark, split only for measurement.
	var vanilla, snark []byte
	if err = m.measure("vanilla_c1", func() error {
		vanilla, err = remote.GeneratePoRepVanillaProof(ctx, sn, commR, commD, ticket[:], seed[:])
		return err
	}); err != nil {
		return err
	}
	if err = m.measure("groth16_c2", func() error {
		snark, err = ffiselect.FFISelect.SealCommitPhase2(ctx, vanilla, sn.ID.Number, sn.ID.Miner)
		result.ProofBytes = len(snark)
		return err
	}); err != nil {
		return err
	}
	if err = m.measure("verify_seal", func() error {
		ok, err := filecoinffi.VerifySeal(proof.SealVerifyInfo{SealProof: pt, SectorID: sn.ID, Randomness: ticket[:], InteractiveRandomness: seed[:], Proof: snark, SealedCID: commR, UnsealedCID: commD})
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("seal proof verification failed")
		}
		result.Verified = true
		return os.WriteFile(filepath.Join(work, "seal-proof.bin"), snark, 0600)
	}); err != nil {
		return err
	}
	// Delete labels/TreeD just as Curio finalizes a sector with keepUnsealed=false.
	// Unseal must regenerate the key; it must not reuse sealing's last SDR layer.
	if err = m.measure("finalize", func() error { return sealer.FinalizeSector(ctx, sn, false) }); err != nil {
		return err
	}
	if err = m.measure("unseal_sdr", func() error { return sealer.GenerateSDR(ctx, 0, storiface.FTKey, sn, ticket[:], commD) }); err != nil {
		return err
	}
	if err = m.measure("unseal_decode", func() error { return sealer.DecodeSDR(ctx, 0, sn, ticket[:], commD) }); err != nil {
		return err
	}
	if err = m.measure("verify_unsealed", func() error {
		p, _, err := local.AcquireSector(ctx, sn, storiface.FTUnsealed, storiface.FTNone, storiface.PathStorage, storiface.AcquireMove)
		if err != nil {
			return err
		}
		f, err := os.Open(p.Unsealed)
		if err != nil {
			return err
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil {
			return err
		}
		if stat.Size() != int64(size) {
			return fmt.Errorf("unsealed length %d != %d", stat.Size(), size)
		}
		reader, err := fr32.NewUnpadReader(f, size)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, err := io.Copy(hash, reader)
		if err != nil {
			return err
		}
		result.UnsealedSHA256 = hex.EncodeToString(hash.Sum(nil))
		if n != int64(size.Unpadded()) || result.UnsealedSHA256 != result.SourceSHA256 {
			return fmt.Errorf("unsealed bytes differ from source")
		}
		result.UnsealMatch = true
		return nil
	}); err != nil {
		return err
	}
	return nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func writeJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(path+".tmp", append(b, '\n'), 0644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
