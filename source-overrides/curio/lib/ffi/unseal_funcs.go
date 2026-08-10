package ffi

import (
	"context"
	"io"
	"os"
	"strings"
	"time"

	"github.com/ipfs/go-cid"
	"golang.org/x/xerrors"

	"github.com/filecoin-project/curio/harmony/harmonytask"
	"github.com/filecoin-project/curio/lib/ffi/cunative"
	"github.com/filecoin-project/curio/lib/storiface"
	filecoinffi "github.com/filecoin-project/filecoin-ffi"
	"github.com/filecoin-project/go-state-types/abi"
	"github.com/filecoin-project/lotus/storage/sealer/fr32"
)

func (sb *SealCalls) decodeCommon(ctx context.Context, taskID harmonytask.TaskID, sector storiface.SectorRef, fileType storiface.SectorFileType, decodeFunc func(sealReader, keyReader io.Reader, outFile io.Writer) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	paths, pathIDs, releaseSector, err := sb.Sectors.AcquireSector(ctx, &taskID, sector, storiface.FTNone, storiface.FTUnsealed, storiface.PathStorage)
	if err != nil {
		return xerrors.Errorf("acquiring sector paths: %w", err)
	}
	defer releaseSector()

	sealReader, err := sb.Sectors.storage.ReaderSeq(ctx, sector, fileType)
	if err != nil {
		return xerrors.Errorf("getting sealed sector reader: %w", err)
	}

	keyReader, err := sb.Sectors.storage.ReaderSeq(ctx, sector, storiface.FTKey)
	if err != nil {
		return xerrors.Errorf("getting key reader: %w", err)
	}

	tempDest := paths.Unsealed + storiface.TempSuffix

	outFile, err := os.Create(tempDest)
	if err != nil {
		return xerrors.Errorf("creating unsealed file: %w", err)
	}
	defer func() {
		_ = outFile.Close()
	}()

	start := time.Now()

	err = decodeFunc(sealReader, keyReader, outFile)
	if err != nil {
		return xerrors.Errorf("decoding sealed sector: %w", err)
	}

	end := time.Now()

	ssize, err := sector.ProofType.SectorSize()
	if err != nil {
		return xerrors.Errorf("getting sector size: %w", err)
	}

	log.Infow("decoded sector", "sectorID", sector, "duration", end.Sub(start), "MiB/s", float64(ssize)/(1<<20)/end.Sub(start).Seconds())

	if err := os.Rename(tempDest, paths.Unsealed); err != nil {
		return xerrors.Errorf("renaming to unsealed file: %w", err)
	}

	if err := sb.ensureOneCopy(ctx, sector.ID, pathIDs, storiface.FTUnsealed); err != nil {
		return xerrors.Errorf("ensure one copy: %w", err)
	}

	if err := sb.Sectors.storage.Remove(ctx, sector.ID, storiface.FTKey, true, nil); err != nil {
		return err
	}

	return nil
}

func zigzagDevnetProof(proof abi.RegisteredSealProof) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FIL_PROOFS_USE_ZIGZAG"))) {
	case "1", "true", "yes", "on":
	default:
		return false
	}

	sectorSize, err := proof.SectorSize()
	if err != nil {
		return false
	}

	return sectorSize == abi.SectorSize(2<<10) || sectorSize == abi.SectorSize(8<<20)
}

func padZigZagUnsealed(unpaddedPath, paddedPath string) error {
	unpaddedFile, err := os.Open(unpaddedPath)
	if err != nil {
		return xerrors.Errorf("opening zigzag unpadded output: %w", err)
	}
	defer func() {
		_ = unpaddedFile.Close()
	}()

	paddedFile, err := os.Create(paddedPath)
	if err != nil {
		return xerrors.Errorf("creating padded unsealed file: %w", err)
	}

	padWriter := fr32.NewPadWriter(paddedFile)
	_, copyErr := io.CopyBuffer(padWriter, unpaddedFile, make([]byte, 1<<20))
	padCloseErr := padWriter.Close()
	fileCloseErr := paddedFile.Close()

	if copyErr != nil {
		_ = os.Remove(paddedPath)
		return xerrors.Errorf("padding zigzag unsealed output: %w", copyErr)
	}
	if padCloseErr != nil {
		_ = os.Remove(paddedPath)
		return xerrors.Errorf("closing zigzag padding writer: %w", padCloseErr)
	}
	if fileCloseErr != nil {
		_ = os.Remove(paddedPath)
		return xerrors.Errorf("closing padded unsealed file: %w", fileCloseErr)
	}

	return nil
}

func (sb *SealCalls) decodeZigZagSDR(ctx context.Context, taskID harmonytask.TaskID, sector storiface.SectorRef, ticket abi.SealRandomness, commD cid.Cid) error {
	if len(ticket) != abi.RandomnessLength {
		return xerrors.Errorf("invalid ticket value length %d", len(ticket))
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	paths, pathIDs, releaseSector, err := sb.Sectors.AcquireSector(ctx, &taskID, sector, storiface.FTNone, storiface.FTUnsealed, storiface.PathStorage)
	if err != nil {
		return xerrors.Errorf("acquiring sector paths: %w", err)
	}
	defer releaseSector()

	sealedPaths, _, err := sb.Sectors.storage.AcquireSector(ctx, sector, storiface.FTSealed, storiface.FTNone, storiface.PathStorage, storiface.AcquireMove)
	if err != nil {
		return xerrors.Errorf("acquiring sealed sector path: %w", err)
	}

	sealedFile, err := os.Open(sealedPaths.Sealed)
	if err != nil {
		return xerrors.Errorf("opening sealed sector: %w", err)
	}
	defer func() {
		_ = sealedFile.Close()
	}()

	tempDest := paths.Unsealed + storiface.TempSuffix
	unpaddedTempDest := paths.Unsealed + ".zigzag-unpadded" + storiface.TempSuffix
	if err := os.RemoveAll(tempDest); err != nil {
		return xerrors.Errorf("removing temp unsealed file: %w", err)
	}
	if err := os.RemoveAll(unpaddedTempDest); err != nil {
		return xerrors.Errorf("removing temp zigzag unpadded file: %w", err)
	}

	outFile, err := os.Create(unpaddedTempDest)
	if err != nil {
		return xerrors.Errorf("creating zigzag unpadded file: %w", err)
	}

	start := time.Now()

	err = filecoinffi.Unseal(sector.ProofType, "", sealedFile, outFile, sector.ID.Number, sector.ID.Miner, ticket, commD)
	closeErr := outFile.Close()
	if err != nil {
		_ = os.Remove(unpaddedTempDest)
		return xerrors.Errorf("zigzag unsealing sector: %w", err)
	}
	if closeErr != nil {
		_ = os.Remove(unpaddedTempDest)
		return xerrors.Errorf("closing zigzag unpadded file: %w", closeErr)
	}

	if err := padZigZagUnsealed(unpaddedTempDest, tempDest); err != nil {
		_ = os.Remove(unpaddedTempDest)
		return err
	}
	_ = os.Remove(unpaddedTempDest)

	end := time.Now()

	ssize, err := sector.ProofType.SectorSize()
	if err != nil {
		return xerrors.Errorf("getting sector size: %w", err)
	}

	log.Infow("zigzag decoded sector", "sectorID", sector, "duration", end.Sub(start), "MiB/s", float64(ssize)/(1<<20)/end.Sub(start).Seconds())

	if err := os.Rename(tempDest, paths.Unsealed); err != nil {
		return xerrors.Errorf("renaming to unsealed file: %w", err)
	}

	if err := sb.ensureOneCopy(ctx, sector.ID, pathIDs, storiface.FTUnsealed); err != nil {
		return xerrors.Errorf("ensure one copy: %w", err)
	}

	return nil
}

func (sb *SealCalls) DecodeSDR(ctx context.Context, taskID harmonytask.TaskID, sector storiface.SectorRef, ticket abi.SealRandomness, commD cid.Cid) error {
	if zigzagDevnetProof(sector.ProofType) {
		return sb.decodeZigZagSDR(ctx, taskID, sector, ticket, commD)
	}

	return sb.decodeCommon(ctx, taskID, sector, storiface.FTSealed, func(sealReader, keyReader io.Reader, outFile io.Writer) error {
		return cunative.Decode(sealReader, keyReader, outFile)
	})
}

func (sb *SealCalls) DecodeSnap(ctx context.Context, taskID harmonytask.TaskID, commD, commK cid.Cid, sector storiface.SectorRef) error {
	return sb.decodeCommon(ctx, taskID, sector, storiface.FTUpdate, func(sealReader, keyReader io.Reader, outFile io.Writer) error {
		return cunative.DecodeSnap(sector.ProofType, commD, commK, keyReader, sealReader, outFile)
	})
}
