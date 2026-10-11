package api

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/mkvsubs"
)

func TestFontCache(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	defer func(n int64) { fontCacheMax = n }(fontCacheMax)
	fontCacheMax = 25
	var c fontCache
	c.put("a", bytes.Repeat([]byte("a"), 10))
	c.put("b", bytes.Repeat([]byte("b"), 10))
	// a is used again, so b is the oldest when c pushes past the limit
	os.Chtimes(filepath.Join(fontCacheDir(), "b"), time.Now().Add(-time.Hour), time.Now().Add(-time.Hour))
	c.get("a")
	c.put("c", bytes.Repeat([]byte("c"), 10))
	if c.get("b") != nil || len(c.get("a")) != 10 || len(c.get("c")) != 10 {
		t.Fatal("not the least recently used one went")
	}
}

func TestHoleReader(t *testing.T) {
	file := make([]byte, 100)
	for i := range file {
		file[i] = byte(i + 1)
	}
	holes := []mkvsubs.Attachment{{Off: 10, Len: 10}, {Off: 30, Len: 5}}
	want := bytes.Clone(file)
	clear(want[10:20])
	clear(want[30:35])

	h := &holeReader{rs: bytes.NewReader(file), holes: holes}
	// small reads cross every edge
	var got []byte
	buf := make([]byte, 7)
	for {
		n, err := h.Read(buf)
		got = append(got, buf[:n]...)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("read %v", got)
	}
	// into a hole and out of it again, as ServeContent seeks to a range
	if _, err := h.Seek(15, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	got = make([]byte, 10)
	if _, err := io.ReadFull(h, got); err != nil || !bytes.Equal(got, want[15:25]) {
		t.Fatalf("from 15: %v %v", got, err)
	}
}
