package api

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeHW is a host with the given device files (and their group ids) and the
// encoders that work.
func fakeHW(arch, mode string, files map[string]int, working map[string]bool) hwEnv {
	return hwEnv{
		goarch: arch,
		getenv: func(string) string { return mode },
		glob: func(p string) []string {
			var out []string
			for f := range files {
				if ok, _ := filepath.Match(p, f); ok {
					out = append(out, f)
				}
			}
			return out
		},
		nodeGID: func(p string) (int, error) { return files[p], nil },
		open: func(p string) error {
			if files[p] == 987 {
				return fs.ErrPermission
			}
			return nil
		},
		groups:  func() []int { return []int{65532} },
		hasCUDA: func() bool { return false },
		encode: func(_ context.Context, e videoEncoder) (string, error) {
			if working[e.name+e.device] {
				return "", nil
			}
			return "noise\nCannot load libva driver\nDevice creation failed\n", errors.New("exit 1")
		},
	}
}

func codes(r *hwReport) string {
	var out []string
	for _, c := range r.Candidates {
		out = append(out, c.Encoder+c.Device+"="+c.Code)
	}
	return strings.Join(out, " ")
}

func TestProbeDiagnoses(t *testing.T) {
	ctx := context.Background()

	// nothing passed through
	r := probeHW(ctx, fakeHW("amd64", "", nil, nil))
	if got := codes(r); got != "nvenc=no_nvidia_device vaapi=no_render_nodes" || r.Choice.Encoder != "software" || r.Choice.MaxHeight != 720 {
		t.Fatalf("bare host: %s %+v", got, r.Choice)
	}

	// render nodes owned by a group the process is not in
	files := map[string]int{"/dev/dri/renderD128": 987, "/dev/dri/renderD129": 987}
	r = probeHW(ctx, fakeHW("amd64", "auto", files, nil))
	c := r.Candidates[1]
	if c.Code != "render_node_no_access" || c.Params.GID == nil || *c.Params.GID != 987 || !slices.Equal(c.Params.Groups, []int{65532}) {
		t.Fatalf("no access: %+v", c)
	}

	// access, but the first node is the wrong GPU
	files = map[string]int{"/dev/dri/renderD129": 1, "/dev/dri/renderD128": 1}
	r = probeHW(ctx, fakeHW("amd64", "", files, map[string]bool{"vaapi/dev/dri/renderD129": true}))
	if got := codes(r); got != "nvenc=no_nvidia_device vaapi/dev/dri/renderD128=vaapi_driver_failed vaapi/dev/dri/renderD129=ok" {
		t.Fatalf("two nodes: %s", got)
	}
	if e := r.Candidates[1].Params.Error; e != "noise | Cannot load libva driver | Device creation failed" {
		t.Fatalf("excerpt: %q", e)
	}
	if r.Choice.Encoder != "vaapi" || r.Choice.Device != "/dev/dri/renderD129" || r.enc.device != r.Choice.Device {
		t.Fatalf("choice: %+v", r.Choice)
	}

	// NVENC wins over VA-API; with the device but a failing encode it is nvenc_failed
	files = map[string]int{"/dev/nvidiactl": 0, "/dev/dri/renderD128": 1}
	r = probeHW(ctx, fakeHW("amd64", "", files, map[string]bool{"nvenc": true, "vaapi/dev/dri/renderD128": true}))
	if r.Choice.Encoder != "nvenc" || r.Choice.MaxHeight != 1080 {
		t.Fatalf("nvenc first: %+v", r.Choice)
	}
	r = probeHW(ctx, fakeHW("amd64", "", files, nil))
	if r.Candidates[0].Code != "nvenc_failed" || r.Candidates[0].Params.Error == "" {
		t.Fatalf("nvenc failed: %+v", r.Candidates[0])
	}
}

func TestProbeModesAndArch(t *testing.T) {
	ctx := context.Background()
	files := map[string]int{"/dev/nvidiactl": 0, "/dev/dri/renderD128": 1}
	ok := map[string]bool{"nvenc": true, "vaapi/dev/dri/renderD128": true}

	r := probeHW(ctx, fakeHW("amd64", "VAAPI", files, ok))
	if r.Mode != "vaapi" || !r.ModeFromEnv || r.Candidates[0].Code != "skipped_by_mode" || r.Choice.Encoder != "vaapi" {
		t.Fatalf("vaapi only: %+v %s", r.Choice, codes(r))
	}
	r = probeHW(ctx, fakeHW("amd64", "off", files, ok))
	if r.Mode != "none" || r.Choice.Encoder != "software" || len(r.Issues) != 0 {
		t.Fatalf("none: %+v %+v", r.Choice, r.Issues)
	}
	// a forced mode that does not work
	r = probeHW(ctx, fakeHW("amd64", "nvenc", map[string]int{}, nil))
	if len(r.Issues) != 1 || r.Issues[0].Code != "forced_mode_failed" || r.Issues[0].Params.Mode != "nvenc" {
		t.Fatalf("forced: %+v", r.Issues)
	}
	// a Raspberry Pi: software only, no error
	r = probeHW(ctx, fakeHW("arm64", "", map[string]int{}, nil))
	if len(r.Issues) != 1 || r.Issues[0].Code != "arch_no_encoder" || r.Arch != "arm64" {
		t.Fatalf("arm64: %+v", r.Issues)
	}
	if got := ffExcerpt(strings.Repeat("x", 1000)); len(got) > hwExcerptMaxBytes+3 {
		t.Fatalf("excerpt length %d", len(got))
	}
}

func TestProberCachesAndNeverOverlaps(t *testing.T) {
	var runs, live, peak atomic.Int32
	env := fakeHW("amd64", "", map[string]int{"/dev/nvidiactl": 0}, nil)
	env.encode = func(context.Context, videoEncoder) (string, error) {
		runs.Add(1)
		if n := live.Add(1); n > peak.Load() {
			peak.Store(n)
		}
		time.Sleep(30 * time.Millisecond)
		live.Add(-1)
		return "", nil
	}
	p := &hwProber{env: env}
	if s := p.snapshot(); s.Probed || s.Choice != nil {
		t.Fatalf("before the first probe: %+v", s)
	}
	var wg sync.WaitGroup
	for range 6 {
		wg.Go(func() { p.report() })
	}
	wg.Wait()
	if runs.Load() != 1 {
		t.Fatalf("first use probed %d times, want once", runs.Load())
	}
	for range 4 {
		wg.Go(func() { p.reprobe() })
	}
	wg.Wait()
	if runs.Load() != 2 || peak.Load() != 1 {
		t.Fatalf("concurrent re-probes ran %d encodes (peak %d), want one more, never parallel", runs.Load(), peak.Load())
	}
	if s := p.snapshot(); !s.Probed || s.Probing || s.Choice.Encoder != "nvenc" {
		t.Fatalf("after: %+v", s)
	}
	// a later re-probe replaces the choice
	p.env.encode = func(context.Context, videoEncoder) (string, error) { return "gone", errors.New("x") }
	p.reprobe()
	if p.snapshot().Choice.Encoder != "software" || p.report().enc.name != "software" {
		t.Fatal("re-probe did not replace the choice")
	}
}

func TestHWAccelRoutesAreAdminOnly(t *testing.T) {
	mux, _, adminC, userC := setupAdminTest(t)
	for _, rt := range []struct{ method, path string }{{"GET", "/api/admin/hwaccel"}, {"POST", "/api/admin/hwaccel/probe"}} {
		if rec := doReq(mux, rt.method, rt.path, "", nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d", rt.method, rt.path, rec.Code)
		}
		if rec := doReq(mux, rt.method, rt.path, "", userC); rec.Code != http.StatusForbidden {
			t.Errorf("%s %s user: %d", rt.method, rt.path, rec.Code)
		}
	}
	rec := doReq(mux, "GET", "/api/admin/hwaccel", "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"candidates"`) {
		t.Fatalf("admin: %d %s", rec.Code, rec.Body)
	}
}
