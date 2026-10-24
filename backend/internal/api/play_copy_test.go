package api

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// mkvElem writes an EBML element with an 8-byte size.
func mkvElem(id uint64, parts ...[]byte) []byte {
	b := bytes.TrimLeft(binary.BigEndian.AppendUint64(nil, id), "\x00")
	payload := slices.Concat(parts...)
	size := binary.BigEndian.AppendUint64(nil, uint64(len(payload)))
	size[0] = 0x01 // the 8-byte length marker
	return slices.Concat(b, size, payload)
}

func mkvUint(id, v uint64) []byte { return mkvElem(id, binary.BigEndian.AppendUint64(nil, v)) }

// mkvWithKeyframes is a Matroska head with one video track whose Cues index
// a keyframe at each of the given milliseconds.
func mkvWithKeyframes(ms ...uint64) []byte {
	var points [][]byte
	for _, t := range ms {
		points = append(points, mkvElem(0xBB, mkvUint(0xB3, t), mkvElem(0xB7, mkvUint(0xF7, 1), mkvUint(0xF1, 0))))
	}
	body := slices.Concat(
		mkvElem(0x1549A966, mkvUint(0x2AD7B1, 1_000_000)),                                                    // Info
		mkvElem(0x1654AE6B, mkvElem(0xAE, mkvUint(0xD7, 1), mkvUint(0x83, 1), mkvElem(0x86, []byte("V_X")))), // Tracks
		mkvElem(0x1C53BB6B, points...),                                                                       // Cues
	)
	return slices.Concat(mkvElem(0x1A45DFA3, mkvElem(0x4282, []byte("matroska"))), mkvElem(0x18538067, body))
}

// A failed read of the keyframe index is not remembered (the file would be
// transcoded until a restart), and a file replaced at the same path is read
// again when a playback starts.
func TestCopyCutsFailureAndReplacement(t *testing.T) {
	root := t.TempDir()
	s := &Server{LocalRoots: []string{root}}
	src := playSource{path: filepath.Base(root) + ".mkv"}
	file := filepath.Join(root, src.path)
	t.Cleanup(func() { cutCache.forget(src) })

	if got := s.copyCuts(t.Context(), src, true); got != nil {
		t.Fatalf("missing file: %v", got)
	}
	if err := os.WriteFile(file, mkvWithKeyframes(0, 7000), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.copyCuts(t.Context(), src, false); !slices.Equal(got, []float64{0, 7}) {
		t.Fatalf("after the failure: %v", got)
	}
	// replaced while nobody watches: a new playback (the playlist) sees it
	if err := os.WriteFile(file, mkvWithKeyframes(0, 10000, 20000), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.copyCuts(t.Context(), src, true); !slices.Equal(got, []float64{0, 10, 20}) {
		t.Fatalf("after the replacement: %v", got)
	}
	// a file without a keyframe index is one: that is remembered
	if err := os.WriteFile(file, mkvWithKeyframes(0), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.copyCuts(t.Context(), src, true); got != nil {
		t.Fatalf("no index: %v", got)
	}
	if e, ok := cutCache.get(src); !ok || e.cuts != nil {
		t.Fatalf("no index not remembered: %+v %v", e, ok)
	}
}

// The cache does not grow without bound.
func TestCutCacheBounded(t *testing.T) {
	var c cutIndex
	for i := range 3 * cutCacheMax {
		c.put(playSource{serverID: int64(i)}, cutEntry{})
	}
	c.mu.Lock()
	n := len(c.all)
	c.mu.Unlock()
	if n > cutCacheMax {
		t.Fatalf("%d entries", n)
	}
}

// A file's Cues can name keyframes far past any real length (forged, or a
// broken file) within the 16 MiB a header element may take. The segments are
// capped like the transcode playlist, by hlsMaxDuration, whatever the index says.
func TestCutsFromCapped(t *testing.T) {
	kf := make([]time.Duration, 0, 200000)
	for i := range 200000 {
		kf = append(kf, time.Duration(i)*hlsSegSec*time.Second)
	}
	cuts := cutsFrom(kf)
	if limit := hlsMaxDuration/hlsSegSec + 1; len(cuts) > limit {
		t.Fatalf("%d segments, want at most %d", len(cuts), limit)
	}
	if last := cuts[len(cuts)-1]; last > hlsMaxDuration {
		t.Fatalf("a segment starts at %.0fs, past the %ds clamp", last, hlsMaxDuration)
	}
	// a normal episode keeps every cut
	if got := cutsFrom(kf[:240]); len(got) != 240 {
		t.Fatalf("a 24-minute file cut into %d segments, want 240", len(got))
	}
}
