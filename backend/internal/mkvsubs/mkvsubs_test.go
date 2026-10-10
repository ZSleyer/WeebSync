package mkvsubs

import (
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestASSTimes(t *testing.T) {
	if got := assTime(83*time.Minute + 4*time.Second + 560*time.Millisecond); got != "1:23:04.56" {
		t.Fatalf("assTime = %q", got)
	}
}

func TestASSFromBlocks(t *testing.T) {
	s := &Subtitles{Events: map[uint64][]Event{3: {
		{Start: 2 * time.Second, End: 4 * time.Second, Data: []byte("7,0,Default,,0,0,0,,Hello, world")},
	}, 4: {
		{Start: time.Second, End: 2 * time.Second, Data: []byte("<i>two</i>\nlines")},
	}}}
	ass := s.ASS(Track{Number: 3, Codec: "S_TEXT/ASS", Private: []byte("[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")})
	if !strings.Contains(ass, "Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Hello, world\n") {
		t.Fatalf("ASS track:\n%s", ass)
	}
	srt := s.ASS(Track{Number: 4, Codec: "S_TEXT/UTF8"})
	if !strings.Contains(srt, `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\i1}two{\i0}\Nlines`) {
		t.Fatalf("SRT track:\n%s", srt)
	}
}

// Against a real mkvmerge file (WS_MKV=/path/to/episode.mkv): the lines read
// through the Cues are the lines ffmpeg reads out of the whole file.
func TestReadMatchesFFmpeg(t *testing.T) {
	path := os.Getenv("WS_MKV")
	if path == "" {
		t.Skip("WS_MKV not set")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	s, err := Read(f, fi.Size(), 8)
	if err != nil {
		t.Fatal(err)
	}
	stream := 0
	for i, tr := range s.Tracks {
		if !tr.Text {
			continue
		}
		mine := dialogues(s.ASS(tr))
		out, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-map", "0:"+strconv.Itoa(i), "-c:s", "ass", "-f", "ass", "-").Output()
		if err != nil {
			t.Fatal(err)
		}
		want := dialogues(string(out))
		// the same lines; the order of lines that start together is the
		// muxer's business, libass sorts them itself
		count := map[string]int{}
		for _, l := range want {
			count[l]++
		}
		for _, l := range mine {
			count[l]--
		}
		var diff []string
		for l, n := range count {
			if n != 0 {
				diff = append(diff, fmt.Sprintf("%+d %s", n, l))
			}
		}
		if len(diff) > 0 {
			sort.Strings(diff)
			t.Fatalf("track %d: %d lines, ffmpeg %d; + only ffmpeg, - only mine:\n%s", tr.Number, len(mine), len(want), strings.Join(diff, "\n"))
		}
		stream++
	}
	if stream == 0 {
		t.Fatal("no text track")
	}
}

func TestSUPFraming(t *testing.T) {
	// two segments in one block: a PCS (0x16) and an END (0x80)
	s := &Subtitles{Events: map[uint64][]Event{5: {
		{Start: time.Second, Data: []byte{0x16, 0, 2, 0xAA, 0xBB, 0x80, 0, 0}},
	}}}
	got := s.SUP(Track{Number: 5})
	want := []byte{'P', 'G', 0, 1, 0x5F, 0x90, 0, 0, 0, 0, 0x16, 0, 2, 0xAA, 0xBB,
		'P', 'G', 0, 1, 0x5F, 0x90, 0, 0, 0, 0, 0x80, 0, 0}
	if string(got) != string(want) {
		t.Fatalf("SUP = % x", got)
	}
}

// Against a Bluray rip (WS_PGS=/path/to/file.mkv): the PGS track read through
// the Cues is the .sup ffmpeg copies out of the whole file, decode timestamps
// aside (ffmpeg writes them, players go by the presentation time).
func TestSUPMatchesFFmpeg(t *testing.T) {
	path := os.Getenv("WS_PGS")
	if path == "" {
		t.Skip("WS_PGS not set")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	s, err := Read(f, fi.Size(), 8)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for i, tr := range s.Tracks {
		if !tr.PGS {
			continue
		}
		mine := s.SUP(tr)
		want, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-map", "0:"+strconv.Itoa(i), "-c:s", "copy", "-f", "sup", "-").Output()
		if err != nil {
			t.Fatal(err)
		}
		for p := 0; p+13 <= len(want); p += 13 + (int(want[p+11])<<8 | int(want[p+12])) {
			copy(want[p+6:p+10], []byte{0, 0, 0, 0})
		}
		if string(mine) != string(want) {
			t.Fatalf("track %d: %d bytes, ffmpeg %d", tr.Number, len(mine), len(want))
		}
		n++
	}
	if n == 0 {
		t.Fatal("no PGS track")
	}
}

func dialogues(ass string) []string {
	var out []string
	for _, l := range strings.Split(ass, "\n") {
		if strings.HasPrefix(l, "Dialogue:") {
			out = append(out, strings.TrimSpace(l))
		}
	}
	return out
}
