package api

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// videoEncoder is how a transcode writes its picture: x264 in software, or a
// GPU's H.264 encoder. The picture is always decoded and scaled in software -
// that opens every codec ffmpeg reads (Hi10P, MPEG-4 ASP, a burned-in picture
// subtitle) - and only handed to the GPU to be encoded, the part that costs.
//
// ponytail: no hardware decoding or scaling; full GPU pipelines are the
// upgrade path where software decoding becomes the bottleneck.
type videoEncoder struct {
	name   string   // software, nvenc, vaapi
	device string   // the render node, for vaapi
	pre    []string // ahead of -i: the device
	upload string   // the end of the filter chain: pixel format, upload
	args   []string // -c:v and its rate control
	height int      // the most lines it writes
}

func softwareEncoder() videoEncoder {
	return videoEncoder{name: "software", upload: "format=yuv420p", height: 720,
		args: []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "21"}}
}

// encoderCandidates are the encoders WEEBSYNC_HWACCEL allows, best first.
// A GPU keeps up with 1080p where x264 on a small host does not.
func encoderCandidates(mode string) []videoEncoder {
	nvenc := videoEncoder{name: "nvenc", upload: "format=yuv420p", height: 1080,
		// forced keyframes become IDR frames, so every segment starts clean
		args: []string{"-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-forced-idr", "1"}}
	var vaapi []videoEncoder
	nodes, _ := filepath.Glob("/dev/dri/renderD*")
	slices.Sort(nodes)
	for _, dev := range nodes {
		vaapi = append(vaapi, videoEncoder{name: "vaapi", device: dev, height: 1080,
			pre: []string{"-vaapi_device", dev}, upload: "format=nv12,hwupload",
			args: []string{"-c:v", "h264_vaapi", "-qp", "23"}})
	}
	switch mode {
	case "nvenc":
		return []videoEncoder{nvenc}
	case "vaapi":
		return vaapi
	case "none", "software", "off", "false", "0":
		return nil
	}
	return append([]videoEncoder{nvenc}, vaapi...)
}

// encoderWorks encodes a short test picture through the same chain a
// transcode uses: a driver that is missing, a GPU without an H.264 encoder or
// a device the process may not open all fail here and not mid-episode.
func encoderWorks(e videoEncoder) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	args := append([]string{"-hide_banner", "-v", "error", "-nostdin"}, e.pre...)
	args = append(args, "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=0.5",
		"-vf", e.filter(), "-force_key_frames", "expr:gte(t,n_forced*0.25)")
	args = append(args, e.args...)
	args = append(args, "-f", "null", "-")
	return exec.CommandContext(ctx, "ffmpeg", args...).Run() == nil
}

// filter scales to the encoder's height and hands the frames over.
func (e videoEncoder) filter() string {
	return "scale=-2:'min(" + strconv.Itoa(e.height) + ",ih)'," + e.upload
}

var playEncoder = sync.OnceValue(func() videoEncoder {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("WEEBSYNC_HWACCEL")))
	for _, e := range encoderCandidates(mode) {
		if encoderWorks(e) {
			slog.Info("player transcodes on the GPU", "encoder", e.name, "device", e.device)
			return e
		}
	}
	if mode != "" && mode != "auto" && !slices.Contains([]string{"none", "software", "off", "false", "0"}, mode) {
		slog.Warn("player: the requested hardware encoder does not work here, transcoding in software", "hwaccel", mode)
	}
	return softwareEncoder()
})
