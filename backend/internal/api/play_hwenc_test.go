package api

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestHLSArgsFollowTheEncoder(t *testing.T) {
	k := hlsKey{audio: -1, burn: -1}
	sw := strings.Join(hlsArgs(k, softwareEncoder(), 0, "/tmp/x"), " ")
	if !strings.Contains(sw, "min(720,ih)") || !strings.Contains(sw, "libx264") {
		t.Fatalf("software args: %s", sw)
	}
	va := encoderCandidates("vaapi")
	if len(va) == 0 {
		va = []videoEncoder{{name: "vaapi", height: 1080, upload: "format=nv12,hwupload",
			args: []string{"-c:v", "h264_vaapi", "-qp", "23"}}}
	}
	k.burn = 3
	hw := strings.Join(hlsArgs(k, va[0], 2, "/tmp/x"), " ")
	if !strings.Contains(hw, "overlay=eof_action=pass,scale=-2:'min(1080,ih)',format=nv12,hwupload[v]") ||
		!strings.Contains(hw, "h264_vaapi") || strings.Contains(hw, "libx264") {
		t.Fatalf("vaapi args: %s", hw)
	}
	if encoderCandidates("none") != nil || !slices.ContainsFunc(encoderCandidates("auto"), func(e videoEncoder) bool { return e.name == "nvenc" }) {
		t.Fatal("WEEBSYNC_HWACCEL modes")
	}
}

func TestSoftwareEncoderChainRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	if !encoderWorks(softwareEncoder()) {
		t.Fatal("the software chain failed its own test encode")
	}
}
