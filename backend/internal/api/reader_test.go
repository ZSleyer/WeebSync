package api

import (
	"archive/zip"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestUnpackComic(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "vol.cbr") // a zip under a rar name: the bytes decide
	f, _ := os.Create(arc)
	zw := zip.NewWriter(f)
	for _, n := range []string{"10.jpg", "2.jpg", "1.jpg", "../escape.jpg", "/abs.png", "__MACOSX/._1.jpg", "info.txt"} {
		w, _ := zw.Create(n)
		w.Write([]byte("x"))
	}
	zw.Close()
	f.Close()

	in, _ := os.Open(arc)
	defer in.Close()
	fi, _ := in.Stat()
	out := filepath.Join(tmp, "out")
	os.Mkdir(out, 0o700)
	if err := unpack(&playFile{ReadSeeker: in, size: fi.Size()}, out); err != nil {
		t.Fatal(err)
	}
	// names that pointed out of the folder land inside it
	got := comicPages(out)
	want := []string{"1.jpg", "2.jpg", "10.jpg", "abs.png", "escape.jpg"}
	if !slices.Equal(got, want) {
		t.Errorf("pages = %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(tmp, "escape.jpg")); err == nil {
		t.Error("entry escaped the book folder")
	}

	s := testServer(t, &Server{})
	b := &book{key: "k", token: "tok", dir: out, kind: "comic", used: time.Now()}
	s.books.byKey, s.books.byToken = map[string]*book{"k": b}, map[string]*book{"tok": b}
	mux := http.NewServeMux()
	mux.Handle("GET /api/read/b/{token}/{entry...}", http.HandlerFunc(s.handleReadEntry))
	for path, code := range map[string]int{
		"/api/read/b/tok/2.jpg":        200,
		"/api/read/b/tok/..%2f..%2fx":  404,
		"/api/read/b/nope/2.jpg":       404,
		"/api/read/b/tok/__MACOSX/._1": 404,
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != code {
			t.Errorf("%s: %d, want %d", path, rec.Code, code)
		}
		if code == 200 {
			if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
				t.Errorf("content type %q", ct)
			}
			if csp := rec.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
				t.Errorf("entry not sandboxed: %q", csp)
			}
		}
	}
}

// a RAR5 archive holding ch/2.png and ch/10.png, made with `rar a -ma5`
const rar5Fixture = "526172211a0701003392b5e50a0105060005010180800012fce1102602030b8100048100a4830243beb7e88000010863682f322e706e670a0313c2f1cb6a6e3d072161f61754de2702030b8100048100a48302f9efbe718000010963682f31302e706e670a0313c2f1cb6a6e3d0721622e2e57871a02030b000100ed83018000010263680a0313c2f1cb6a6e3d07211d77565103050400"

func TestUnpackRar(t *testing.T) {
	tmp := t.TempDir()
	raw, _ := hex.DecodeString(rar5Fixture)
	arc := filepath.Join(tmp, "vol.cbz") // a rar under a zip name
	os.WriteFile(arc, raw, 0o600)
	in, _ := os.Open(arc)
	defer in.Close()
	out := filepath.Join(tmp, "out")
	os.Mkdir(out, 0o700)
	if err := unpack(&playFile{ReadSeeker: in, size: int64(len(raw))}, out); err != nil {
		t.Fatal(err)
	}
	if got, want := comicPages(out), []string{"ch/2.png", "ch/10.png"}; !slices.Equal(got, want) {
		t.Errorf("pages = %v, want %v", got, want)
	}
}

func TestNaturalCompare(t *testing.T) {
	l := []string{"p10.png", "P2.png", "p1.png", "a/p3.png", "p01b.png"}
	slices.SortFunc(l, naturalCompare)
	want := []string{"a/p3.png", "p1.png", "p01b.png", "P2.png", "p10.png"}
	if !slices.Equal(l, want) {
		t.Errorf("got %v, want %v", l, want)
	}
	// letters, not bytes: two accented ones are not alike for sharing a
	// lead byte, and the case of one does not count
	l = []string{"Öa.png", "Äb.png", "éd.png", "Éc.png"}
	slices.SortFunc(l, naturalCompare)
	want = []string{"Äb.png", "Éc.png", "éd.png", "Öa.png"}
	if !slices.Equal(l, want) {
		t.Errorf("got %v, want %v", l, want)
	}
}
