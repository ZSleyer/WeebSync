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

func dialogues(ass string) []string {
	var out []string
	for _, l := range strings.Split(ass, "\n") {
		if strings.HasPrefix(l, "Dialogue:") {
			out = append(out, strings.TrimSpace(l))
		}
	}
	return out
}
