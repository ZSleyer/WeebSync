package api

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A symlink inside a media folder that points outside the configured roots
// must not be handed to ffprobe.
func TestProbeQualityStaysInsideRoot(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}
	root, outside := t.TempDir(), t.TempDir()
	show := filepath.Join(root, "Show")
	os.MkdirAll(show, 0o755)
	os.WriteFile(filepath.Join(show, "in.mkv"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(outside, "secret.mkv"), []byte("y"), 0o644)
	if err := os.Symlink(filepath.Join(outside, "secret.mkv"), filepath.Join(show, "esc.mkv")); err != nil {
		t.Skip(err)
	}
	orig := probeOpenFile
	t.Cleanup(func() { probeOpenFile = orig })
	var seen []string
	probeOpenFile = func(_ context.Context, f *os.File, _ ...string) ([]probeStream, bool) {
		seen = append(seen, filepath.Base(f.Name()))
		return []probeStream{{CodecType: "video", Height: 1080}}, true
	}
	s := &Server{DownloadRoot: root, LocalRoots: []string{root}}
	if _, ok := s.probeQuality(show); !ok {
		t.Fatal("in-root video was not probed")
	}
	if len(seen) != 1 || seen[0] != "in.mkv" {
		t.Fatalf("probed %v, want only in.mkv", seen)
	}
}
