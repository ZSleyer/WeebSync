package mkvsubs

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"slices"
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
	f.Add(cueOverflowMKV(1<<63, 1<<63-5000))
}

// ebmlElem writes an element with an 8-byte size, so a parent's length does
// not depend on the values inside it.
func ebmlElem(id uint64, parts ...[]byte) []byte {
	var b bytes.Buffer
	idb := binary.BigEndian.AppendUint64(nil, id)
	b.Write(bytes.TrimLeft(idb, "\x00"))
	var payload []byte
	for _, p := range parts {
		payload = append(payload, p...)
	}
	size := binary.BigEndian.AppendUint64(nil, uint64(len(payload)))
	size[0] = 0x01 // the 8-byte length marker
	b.Write(size)
	b.Write(payload)
	return b.Bytes()
}

func ebmlUint(id, v uint64) []byte {
	return ebmlElem(id, binary.BigEndian.AppendUint64(nil, v))
}

// cueOverflowMKV is a Matroska file with one text track whose two cue
// points share a cluster and carry the given relative positions.
func cueOverflowMKV(rel1, rel2 uint64) []byte {
	head := slices.Concat(
		ebmlElem(idInfo, ebmlUint(0x2AD7B1, 1_000_000)),
		ebmlElem(idTracks, ebmlElem(0xAE, ebmlUint(0xD7, 1), ebmlUint(0x83, 17), ebmlElem(0x86, []byte("S_TEXT/UTF8")))),
	)
	cues := func(cluster uint64) []byte {
		point := func(t, rel uint64) []byte {
			return ebmlElem(0xBB, ebmlUint(0xB3, t),
				ebmlElem(0xB7, ebmlUint(0xF7, 1), ebmlUint(0xF1, cluster), ebmlUint(0xF0, rel)))
		}
		return ebmlElem(idCues, point(0, rel1), point(1, rel2))
	}
	cluster := uint64(len(head) + len(cues(0)))
	body := slices.Concat(head, cues(cluster), ebmlElem(idCluster, ebmlUint(0xE7, 0)))
	return slices.Concat(ebmlElem(0x1A45DFA3, ebmlElem(0x4282, []byte("matroska"))), ebmlElem(idSegment, body))
}

// Cue positions past the end of the file are not followed: two near 2^63
// once wrapped the distance between them negative and sized a read buffer
// below zero, a panic on a worker goroutine.
func TestReadCuePositionsOutOfFile(t *testing.T) {
	for _, rels := range [][2]uint64{{1 << 63, 1<<63 - 5000}, {1 << 62, 1}, {math.MaxUint64, 1}} {
		b := cueOverflowMKV(rels[0], rels[1])
		_, err := Read(bytes.NewReader(b), int64(len(b)), 4)
		if err == nil {
			t.Errorf("%v: no error", rels)
		}
	}
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
