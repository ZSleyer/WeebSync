package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/rename"
)

// A path with a NUL is malformed, not a missing directory: 400 on the listing
// and on the rename preview.
func TestMalformedLocalPathIs400(t *testing.T) {
	s := &Server{DownloadRoot: t.TempDir()}
	w := httptest.NewRecorder()
	s.handleBrowseLocal(w, httptest.NewRequest(http.MethodGet, "/api/browse/local?path=a%00b", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("browse: got %d, want 400", w.Code)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/rename/preview", strings.NewReader(`{"path":"a\u0000b","mode":"regex","pattern":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	s.handleRenamePreview(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("preview: got %d, want 400", w.Code)
	}
}

// A regex pattern over 4 KiB is refused on every route that takes one.
func TestRenamePatternLimit(t *testing.T) {
	s := &Server{DownloadRoot: t.TempDir()}
	long := strings.Repeat("a", rename.MaxPattern+1)
	body := `{"path":"","names":["x"],"mode":"regex","pattern":"` + long + `"}`
	for name, h := range map[string]http.HandlerFunc{"preview": s.handleRenamePreview, "names": s.handleRenameNames} {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", name, w.Code)
		}
	}
	if _, err := rename.New("x", rename.Options{Mode: "regex", Pattern: long}); err == nil {
		t.Error("rename.New accepted an oversized pattern")
	}
	if _, err := rename.New("x", rename.Options{Mode: "regex", Pattern: strings.Repeat("a", rename.MaxPattern)}); err != nil {
		t.Errorf("4096 bytes must pass: %v", err)
	}
}
