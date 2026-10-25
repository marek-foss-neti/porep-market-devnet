package offlinebench

import (
	"context"
	"fmt"
	"sync"

	"github.com/filecoin-project/curio/lib/paths"
	"github.com/filecoin-project/curio/lib/storiface"
	"github.com/filecoin-project/go-state-types/abi"
	"github.com/filecoin-project/lotus/storage/sealer/fsutil"
)

// localIndex is deliberately restricted to one private storage path and one
// sector. It replaces only Curio's database index, not its storage or proof code.
// A benchmark owns its run directory exclusively and executes tasks serially.
type localIndex struct {
	mu     sync.Mutex
	sector abi.SectorID
	info   storiface.StorageInfo
	files  storiface.SectorFileType
}

var _ paths.SectorIndex = (*localIndex)(nil)

func (i *localIndex) StorageAttach(_ context.Context, info storiface.StorageInfo, _ fsutil.FsStat) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.info.ID != "" && i.info.ID != info.ID {
		return fmt.Errorf("offline index supports one storage path")
	}
	i.info = info
	return nil
}
func (i *localIndex) StorageInfo(_ context.Context, id storiface.ID) (storiface.StorageInfo, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if id != i.info.ID {
		return storiface.StorageInfo{}, fmt.Errorf("unknown storage %s", id)
	}
	return i.info, nil
}
func (i *localIndex) StorageReportHealth(ctx context.Context, id storiface.ID, _ storiface.HealthReport) error {
	_, err := i.StorageInfo(ctx, id)
	return err
}
func (i *localIndex) StorageDeclareSector(_ context.Context, id storiface.ID, sector abi.SectorID, ft storiface.SectorFileType, _ bool) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if id != i.info.ID || sector != i.sector {
		return fmt.Errorf("unexpected storage or sector in offline index")
	}
	i.files |= ft
	return nil
}
func (i *localIndex) BatchStorageDeclareSectors(ctx context.Context, ds []paths.SectorDeclaration) error {
	for _, d := range ds {
		if err := i.StorageDeclareSector(ctx, d.StorageID, d.SectorID, d.FileType, d.Primary); err != nil {
			return err
		}
	}
	return nil
}
func (i *localIndex) StorageDropSector(_ context.Context, id storiface.ID, sector abi.SectorID, ft storiface.SectorFileType) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if id != i.info.ID || sector != i.sector {
		return fmt.Errorf("unexpected storage or sector in offline index")
	}
	i.files &^= ft
	return nil
}
func (i *localIndex) StorageFindSector(_ context.Context, sector abi.SectorID, ft storiface.SectorFileType, _ abi.SectorSize, _ bool) ([]storiface.SectorStorageInfo, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if sector != i.sector || i.files&ft != ft {
		return nil, nil
	}
	return []storiface.SectorStorageInfo{{ID: i.info.ID, Weight: 1, CanSeal: true, CanStore: true, Primary: true}}, nil
}
func (i *localIndex) StorageBestAlloc(_ context.Context, _ storiface.SectorFileType, _ abi.SectorSize, _ storiface.PathType, miner abi.ActorID) ([]storiface.StorageInfo, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if miner != i.sector.Miner {
		return nil, fmt.Errorf("unexpected miner in offline index")
	}
	return []storiface.StorageInfo{i.info}, nil
}
func (i *localIndex) StorageList(_ context.Context, id storiface.ID) ([]storiface.Decl, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if id != i.info.ID {
		return nil, fmt.Errorf("unknown storage %s", id)
	}
	if i.files == storiface.FTNone {
		return nil, nil
	}
	return []storiface.Decl{{SectorID: i.sector, SectorFileType: i.files}}, nil
}

// These operations are not used by the serial offline runner. Fail explicitly
// if a future Curio version introduces a dependency on distributed locking.
func (*localIndex) StorageDetach(context.Context, storiface.ID, string) error {
	return fmt.Errorf("offline storage cannot be detached")
}
func (*localIndex) StorageLock(context.Context, abi.SectorID, storiface.SectorFileType, storiface.SectorFileType) error {
	return fmt.Errorf("distributed locks are unsupported in the offline benchmark")
}
func (*localIndex) StorageTryLock(context.Context, abi.SectorID, storiface.SectorFileType, storiface.SectorFileType) (bool, error) {
	return false, fmt.Errorf("distributed locks are unsupported in the offline benchmark")
}
func (*localIndex) StorageGetLocks(context.Context) (storiface.SectorLocks, error) {
	return storiface.SectorLocks{}, nil
}
