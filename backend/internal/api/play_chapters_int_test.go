package api

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// chapterFixture makes a 12 s MKV; a non-empty meta (FFMETADATA) adds the
// chapter marks.
func chapterFixture(t *testing.T, dir, name, meta string) {
	t.Helper()
	args := []string{"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=12:s=64x64:r=10",
		"-f", "lavfi", "-i", "sine=d=12"}
	if meta != "" {
		mp := filepath.Join(t.TempDir(), "meta.txt")
		if err := os.WriteFile(mp, []byte(meta), 0o644); err != nil {
			t.Fatal(err)
		}
		args = append(args, "-i", mp, "-map_metadata", "2", "-map_chapters", "2")
	}
	args = append(args, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast",
		"-c:a", "aac", "-shortest", filepath.Join(dir, name))
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("make %s: %v %s", name, err, out)
	}
}

// The real ffprobe output has to parse through playInfo: this settles that
// start_time and end_time come out in a form playChapters can read.
func TestPlayInfoChapters(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not installed")
		}
	}
	root := t.TempDir()
	meta := ";FFMETADATA1\n"
	for _, c := range []struct {
		s, e  int
		title string
	}{{0, 2000, "Prologue"}, {2000, 4500, "OP"}, {4500, 9000, "Part A"}, {9000, 12000, "Ending Credits"}} {
		meta += "[CHAPTER]\nTIMEBASE=1/1000\nSTART=" + strconv.Itoa(c.s) + "\nEND=" + strconv.Itoa(c.e) + "\ntitle=" + c.title + "\n"
	}
	chapterFixture(t, root, "chap.mkv", meta)
	chapterFixture(t, root, "plain.mkv", "")

	s := testServer(t, &Server{DownloadRoot: root, LocalRoots: []string{root}})
	ctx := context.Background()

	info, err := s.playInfo(ctx, playSource{path: "/chap.mkv"})
	if err != nil {
		t.Fatal(err)
	}
	want := []PlayChapter{
		{Start: 0, End: 2, Title: "Prologue"},
		{Start: 2, End: 4.5, Title: "OP", Kind: "op"},
		{Start: 4.5, End: 9, Title: "Part A"},
		{Start: 9, End: 12, Title: "Ending Credits", Kind: "ed"},
	}
	if len(info.Chapters) != len(want) {
		t.Fatalf("got %d chapters, want %d: %+v", len(info.Chapters), len(want), info.Chapters)
	}
	for i, w := range want {
		g := info.Chapters[i]
		if math.Abs(g.Start-w.Start) > 0.01 || math.Abs(g.End-w.End) > 0.01 || g.Title != w.Title || g.Kind != w.Kind {
			t.Errorf("chapter %d = %+v, want %+v", i, g, w)
		}
	}

	plain, err := s.playInfo(ctx, playSource{path: "/plain.mkv"})
	if err != nil {
		t.Fatal(err)
	}
	if plain.Chapters == nil || len(plain.Chapters) != 0 {
		t.Fatalf("chapterless file: want empty non-nil slice, got %#v", plain.Chapters)
	}
	b, err := json.Marshal(plain)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"chapters":[]`) {
		t.Errorf("json lacks an empty chapters array: %s", b)
	}
}
