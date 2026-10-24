package api

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/nwaples/rardecode/v2"
)

func rarFixture(t testing.TB, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The second file of a RAR 7.0 archive was refused with "multiple decoders in
// a single archive": the check compared the 5.0 decoder that runs it with the
// file's 7.0 version. The fixture is a two-file archive whose file headers
// claim the 7.0 decoder (its packed data is 5.0, so only the headers are read).
func TestRar70SecondFileIsAccepted(t *testing.T) {
	rr, err := rardecode.NewReader(bytes.NewReader(rarFixture(t, "rar70_two_files.rar")))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"a.txt", "b.txt"} {
		h, err := rr.Next()
		if err != nil {
			t.Fatalf("%s: %v", want, err)
		}
		if h.Name != want {
			t.Fatalf("name = %q, want %q", h.Name, want)
		}
	}
}

// RAR 2.0 archives (the decoder with the offset history) still unpack through
// the path WeebSync uses; the reader verifies each file's CRC.
func TestUnpackRar20(t *testing.T) {
	for _, name := range []string{"v20_mixed.rar", "v20_solid.rar"} {
		b := rarFixture(t, name)
		out := t.TempDir()
		if err := unpack(context.Background(), &playFile{ReadSeeker: bytes.NewReader(b), size: int64(len(b))}, out); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// FuzzUnpackRar feeds arbitrary bytes to the RAR path of unpack. Malformed
// input has to end in an error, never a panic or an endless loop.
func FuzzUnpackRar(f *testing.F) {
	for _, name := range []string{"rar70_two_files.rar", "v20_mixed.rar", "v20_solid.rar"} {
		f.Add(rarFixture(f, name))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if !bytes.HasPrefix(b, []byte("Rar!")) {
			b = append([]byte("Rar!"), b...)
		}
		unpack(context.Background(), &playFile{ReadSeeker: bytes.NewReader(b), size: int64(len(b))}, t.TempDir())
	})
}
