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
