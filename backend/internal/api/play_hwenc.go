package api

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// videoEncoder is how a transcode writes its picture: x264 in software, or a
// GPU's H.264 encoder. The picture is always decoded and scaled in software -
// that opens every codec ffmpeg reads (Hi10P, MPEG-4 ASP, a burned-in picture
// subtitle) - and only handed to the GPU to be encoded, the part that costs.
//
// ponytail: no hardware decoding or scaling; full GPU pipelines are the
// upgrade path where software decoding becomes the bottleneck.
type videoEncoder struct {
	name   string   // software, nvenc, vaapi
	device string   // the render node, for vaapi
	pre    []string // ahead of -i: the device
	upload string   // the end of the filter chain: pixel format, upload
	args   []string // -c:v and its rate control
	height int      // the most lines it writes
}

func softwareEncoder() videoEncoder {
	return videoEncoder{name: "software", upload: "format=yuv420p", height: 720,
		args: []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "21"}}
}

func nvencEncoder() videoEncoder {
	return videoEncoder{name: "nvenc", upload: "format=yuv420p", height: 1080,
		// forced keyframes become IDR frames, so every segment starts clean
		args: []string{"-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-forced-idr", "1"}}
}

func vaapiEncoder(dev string) videoEncoder {
	return videoEncoder{name: "vaapi", device: dev, height: 1080,
		pre: []string{"-vaapi_device", dev}, upload: "format=nv12,hwupload",
		args: []string{"-c:v", "h264_vaapi", "-qp", "23"}}
}

// hwMode normalizes WEEBSYNC_HWACCEL: empty is auto, every spelling of "off"
// is none, anything else stays as typed (lowercased).
func hwMode(raw string) string {
	m := strings.ToLower(strings.TrimSpace(raw))
	switch m {
	case "":
		return "auto"
	case "none", "software", "off", "false", "0":
		return "none"
	}
	return m
}

// encoderCandidates are the encoders WEEBSYNC_HWACCEL allows, best first.
// A GPU keeps up with 1080p where x264 on a small host does not.
func encoderCandidates(mode string) []videoEncoder {
	nodes, _ := filepath.Glob("/dev/dri/renderD*")
	slices.Sort(nodes)
	var vaapi []videoEncoder
	for _, dev := range nodes {
		vaapi = append(vaapi, vaapiEncoder(dev))
	}
	switch hwMode(mode) {
	case "nvenc":
		return []videoEncoder{nvencEncoder()}
	case "vaapi":
		return vaapi
	case "none":
		return nil
	}
	return append([]videoEncoder{nvencEncoder()}, vaapi...)
}

// encoderWorks encodes a short test picture through the same chain a
// transcode uses: a driver that is missing, a GPU without an H.264 encoder or
// a device the process may not open all fail here and not mid-episode.
func encoderWorks(e videoEncoder) bool {
	_, err := runTestEncode(context.Background(), e)
	return err == nil
}

// runTestEncode is the real test encode; the string is ffmpeg's error text.
func runTestEncode(ctx context.Context, e videoEncoder) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := append([]string{"-hide_banner", "-v", "error", "-nostdin"}, e.pre...)
	args = append(args, "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=0.5",
		"-vf", e.filter(), "-force_key_frames", "expr:gte(t,n_forced*0.25)")
	args = append(args, e.args...)
	args = append(args, "-f", "null", "-")
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Env = ffEnv(os.Environ())
	out, err := cmd.CombinedOutput()
	if err != nil {
		slog.Debug("player: encoder unavailable", "encoder", e.name, "device", e.device, "ffmpeg", logSafe(string(out)))
		if ctx.Err() != nil {
			return string(out) + "\ntimed out", err
		}
	}
	return string(out), err
}

// filter scales to the encoder's height and hands the frames over.
func (e videoEncoder) filter() string {
	return "scale=-2:'min(" + strconv.Itoa(e.height) + ",ih)'," + e.upload
}

// hwEnv is everything the probe reads from the host, so a test can fake it.
type hwEnv struct {
	goarch  string
	getenv  func(string) string
	glob    func(pattern string) []string
	nodeGID func(path string) (gid int, err error) // the group that owns a device node
	open    func(path string) error                // can this process open it read-write
	groups  func() []int                           // the process's gid and supplementary groups
	encode  func(ctx context.Context, e videoEncoder) (out string, err error)
	hasCUDA func() bool // the NVIDIA driver library is reachable
}

func osHWEnv() hwEnv {
	return hwEnv{
		goarch: runtime.GOARCH,
		getenv: os.Getenv,
		glob: func(p string) []string {
			m, _ := filepath.Glob(p)
			return m
		},
		nodeGID: func(p string) (int, error) {
			fi, err := os.Stat(p)
			if err != nil {
				return -1, err
			}
			if st, ok := fi.Sys().(*syscall.Stat_t); ok {
				return int(st.Gid), nil
			}
			return -1, nil
		},
		open: func(p string) error {
			f, err := os.OpenFile(p, os.O_RDWR, 0)
			if err == nil {
				_ = f.Close()
			}
			return err
		},
		groups: func() []int {
			g, _ := os.Getgroups()
			if !slices.Contains(g, os.Getgid()) {
				g = append(g, os.Getgid())
			}
			slices.Sort(g)
			return g
		},
		encode: runTestEncode,
		hasCUDA: func() bool {
			for _, p := range []string{"/usr/lib/*/libcuda.so*", "/usr/lib64/libcuda.so*", "/usr/lib/libcuda.so*", "/usr/local/nvidia/lib*/libcuda.so*"} {
				if m, _ := filepath.Glob(p); len(m) > 0 {
					return true
				}
			}
			return false
		},
	}
}

// Diagnosis codes. A candidate carries one of the first group, the report one
// or more issues of the second.
const (
	hwOK             = "ok"
	hwNoRenderNodes  = "no_render_nodes"       // nothing under /dev/dri/renderD*
	hwNodeNoAccess   = "render_node_no_access" // the node is there, this process may not open it
	hwVaapiFailed    = "vaapi_driver_failed"   // the test encode failed
	hwNoNvidiaDevice = "no_nvidia_device"      // no /dev/nvidia* and no libcuda
	hwNvencFailed    = "nvenc_failed"          // the test encode failed
	hwSkippedByMode  = "skipped_by_mode"       // WEEBSYNC_HWACCEL leaves it out

	hwArchNoEncoder    = "arch_no_encoder"    // issue: arm64 has no hardware encoder
	hwForcedModeFailed = "forced_mode_failed" // issue: the mode WEEBSYNC_HWACCEL names did not work

	hwProbeTimeLimit  = 90 * time.Second
	hwExcerptMaxBytes = 400
)

// hwParams carries what a diagnosis code needs for its message and fix; only
// the fields of that code are set.
type hwParams struct {
	Node   string `json:"node,omitempty"`   // render_node_no_access: the device node
	GID    *int   `json:"gid,omitempty"`    // render_node_no_access: the node's group id
	Groups []int  `json:"groups,omitempty"` // render_node_no_access: the process's groups
	Error  string `json:"error,omitempty"`  // *_failed: a short excerpt of the error
	Mode   string `json:"mode,omitempty"`   // forced_mode_failed: the WEEBSYNC_HWACCEL value
}

// hwCandidate is one encoder the probe tried (or skipped).
type hwCandidate struct {
	Encoder string   `json:"encoder" enums:"nvenc,vaapi"`
	Device  string   `json:"device,omitempty"` // the render node, for vaapi
	Code    string   `json:"code" enums:"ok,no_render_nodes,render_node_no_access,vaapi_driver_failed,no_nvidia_device,nvenc_failed,skipped_by_mode"`
	Params  hwParams `json:"params"`
	enc     videoEncoder
}

// hwIssue is a diagnosis about the host as a whole.
type hwIssue struct {
	Code   string   `json:"code" enums:"arch_no_encoder,forced_mode_failed"`
	Params hwParams `json:"params"`
}

// hwChoice is the encoder transcodes use.
type hwChoice struct {
	Encoder   string `json:"encoder" enums:"nvenc,vaapi,software"`
	Device    string `json:"device,omitempty"`
	MaxHeight int    `json:"maxHeight"`
}

// hwReport is the outcome of one probe.
type hwReport struct {
	Arch        string        `json:"arch"`
	Mode        string        `json:"mode"` // auto, nvenc, vaapi, none
	ModeFromEnv bool          `json:"modeFromEnv"`
	Probed      bool          `json:"probed"`
	Probing     bool          `json:"probing"`
	ProbedAt    string        `json:"probedAt,omitempty"` // RFC 3339
	Choice      *hwChoice     `json:"choice,omitempty"`   // absent until probed
	Issues      []hwIssue     `json:"issues"`
	Candidates  []hwCandidate `json:"candidates"`
	enc         videoEncoder
}

// ffExcerpt keeps the last lines of ffmpeg's error text, short.
func ffExcerpt(out string) string {
	var lines []string
	for l := range strings.SplitSeq(out, "\n") {
		if l = logSafe(strings.TrimSpace(l)); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	s := strings.Join(lines, " | ")
	if len(s) > hwExcerptMaxBytes {
		s = "..." + strings.ToValidUTF8(s[len(s)-hwExcerptMaxBytes:], "")
	}
	return s
}

// probeHW tries every candidate WEEBSYNC_HWACCEL allows and diagnoses why
// each did or did not work. The choice is the first that works, best first
// (NVENC, then the render nodes sorted), else software.
func probeHW(ctx context.Context, env hwEnv) *hwReport {
	raw := strings.TrimSpace(env.getenv("WEEBSYNC_HWACCEL"))
	mode := hwMode(raw)
	rep := &hwReport{Arch: env.goarch, Mode: mode, ModeFromEnv: raw != "", Probed: true,
		ProbedAt: time.Now().UTC().Format(time.RFC3339), Issues: []hwIssue{}, Candidates: []hwCandidate{}}
	wantNV := mode != "vaapi" && mode != "none"
	wantVA := mode != "nvenc" && mode != "none"

	nv := hwCandidate{Encoder: "nvenc", enc: nvencEncoder()}
	switch {
	case !wantNV:
		nv.Code = hwSkippedByMode
	case len(env.glob("/dev/nvidia*")) == 0 && !env.hasCUDA():
		nv.Code = hwNoNvidiaDevice
	default:
		nv.Code, nv.Params = encodeCode(ctx, env, nv.enc, hwNvencFailed)
	}
	rep.Candidates = append(rep.Candidates, nv)

	nodes := env.glob("/dev/dri/renderD*")
	slices.Sort(nodes)
	if len(nodes) == 0 {
		c := hwCandidate{Encoder: "vaapi", Code: hwNoRenderNodes}
		if !wantVA {
			c.Code = hwSkippedByMode
		}
		rep.Candidates = append(rep.Candidates, c)
	}
	for _, dev := range nodes {
		c := hwCandidate{Encoder: "vaapi", Device: dev, enc: vaapiEncoder(dev)}
		if !wantVA {
			c.Code = hwSkippedByMode
		} else if err := env.open(dev); err != nil {
			if os.IsPermission(err) {
				c.Code = hwNodeNoAccess
				c.Params = hwParams{Node: dev, Groups: env.groups()}
				if gid, serr := env.nodeGID(dev); serr == nil && gid >= 0 {
					c.Params.GID = &gid
				}
			} else {
				c.Code, c.Params = hwVaapiFailed, hwParams{Error: ffExcerpt(err.Error())}
			}
		} else {
			c.Code, c.Params = encodeCode(ctx, env, c.enc, hwVaapiFailed)
		}
		rep.Candidates = append(rep.Candidates, c)
	}

	rep.enc = softwareEncoder()
	for _, c := range rep.Candidates {
		if c.Code == hwOK {
			rep.enc = c.enc
			break
		}
	}
	rep.Choice = &hwChoice{Encoder: rep.enc.name, Device: rep.enc.device, MaxHeight: rep.enc.height}
	if rep.enc.name == "software" {
		if env.goarch == "arm64" {
			rep.Issues = append(rep.Issues, hwIssue{Code: hwArchNoEncoder})
		}
		if mode != "auto" && mode != "none" {
			rep.Issues = append(rep.Issues, hwIssue{Code: hwForcedModeFailed, Params: hwParams{Mode: mode}})
		}
	}
	return rep
}

// encodeCode runs the test encode of e: ok, or the failed code with ffmpeg's
// error.
func encodeCode(ctx context.Context, env hwEnv, e videoEncoder, failed string) (string, hwParams) {
	if out, err := env.encode(ctx, e); err != nil {
		return failed, hwParams{Error: ffExcerpt(out)}
	}
	return hwOK, hwParams{}
}

// hwProber keeps the outcome of the probe: run once on first use, replaced
// whole by a re-probe. Probes never overlap; a caller that arrives while one
// runs waits for it and takes its result.
type hwProber struct {
	env     hwEnv
	mu      sync.Mutex // held for the length of a probe
	gen     atomic.Int64
	probing atomic.Bool
	cur     atomic.Pointer[hwReport]
}

// report is the current outcome, probing first if there is none.
func (p *hwProber) report() *hwReport {
	if r := p.cur.Load(); r != nil {
		return r
	}
	return p.probe(0)
}

// reprobe probes again, replacing the outcome.
func (p *hwProber) reprobe() *hwReport { return p.probe(p.gen.Load()) }

// probe runs a probe unless one finished since generation seen.
func (p *hwProber) probe(seen int64) *hwReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen.Load() != seen {
		return p.cur.Load()
	}
	p.probing.Store(true)
	defer p.probing.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), hwProbeTimeLimit)
	defer cancel()
	r := probeHW(ctx, p.env)
	switch {
	case r.enc.name != "software":
		slog.Info("player transcodes on the GPU", "encoder", r.enc.name, "device", r.enc.device)
	case slices.ContainsFunc(r.Issues, func(i hwIssue) bool { return i.Code == hwForcedModeFailed }):
		slog.Warn("player: the requested hardware encoder does not work here, transcoding in software", "hwaccel", r.Mode)
	}
	p.cur.Store(r)
	p.gen.Add(1)
	return r
}

// snapshot is the report for the API: a copy carrying the probing flag, or an
// unprobed shell before the first probe.
func (p *hwProber) snapshot() hwReport {
	var r hwReport
	if c := p.cur.Load(); c != nil {
		r = *c
	} else {
		raw := strings.TrimSpace(p.env.getenv("WEEBSYNC_HWACCEL"))
		r = hwReport{Arch: p.env.goarch, Mode: hwMode(raw), ModeFromEnv: raw != "",
			Issues: []hwIssue{}, Candidates: []hwCandidate{}}
	}
	r.Probing = p.probing.Load()
	return r
}

// hwProbe is the process's prober.
var hwProbe = &hwProber{env: osHWEnv()}

// playEncoder is picked once per process (and again on request, Settings).
//
// ponytail: a GPU that fails later (driver reset, NVENC session cap) fails
// that transcode instead of falling back to x264; retry in software per run
// if that shows up.
func playEncoder() videoEncoder { return hwProbe.report().enc }
