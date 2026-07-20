package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// post/delete helpers: the handlers are exercised directly, the adminOnly
// wrapper is covered by the route table.
func callLocal(t *testing.T, h http.HandlerFunc, method, body string) int {
	t.Helper()
	r := httptest.NewRequest(method, "/api/browse/local", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h(w, r)
	return w.Code
}

func TestRenameLocal(t *testing.T) {
	root := t.TempDir()
	s := &Server{DownloadRoot: root}
	if err := os.WriteFile(filepath.Join(root, "a.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "taken.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"a.mkv","name":"../escape.mkv"}`); code != http.StatusBadRequest {
		t.Errorf("separator in name: got %d, want 400", code)
	}
	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"a.mkv","name":".."}`); code != http.StatusBadRequest {
		t.Errorf("dot-dot name: got %d, want 400", code)
	}
	// ".." resolves back onto the root, and renaming that would move the whole
	// mount out of its parent
	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"..","name":"gone"}`); code != http.StatusBadRequest {
		t.Errorf("rename root: got %d, want 400", code)
	}
	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"a.mkv","name":"taken.mkv"}`); code != http.StatusConflict {
		t.Errorf("existing target: got %d, want 409", code)
	}
	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"a.mkv","name":"b.mkv"}`); code != http.StatusOK {
		t.Fatalf("rename: got %d, want 200", code)
	}
	if _, err := os.Stat(filepath.Join(root, "b.mkv")); err != nil {
		t.Errorf("renamed file missing: %v", err)
	}
}

// production configures a relative download root ("data/downloads"), which is
// where resolving the rename target a second time used to re-anchor it at the
// root and leave the file untouched.
func TestRenameLocalRelativeRoot(t *testing.T) {
	base := t.TempDir()
	t.Chdir(base)
	if err := os.MkdirAll("data/downloads/season", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("data/downloads/season/e01.mkv", []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{DownloadRoot: "data/downloads"}
	if code := callLocal(t, s.handleRenameLocal, http.MethodPost, `{"path":"/season/e01.mkv","name":"e02.mkv"}`); code != http.StatusOK {
		t.Fatalf("rename: got %d, want 200", code)
	}
	if _, err := os.Stat("data/downloads/season/e02.mkv"); err != nil {
		t.Errorf("renamed file not next to the original: %v", err)
	}
}

func TestDeleteLocal(t *testing.T) {
	root := t.TempDir()
	s := &Server{DownloadRoot: root}
	full := filepath.Join(root, "season")
	if err := os.MkdirAll(full, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, "e01.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := callLocal(t, s.handleDeleteLocal, http.MethodDelete, `{"path":""}`); code != http.StatusBadRequest {
		t.Errorf("delete root: got %d, want 400", code)
	}
	if code := callLocal(t, s.handleDeleteLocal, http.MethodDelete, `{"path":"season"}`); code != http.StatusInternalServerError {
		t.Errorf("non-empty dir without recursive: got %d, want 500", code)
	}
	if _, err := os.Stat(full); err != nil {
		t.Errorf("folder was removed despite the failure: %v", err)
	}
	if code := callLocal(t, s.handleDeleteLocal, http.MethodDelete, `{"path":"season","recursive":true}`); code != http.StatusOK {
		t.Fatalf("recursive delete: got %d, want 200", code)
	}
	if _, err := os.Stat(full); !os.IsNotExist(err) {
		t.Errorf("folder still there after recursive delete")
	}
}
