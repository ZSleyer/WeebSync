package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLookOf(t *testing.T) {
	for q, want := range map[string]bool{
		"":       false, // no look asked: the book's own styles
		"look=1": true,
		"look=1&size=22&lead=1.8&theme=sepia&font=sans": true,
		"look=1&size=40":                false,
		"look=1&size=x":                 false,
		"look=1&lead=3":                 false,
		"look=1&theme=red%3B%7D*%7Bx:y": false,
		"look=1&font=Comic":             false,
		"size=22":                       false,
	} {
		v, _ := url.ParseQuery(q)
		if _, ok := lookOf(v); ok != want {
			t.Errorf("%q: ok = %v, want %v", q, ok, want)
		}
	}
	v, _ := url.ParseQuery("look=1&size=22&lead=1.8&theme=sepia&font=sans")
	l, _ := lookOf(v)
	css := l.css()
	for _, want := range []string{"font-size:22px", "line-height:1.8", "#f4ecd8", "system-ui"} {
		if !strings.Contains(css, want) {
			t.Errorf("css lacks %q: %s", want, css)
		}
	}
	if strings.ContainsAny(css, "<&") {
		t.Errorf("css not safe in XHTML: %s", css)
	}
}

func TestInjectLook(t *testing.T) {
	l := readerLook{size: 19, lead: 16, theme: "dark", font: "serif"}
	cases := map[string]string{
		// last in the head, after the book's own sheets
		`<html><head><link rel="stylesheet" href="a.css"/></head><body>x</body></html>`: `href="a.css"/><style id="weebsync-reader">`,
		// no head: one is made inside <html ...>
		`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>`: `<html xmlns="http://www.w3.org/1999/xhtml"><head><style id="weebsync-reader">`,
		// upper case tags too
		`<HTML><HEAD></HEAD><BODY>x</BODY></HTML>`: `<HEAD><style id="weebsync-reader">`,
		// characters whose lower case has another length (KELVIN SIGN, a
		// Latin-1 byte) do not move the spot
		"<html><head><title>3K \xe9t\xe9</title></head><body>x</body></html>": "\xe9t\xe9</title><style id=\"weebsync-reader\">",
		"<html Ka=\"1\"><body>x</body></html>":                                "<html Ka=\"1\"><head><style id=\"weebsync-reader\">",
	}
	for in, want := range cases {
		out := string(injectLook([]byte(in), l))
		if !strings.Contains(out, want) {
			t.Errorf("%s\n=> %s\nwant %s", in, out, want)
		}
		if strings.Count(out, "weebsync-reader") != 1 {
			t.Errorf("style written %d times: %s", strings.Count(out, "weebsync-reader"), out)
		}
	}
	// "<htmlx" is not the html tag; a bare fragment gets the style in front
	if out := string(injectLook([]byte(`<htmlx>y</htmlx>`), l)); !strings.HasPrefix(out, `<style id="weebsync-reader">`) {
		t.Errorf("fragment: %s", out)
	}
}

func TestReadEntryLook(t *testing.T) {
	dir := t.TempDir()
	chapter := `<html><head><title>c</title></head><body><p>text</p></body></html>`
	os.WriteFile(filepath.Join(dir, "c.xhtml"), []byte(chapter), 0o644)
	os.WriteFile(filepath.Join(dir, "s.css"), []byte("p{color:red}"), 0o644)
	s := testServer(t, &Server{})
	b := &book{key: "k", token: "tok", dir: dir, kind: "epub", used: time.Now()}
	s.books.byKey, s.books.byToken = map[string]*book{"k": b}, map[string]*book{"tok": b}
	mux := http.NewServeMux()
	mux.Handle("GET /api/read/b/{token}/{entry...}", http.HandlerFunc(s.handleReadEntry))
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		return rec
	}

	rec := get("/api/read/b/tok/c.xhtml?look=1&size=24&theme=light")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "font-size:24px") || !strings.Contains(rec.Body.String(), "#fbfbf8") {
		t.Fatalf("look not written: %d %s", rec.Code, rec.Body.String())
	}
	// the sandbox stays on the chapter
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
		t.Errorf("chapter not sandboxed: %q", csp)
	}
	// without a look, and for anything but markup, the bytes are the book's
	if rec := get("/api/read/b/tok/c.xhtml"); rec.Body.String() != chapter {
		t.Errorf("plain chapter changed: %s", rec.Body.String())
	}
	if rec := get("/api/read/b/tok/s.css?look=1"); rec.Body.String() != "p{color:red}" {
		t.Errorf("stylesheet changed: %s", rec.Body.String())
	}
	// a look out of range is ignored, not an error
	if rec := get("/api/read/b/tok/c.xhtml?look=1&size=99"); rec.Code != 200 || rec.Body.String() != chapter {
		t.Errorf("bad look: %d %s", rec.Code, rec.Body.String())
	}
}
