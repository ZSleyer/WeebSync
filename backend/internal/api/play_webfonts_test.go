package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestWebFonts(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	var fileReads atomic.Int32
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/meta":
			fmt.Fprint(w, `{"familyMetadataList":[
				{"family":"Carlito","fonts":{"400":{},"400i":{},"700":{}}},
				{"family":"Open Sans","fonts":{"300":{},"500":{}}},
				{"family":"Broken","fonts":{"400":{}}}]}`)
		case "/css2":
			fam, _, _ := strings.Cut(r.URL.Query().Get("family"), ":")
			fmt.Fprintf(w, "@font-face { src: url(%s/files/%s.ttf) format('truetype'); }", "http://"+r.Host, strings.ReplaceAll(fam, " ", ""))
		case "/files/Broken.ttf":
			fmt.Fprint(w, "<html>")
		default:
			fileReads.Add(1)
			w.Write(append([]byte{0, 1, 0, 0}, r.URL.Path...))
		}
	}))
	defer google.Close()
	defer func(a, b, c string) { webFontMetaURL, webFontCSSURL, webFontFilePrefix = a, b, c }(webFontMetaURL, webFontCSSURL, webFontFilePrefix)
	webFontMetaURL, webFontCSSURL, webFontFilePrefix = google.URL+"/meta", google.URL+"/css2", google.URL+"/files/"

	s := testServer(t, &Server{})
	rec := httptest.NewRecorder()
	s.handlePlayWebFonts(rec, httptest.NewRequest("GET", "/api/play/webfonts?family=Calibri&family=Hey+Gorgeous&family=open+sans", nil))
	var got map[string]WebFont
	json.Unmarshal(rec.Body.Bytes(), &got)
	want := map[string]WebFont{
		// Calibri gets its metric twin, a family Google lacks nothing
		"calibri": {"Carlito", "/api/play/webfont?family=Carlito&weight=400", "/api/play/webfont?family=Carlito&weight=700"},
		// the nearest weights a family has, the lighter one on a tie
		"open sans": {"Open Sans", "/api/play/webfont?family=Open+Sans&weight=300", "/api/play/webfont?family=Open+Sans&weight=500"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("resolved %v", got)
	}

	get := func(u string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.handlePlayWebFont(rec, httptest.NewRequest("GET", u, nil))
		return rec
	}
	for range 2 {
		if rec := get(want["calibri"].Bold); rec.Code != 200 || !strings.HasSuffix(rec.Body.String(), "/files/Carlito.ttf") {
			t.Fatalf("font: %d %q", rec.Code, rec.Body)
		}
	}
	if fileReads.Load() != 1 {
		t.Fatalf("the second request read the font again (%d reads)", fileReads.Load())
	}
	// not an open proxy: only listed families and weights; a page is no font
	for u, code := range map[string]int{
		"/api/play/webfont?family=Carlito&weight=900":    404,
		"/api/play/webfont?family=Comic+Sans&weight=400": 404,
		"/api/play/webfont?family=Broken&weight=400":     502,
	} {
		if rec := get(u); rec.Code != code {
			t.Errorf("%s: %d, want %d", u, rec.Code, code)
		}
	}
}
