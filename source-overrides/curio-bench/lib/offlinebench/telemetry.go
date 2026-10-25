package offlinebench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Sample struct {
	At         time.Time  `json:"at"`
	CPUUsec    uint64     `json:"cpu_usec"`
	CPU        sourceName `json:"cpu_source"`
	RSS        uint64     `json:"process_tree_rss_bytes"`
	Memory     *uint64    `json:"cgroup_memory_bytes"`
	Anon       *uint64    `json:"cgroup_anon_bytes"`
	File       *uint64    `json:"cgroup_file_bytes"`
	Swap       *uint64    `json:"cgroup_swap_bytes"`
	KernelPeak *uint64    `json:"cgroup_memory_peak_bytes"`
	OOMKills   *uint64    `json:"cgroup_oom_kill"`
}
type sourceName string

type Phase struct {
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	WallMS     float64    `json:"wall_ms"`
	CPUMS      float64    `json:"cpu_ms"`
	AvgCores   float64    `json:"average_cpu_cores"`
	RSSPeak    uint64     `json:"process_tree_rss_peak_bytes"`
	MemoryPeak *uint64    `json:"cgroup_memory_sampled_peak_bytes"`
	Samples    uint64     `json:"samples"`
	Error      string     `json:"error,omitempty"`
}

type recorder struct {
	cfg    Config
	result *Result
	file   *os.File
}

func newRecorder(cfg Config, result *Result) (*recorder, error) {
	f, err := os.OpenFile(filepath.Join(cfg.RunDir, "telemetry.ndjson"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	return &recorder{cfg: cfg, result: result, file: f}, nil
}
func (r *recorder) close() { _ = r.file.Close() }
func (r *recorder) emit(kind string, p *Phase, s Sample) error {
	return json.NewEncoder(r.file).Encode(struct {
		Kind   string `json:"kind"`
		Phase  string `json:"phase"`
		Sample Sample `json:"sample"`
		Result *Phase `json:"result,omitempty"`
	}{kind, p.Name, s, p})
}

func (r *recorder) measure(name string, fn func() error) error {
	start := time.Now()
	first := sample()
	p := &Phase{Name: name, Status: "running", StartedAt: start.UTC()}
	r.result.Phases = append(r.result.Phases, p)
	if err := writeJSON(filepath.Join(r.cfg.RunDir, "summary.json"), r.result); err != nil {
		return err
	}
	if err := r.emit("phase_start", p, first); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[curio-bench] %s started\n", name)
	update := func(s Sample) {
		p.Samples++
		p.RSSPeak = max(p.RSSPeak, s.RSS)
		if s.Memory != nil && (p.MemoryPeak == nil || *s.Memory > *p.MemoryPeak) {
			v := *s.Memory
			p.MemoryPeak = &v
		}
	}
	update(first)
	// Sampling owns the phase fields until joined. The benchmark thread runs
	// production code synchronously, including ffiselect's child processes.
	stop := make(chan struct{})
	joined := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(r.cfg.Interval)
		defer ticker.Stop()
		var logErr error
		for {
			select {
			case <-stop:
				joined <- logErr
				return
			case <-ticker.C:
				s := sample()
				update(s)
				if err := r.emit("sample", p, s); err != nil && logErr == nil {
					logErr = err
				}
			}
		}
	}()
	err := fn()
	close(stop)
	logErr := <-joined
	if err == nil {
		err = logErr
	}
	last := sample()
	update(last)
	end := time.Now().UTC()
	p.FinishedAt = &end
	p.WallMS = float64(time.Since(start).Microseconds()) / 1000
	if last.CPU == first.CPU && last.CPUUsec >= first.CPUUsec {
		p.CPUMS = float64(last.CPUUsec-first.CPUUsec) / 1000
	}
	if p.WallMS > 0 {
		p.AvgCores = p.CPUMS / p.WallMS
	}
	p.Status = "complete"
	if err != nil {
		p.Status = "failed"
		p.Error = err.Error()
	}
	if e := r.emit("phase_end", p, last); err == nil {
		err = e
	}
	if e := writeJSON(filepath.Join(r.cfg.RunDir, "summary.json"), r.result); err == nil {
		err = e
	}
	fmt.Fprintf(os.Stderr, "[curio-bench] %s %s: %.3fs, %.2f CPU cores\n", name, p.Status, p.WallMS/1000, p.AvgCores)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func number(path string) *uint64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return nil
	}
	return &v
}
func fields(path string) map[string]uint64 {
	out := map[string]uint64{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
			out[f[0]] = v
		}
	}
	return out
}
func field(m map[string]uint64, key string) *uint64 {
	v, ok := m[key]
	if !ok {
		return nil
	}
	return &v
}

func sample() Sample {
	s := Sample{At: time.Now().UTC()}
	// Docker's private cgroup namespace exposes this container at the mount
	// root. The shell launcher does not allow --pid=host or --cgroupns=host.
	root := "/sys/fs/cgroup"
	s.Memory = number(root + "/memory.current")
	s.Swap = number(root + "/memory.swap.current")
	s.KernelPeak = number(root + "/memory.peak")
	stats := fields(root + "/memory.stat")
	s.Anon, s.File = field(stats, "anon"), field(stats, "file")
	s.OOMKills = field(fields(root+"/memory.events"), "oom_kill")
	if cpu := field(fields(root+"/cpu.stat"), "usage_usec"); cpu != nil {
		s.CPUUsec, s.CPU = *cpu, "cgroup-v2"
	} else {
		// cgroup v1 Docker layout; getrusage also covers waited ffi children.
		s.Memory = number(root + "/memory/memory.usage_in_bytes")
		s.KernelPeak = number(root + "/memory/memory.max_usage_in_bytes")
		stats = fields(root + "/memory/memory.stat")
		s.Anon, s.File = field(stats, "total_rss"), field(stats, "total_cache")
		if cpu := number(root + "/cpuacct/cpuacct.usage"); cpu != nil {
			s.CPUUsec, s.CPU = *cpu/1000, "cgroup-v1"
		} else {
			s.CPU = "getrusage-self-and-waited-children"
			for _, who := range []int{syscall.RUSAGE_SELF, syscall.RUSAGE_CHILDREN} {
				var ru syscall.Rusage
				if syscall.Getrusage(who, &ru) == nil {
					s.CPUUsec += uint64(ru.Utime.Sec+ru.Stime.Sec)*1000000 + uint64(ru.Utime.Usec+ru.Stime.Usec)
				}
			}
		}
	}
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		s.RSS += fields(filepath.Join("/proc", e.Name(), "status"))["VmRSS:"] * 1024
	}
	return s
}

func hostInfo() map[string]any {
	text := func(path string) string { b, _ := os.ReadFile(path); return strings.TrimSpace(string(b)) }
	value := func(path, key string) string {
		for _, line := range strings.Split(text(path), "\n") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
				return strings.TrimSpace(parts[1])
			}
		}
		return ""
	}
	return map[string]any{
		"architecture": runtime.GOARCH, "logical_cpus": runtime.NumCPU(), "go_max_procs": runtime.GOMAXPROCS(0),
		"cpu_model": value("/proc/cpuinfo", "model name"), "cpu_flags": value("/proc/cpuinfo", "flags"),
		"mem_total_bytes":   fields("/proc/meminfo")["MemTotal:"] * 1024,
		"cpus_allowed_list": value("/proc/self/status", "Cpus_allowed_list"),
		"cgroup_memory_max": text("/sys/fs/cgroup/memory.max"), "cgroup_cpu_max": text("/sys/fs/cgroup/cpu.max"),
	}
}
