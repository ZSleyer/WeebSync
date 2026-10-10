package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// fakeRemote serves one in-memory file and counts how often it was opened.
type fakeRemote struct {
	data  []byte
	opens []int64
}

func (f *fakeRemote) List(string) ([]remote.Entry, error) { return nil, nil }
func (f *fakeRemote) Size(string) (int64, error)          { return int64(len(f.data)), nil }
func (f *fakeRemote) Close() error                        { return nil }
func (f *fakeRemote) Open(_ string, off int64) (io.ReadCloser, error) {
	f.opens = append(f.opens, off)
	return io.NopCloser(bytes.NewReader(f.data[off:])), nil
}

// A browser seeks by asking for a byte range; the remote file has to be read
// from that offset, not from the start.
func TestRemoteFileServesRanges(t *testing.T) {
	data := []byte(strings.Repeat("0123456789", 100))
	fr := &fakeRemote{data: data}
	rf := &remoteFile{c: fr, path: "/x.mkv", size: int64(len(data))}

	rec := httptest.NewRecorder()
	// as servePlayFile does: without a type ServeContent sniffs the first
	// 512 bytes, which on a remote file is a second open from offset 0
	rec.Header().Set("Content-Type", playMime("x.mkv"))
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Range", "bytes=500-509")
	http.ServeContent(rec, req, "", time.Time{}, rf)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status %d, want 206", rec.Code)
	}
	if got := rec.Body.String(); got != "0123456789" {
		t.Fatalf("body %q", got)
	}
	if len(fr.opens) != 1 || fr.opens[0] != 500 {
		t.Fatalf("opened at %v, want once at 500", fr.opens)
	}
}

// The playlist covers the whole file in fixed slices; the last one is the
// remainder, and every segment URL carries its number.
func TestHLSPlaylistCoversTheFile(t *testing.T) {
	pl := hlsPlaylist(20.5, url.Values{"path": {"/a.mkv"}})
	if n := strings.Count(pl, "#EXTINF"); n != 4 {
		t.Fatalf("%d segments, want 4:\n%s", n, pl)
	}
	if !strings.Contains(pl, "#EXTINF:2.500,\nseg.ts?n=3&path=%2Fa.mkv") {
		t.Fatalf("last segment wrong:\n%s", pl)
	}
	if !strings.HasSuffix(pl, "#EXT-X-ENDLIST\n") {
		t.Fatal("playlist not closed")
	}
}

// A file named like a video that is really an ffconcat playlist must not get
// ffmpeg to open what it points at - here a video outside the media root.
func TestPlayInfoRefusesPlaylistsInDisguise(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	root, outside := t.TempDir(), t.TempDir()
	secret := filepath.Join(outside, "secret.mkv")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=d=1:s=64x64",
		"-c:v", "ffv1", secret).CombinedOutput(); err != nil {
		t.Fatalf("make sample: %v %s", err, out)
	}
	os.WriteFile(filepath.Join(root, "evil.mkv"), []byte("ffconcat version 1.0\nfile '"+secret+"'\n"), 0o644)
	real, _ := os.ReadFile(secret)
	os.WriteFile(filepath.Join(root, "real.mkv"), real, 0o644)

	s := &Server{DownloadRoot: root, LocalRoots: []string{root}}
	ctx := context.Background()
	if info, err := s.playInfo(ctx, playSource{path: "/real.mkv"}); err != nil || info.Video == nil {
		t.Fatalf("a real mkv must open: %v %+v", err, info)
	}
	if info, err := s.playInfo(ctx, playSource{path: "/evil.mkv"}); err == nil {
		t.Fatalf("the concat playlist opened: %+v", info)
	}
}
