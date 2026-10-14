package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// webFixture lays out a built frontend with bodies large enough to compress.
func webFixture(t *testing.T) (string, map[string][]byte) {
	t.Helper()
	dir := t.TempDir()
	big := strings.Repeat("const value = 'weebsync';\n", 200)
	files := map[string][]byte{
		"index.html":             []byte("<!doctype html><title>x</title>" + big),
		"assets/index-abc.js":    []byte(big),
		"assets/index-abc.css":   []byte(strings.Repeat(".a{color:red}\n", 200)),
		"assets/logo-abc.svg":    []byte("<svg xmlns='http://www.w3.org/2000/svg'>" + strings.Repeat("<g/>", 400) + "</svg>"),
		"assets/cover-abc.png":   append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 4000)...),
		"assets/font-abc.woff2":  append([]byte("wOF2"), bytes.Repeat([]byte{0}, 4000)...),
		"assets/tiny-abc.js":     []byte("x()"),
		"manifest.webmanifest":   []byte(`{"name":"WeebSync","pad":"` + strings.Repeat("a", 2000) + `"}`),
		"assets/data-abc.json":   []byte(`{"pad":"` + strings.Repeat("b", 2000) + `"}`),
		"assets/libass-abc.wasm": append([]byte("\x00asm\x01\x00\x00\x00"), bytes.Repeat([]byte{1, 2, 3, 4}, 1000)...),
		"assets/archive-abc.zip": append([]byte("PK\x03\x04"), bytes.Repeat([]byte{0}, 4000)...),
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir, files
}

func serveWith(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestGzipCompressesTextAssets(t *testing.T) {
	dir, files := webFixture(t)
	h := harden(gzipHandler(spaHandler(dir)))
	for _, name := range []string{"index.html", "assets/index-abc.js", "assets/index-abc.css", "assets/logo-abc.svg", "manifest.webmanifest", "assets/data-abc.json", "assets/libass-abc.wasm"} {
		path := "/" + name
		if name == "index.html" {
			path = "/" // the file server redirects /index.html to /
		}
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Accept-Encoding", "br, gzip;q=0.8")
		rec := serveWith(h, r)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d", name, rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("%s: Content-Encoding %q, want gzip", name, got)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("%s: Vary %q", name, got)
		}
		if rec.Header().Get("Content-Length") != "" {
			t.Errorf("%s: Content-Length %q left on a compressed body", name, rec.Header().Get("Content-Length"))
		}
		if rec.Header().Get("Accept-Ranges") != "" {
			t.Errorf("%s: Accept-Ranges left on a compressed body", name)
		}
		if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: security headers lost", name)
		}
		if rec.Body.Len() >= len(files[name]) {
			t.Errorf("%s: %d compressed bytes, not less than %d", name, rec.Body.Len(), len(files[name]))
		}
		if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, files[name]) {
			t.Errorf("%s: round-trip differs", name)
		}
	}
	// the cache headers of the static handler are kept
	r := httptest.NewRequest("GET", "/assets/index-abc.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	if got := serveWith(h, r).Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("Cache-Control %q", got)
	}
}

func TestGzipLeavesIdentityAlone(t *testing.T) {
	dir, files := webFixture(t)
	h := gzipHandler(spaHandler(dir))
	cases := []struct {
		name, path, accept string
		vary               bool
	}{
		{"no Accept-Encoding", "/assets/index-abc.js", "", true},
		{"gzip q=0", "/assets/index-abc.js", "gzip;q=0, deflate", true},
		{"wildcard q=0", "/assets/index-abc.js", "*;q=0", true},
		{"gzip refused despite wildcard", "/assets/index-abc.js", "*, gzip;q=0", true},
		{"png", "/assets/cover-abc.png", "gzip", false},
		{"woff2", "/assets/font-abc.woff2", "gzip", false},
		{"zip", "/assets/archive-abc.zip", "gzip", false},
		{"below the threshold", "/assets/tiny-abc.js", "gzip", true},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", c.path, nil)
		if c.accept != "" {
			r.Header.Set("Accept-Encoding", c.accept)
		}
		rec := serveWith(h, r)
		want := files[strings.TrimPrefix(c.path, "/")]
		if rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("%s: compressed", c.name)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("%s: body changed", c.name)
		}
		if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(len(want)) {
			t.Errorf("%s: Content-Length %q, want %d", c.name, got, len(want))
		}
		if got := rec.Header().Get("Vary") == "Accept-Encoding"; got != c.vary {
			t.Errorf("%s: Vary set %v, want %v", c.name, got, c.vary)
		}
	}
}

func TestGzipAcceptsWildcard(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Encoding", "identity, *")
	if !acceptsGzip(r) {
		t.Error("* should allow gzip")
	}
	r.Header.Set("Accept-Encoding", "GZIP; Q=0.001")
	if !acceptsGzip(r) {
		t.Error("q=0.001 should allow gzip")
	}
}

func TestGzipSkipsRangesAndHead(t *testing.T) {
	dir, files := webFixture(t)
	h := gzipHandler(spaHandler(dir))
	js := files["assets/index-abc.js"]

	r := httptest.NewRequest("GET", "/assets/index-abc.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("Range", "bytes=10-19")
	rec := serveWith(h, r)
	if rec.Code != http.StatusPartialContent || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("range: status %d, encoding %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(rec.Body.Bytes(), js[10:20]) || rec.Header().Get("Content-Length") != "10" {
		t.Errorf("range: body %q, Content-Length %q", rec.Body.Bytes(), rec.Header().Get("Content-Length"))
	}

	r = httptest.NewRequest("HEAD", "/assets/index-abc.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	rec = serveWith(h, r)
	if rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Content-Length") != strconv.Itoa(len(js)) {
		t.Errorf("head: encoding %q, Content-Length %q", rec.Header().Get("Content-Encoding"), rec.Header().Get("Content-Length"))
	}
}

func TestGzipNotModified(t *testing.T) {
	dir, _ := webFixture(t)
	h := gzipHandler(spaHandler(dir))
	info, err := os.Stat(filepath.Join(dir, "assets/index-abc.js"))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/assets/index-abc.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("If-Modified-Since", info.ModTime().UTC().Add(time.Second).Format(http.TimeFormat))
	rec := serveWith(h, r)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 || rec.Header().Get("Content-Encoding") != "" {
		t.Errorf("304 carries body %d / encoding %q", rec.Body.Len(), rec.Header().Get("Content-Encoding"))
	}
	if rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Errorf("304 Vary %q", rec.Header().Get("Vary"))
	}
}

// etagged serves a body under a strong ETag the way http.ServeContent does,
// so If-None-Match is answered with the standard weak comparison.
func etagged(body []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Content-Type", "application/json")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
	})
}

func TestGzipETagIsWeakenedAndStillRevalidates(t *testing.T) {
	body := []byte(`{"pad":"` + strings.Repeat("c", 3000) + `"}`)
	h := gzipHandler(etagged(body))

	r := httptest.NewRequest("GET", "/api/x", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	rec := serveWith(h, r)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("not compressed")
	}
	tag := rec.Header().Get("ETag")
	if tag != `W/"v1"` {
		t.Fatalf("compressed ETag %q, want W/\"v1\"", tag)
	}

	// identity keeps the strong validator
	rec = serveWith(h, httptest.NewRequest("GET", "/api/x", nil))
	if got := rec.Header().Get("ETag"); got != `"v1"` {
		t.Errorf("identity ETag %q", got)
	}

	// the client sends back what it was given and gets a 304 for it
	r = httptest.NewRequest("GET", "/api/x", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("If-None-Match", tag)
	rec = serveWith(h, r)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("revalidation: status %d, body %d", rec.Code, rec.Body.Len())
	}
	if got := rec.Header().Get("ETag"); got != tag {
		t.Errorf("304 ETag %q, want %q", got, tag)
	}
}

func TestGzipCompressesUnsizedJSON(t *testing.T) {
	body := `{"items":[` + strings.Repeat(`{"title":"One Piece"},`, 100) + `{}]}`
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		io.WriteString(w, body)
	}))
	srv := httptest.NewServer(h)
	defer srv.Close()
	// the transport asks for gzip and decodes it transparently
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if !resp.Uncompressed {
		t.Error("response was not gzip-encoded")
	}
	if string(got) != body {
		t.Error("round-trip differs")
	}
	if resp.ContentLength != -1 && resp.ContentLength != int64(len(got)) {
		t.Errorf("Content-Length %d for %d bytes", resp.ContentLength, len(got))
	}
}

func TestGzipSniffsUntypedBodies(t *testing.T) {
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<!doctype html>"+strings.Repeat("<p>x</p>", 300))
	}))
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	rec := serveWith(h, r)
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Errorf("type %q, encoding %q", rec.Header().Get("Content-Type"), rec.Header().Get("Content-Encoding"))
	}
}

func TestGzipLeavesEventStreamsFlushing(t *testing.T) {
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher.Flush()
		io.WriteString(w, "data: "+strings.Repeat("x", 2000)+"\n\n")
		flusher.Flush()
	}))
	r := httptest.NewRequest("GET", "/api/events", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	rec := serveWith(h, r)
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("status %d, encoding %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if !rec.Flushed {
		t.Error("flush did not reach the connection")
	}
	if !strings.HasPrefix(rec.Body.String(), "data: ") {
		t.Errorf("body %q", rec.Body.String()[:20])
	}
}

func TestGzipFlushesCompressedStreams(t *testing.T) {
	// a compressible body that is flushed mid-way must arrive decodable up to
	// that point, not sit in the compressor
	release := make(chan struct{})
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, "second\n")
	}))
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 6)
	if _, err := io.ReadFull(resp.Body, buf); err != nil || string(buf) != "first\n" {
		t.Fatalf("before release: %q %v", buf, err)
	}
	close(release)
	rest, _ := io.ReadAll(resp.Body)
	if string(rest) != "second\n" {
		t.Errorf("after release: %q", rest)
	}
}

func TestGzipSkipsFileRoutesAndAttachments(t *testing.T) {
	body := strings.Repeat("plain text ", 300)
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		if r.URL.Path == "/api/arr/nzb" {
			w.Header().Set("Content-Type", "application/xml")
			w.Header().Set("Content-Disposition", `attachment; filename="x.nzb"`)
		}
		io.WriteString(w, body)
	}))
	for _, p := range []string{"/api/play/sub", "/api/read/b/tok/ch1.xhtml", "/api/arr/nzb"} {
		r := httptest.NewRequest("GET", p, nil)
		r.Header.Set("Accept-Encoding", "gzip")
		rec := serveWith(h, r)
		if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != body {
			t.Errorf("%s: compressed", p)
		}
	}
}

func TestGzipKeepsResponseController(t *testing.T) {
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
			http.Error(w, err.Error(), 500)
		}
	}))
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status %d: the controller could not reach the connection", resp.StatusCode)
	}
}
