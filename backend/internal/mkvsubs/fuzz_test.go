package mkvsubs

import (
	"bytes"
	"os"
	"testing"
)

// The files come off remote servers nobody here controls, so no input may
// panic: Read parses on worker goroutines, and a panic there takes the
// whole process down rather than one request. Run one at a time with e.g.
// `go test -fuzz=FuzzRead -fuzztime=1m ./internal/mkvsubs`; the seed alone
// runs with the normal tests.
func fuzzSeed(f *testing.F) {
	seed, err := os.ReadFile("testdata/seed.mkv")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(seed)
}

func FuzzRead(f *testing.F) {
	fuzzSeed(f)
	f.Fuzz(func(t *testing.T, b []byte) {
		s, err := Read(bytes.NewReader(b), int64(len(b)), 4)
		if err != nil {
			return
		}
		for _, tr := range s.Tracks {
			s.ASS(tr)
			s.SUP(tr)
		}
	})
}

func FuzzKeyframes(f *testing.F) {
	fuzzSeed(f)
	f.Fuzz(func(t *testing.T, b []byte) {
		Keyframes(bytes.NewReader(b), int64(len(b)))
	})
}

func FuzzAttachments(f *testing.F) {
	fuzzSeed(f)
	f.Fuzz(func(t *testing.T, b []byte) {
		r := bytes.NewReader(b)
		atts, _ := Attachments(r, int64(len(b)))
		for _, a := range atts {
			if a.Off >= 0 && a.Len >= 0 && a.Off+a.Len <= int64(len(b)) {
				ReadFont(bytes.NewReader(b[a.Off : a.Off+a.Len]))
			}
		}
		ReadFont(r)
	})
}
