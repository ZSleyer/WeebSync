package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// applyRenames calls handleRenameApply directly; the auth wrapper is covered
// by the route table.
func applyRenames(t *testing.T, s *Server, body string) []renamePair {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/rename/apply", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.handleRenameApply(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("apply: got %d, want 200", w.Code)
	}
	var out []renamePair
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

// The aired-order templates produce "Season NN/..." targets, so a target may
// descend into a subfolder - but never climb out of the directory.
func TestRenameApplySubfolderStaysInRoot(t *testing.T) {
	root := t.TempDir()
	s := &Server{DownloadRoot: root}
	for _, n := range []string{"ep1.mkv", "ep2.mkv", "ep3.mkv", "ep4.mkv"} {
		if err := os.WriteFile(filepath.Join(root, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	got := applyRenames(t, s, `{"path":"","renames":[
		{"old":"ep1.mkv","new":"Season 01/S01E01.mkv"},
		{"old":"ep2.mkv","new":"../escape.mkv"},
		{"old":"ep3.mkv","new":"/etc/passwd"},
		{"old":"ep4.mkv","new":"a/../../../escape.mkv"}
	]}`)
	if len(got) != 4 {
		t.Fatalf("got %d results, want 4", len(got))
	}

	if got[0].Err != "" {
		t.Errorf("subfolder target rejected: %q", got[0].Err)
	}
	if _, err := os.Stat(filepath.Join(root, "Season 01", "S01E01.mkv")); err != nil {
		t.Errorf("subfolder target missing: %v", err)
	}

	for _, i := range []int{1, 2, 3} {
		if got[i].Err == "" {
			t.Errorf("escaping target %q was accepted", got[i].New)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "escape.mkv")); err == nil {
		t.Error("a file escaped the download root")
	}
}

func TestRenameApplyRejectsSourceWithSeparator(t *testing.T) {
	root := t.TempDir()
	s := &Server{DownloadRoot: root}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "x.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := applyRenames(t, s, `{"path":"","renames":[{"old":"sub/x.mkv","new":"y.mkv"}]}`)
	if got[0].Err == "" {
		t.Error("source with a separator was accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "sub", "x.mkv")); err != nil {
		t.Errorf("source file was touched: %v", err)
	}
}
