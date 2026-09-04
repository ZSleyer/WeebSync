package transfer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenLocalSymlinksStayInsideRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "inside"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("inside", filepath.Join(root, "allowed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "escaped")); err != nil {
		t.Fatal(err)
	}

	p, err := OpenLocal([]string{root}, "allowed")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err := p.Root.ReadFile(p.Name); err != nil {
		t.Fatalf("in-root symlink rejected: %v", err)
	}

	escaped, err := OpenLocal([]string{root}, "escaped")
	if err != nil {
		t.Fatal(err)
	}
	defer escaped.Close()
	if _, err := escaped.Root.ReadFile(escaped.Name); err == nil {
		t.Fatal("escaping symlink was followed")
	}
}

func TestResolveLocalNestedRootsIgnoreSpelling(t *testing.T) {
	roots := []string{"/data", "/data/anime", "/mnt/nas"}
	cases := []struct{ in, root, rel string }{
		{"anime", "/data/anime", "."},
		{"/data/anime", "/data/anime", "."},
		{"anime/show/ep.mkv", "/data/anime", "show/ep.mkv"},
		{"data/anime/show", "/data/anime", "show"},
		{"movies/x", "/data", "movies/x"},
		{"mnt/nas/x", "/mnt/nas", "x"},
		{"/elsewhere/x", "/data", "elsewhere/x"},
		{".", "/data", "."},
	}
	for _, c := range cases {
		root, rel, abs, err := resolveLocal(roots, c.in)
		if err != nil || root != c.root || rel != c.rel || abs != filepath.Join(c.root, c.rel) {
			t.Errorf("%q: got root=%q rel=%q abs=%q err=%v, want %q %q", c.in, root, rel, abs, err, c.root, c.rel)
		}
	}
	if _, _, _, err := resolveLocal(roots, "../etc"); err == nil {
		t.Error("escaping relative path accepted")
	}
}
