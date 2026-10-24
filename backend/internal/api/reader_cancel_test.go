package api

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// writeComic writes a zip comic of n pages at path.
func writeComic(t *testing.T, path string, n int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for i := range n {
		w, err := zw.Create(filepath.Join("pages", string(rune('a'+i))+".jpg"))
		if err != nil {
			t.Fatal(err)
		}
		w.Write(make([]byte, 4096))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// A reader that closed the page (or a server shutting down) cancels the
// request; the unpack it started has to stop instead of writing the whole
// archive out while holding one of the two global slots.
func TestUnpackBookStopsWhenCanceled(t *testing.T) {
	s, root := sizeTestServer(t)
	arc := filepath.Join(root, "vol.cbz")
	writeComic(t, arc, 8)
	src := playSource{userID: 1, path: arc}

	b, err := s.unpackBook(context.Background(), src)
	if err != nil {
		t.Fatalf("precondition, a live request unpacks: %v", err)
	}
	os.RemoveAll(b.dir)

	before, _ := os.ReadDir(bookCacheDir())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.unpackBook(ctx, src); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled unpack: err = %v, want context.Canceled", err)
	}
	after, _ := os.ReadDir(bookCacheDir())
	if len(after) != len(before) {
		t.Errorf("a canceled unpack left %d entries in the cache, had %d", len(after), len(before))
	}

	// the extraction itself checks: nothing is written once ctx is done
	in, err := os.Open(arc)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	fi, _ := in.Stat()
	out := t.TempDir()
	if err := unpack(ctx, &playFile{ReadSeeker: in, size: fi.Size()}, out); !errors.Is(err, context.Canceled) {
		t.Fatalf("unpack with a canceled ctx: %v", err)
	}
	if pages := comicPages(out); len(pages) != 0 {
		t.Errorf("%d pages written after cancel", len(pages))
	}
}
