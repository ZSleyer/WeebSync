package mkvsubs

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// The keyframes in the Cues are every keyframe of the video (WS_MKV): a stream
// copy cut at them lands where the picture really starts.
func TestKeyframesMatchFFprobe(t *testing.T) {
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
	kf, err := Keyframes(f, fi.Size())
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
		"-show_entries", "frame=pts_time", "-of", "csv=p=0", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	var want []float64
	for _, l := range strings.Fields(string(out)) {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(l, ","), 64)
		want = append(want, v)
	}
	if len(kf) != len(want) {
		t.Fatalf("%d keyframes in the cues, ffprobe sees %d", len(kf), len(want))
	}
	for i := range want {
		if d := kf[i].Seconds() - want[i]; d > 0.002 || d < -0.002 {
			t.Fatalf("keyframe %d: cues %.3f, ffprobe %.3f", i, kf[i].Seconds(), want[i])
		}
	}
}
