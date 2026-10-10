package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/mkvsubs"
)

// The copy mode: when the browser can show the picture but not the file as it
// is - Bluray sound, the second audio track, a container it does not open -
// the picture is passed through untouched and only repackaged, the sound
// copied or turned into AAC. On a host without a hardware encoder (a Raspberry
// Pi) that is the difference between a few percent of one core and not keeping
// up at all.
//
// A copy can only be cut where a keyframe is. The segments are therefore laid
// on the file's own keyframes, which a Matroska file indexes in its Cues: each
// segment starts on one and lasts at least hlsSegSec, so the playlist knows
// every segment's exact length before anything is cut, and a run started at
// segment n with -ss lands on exactly that keyframe.

// cutCache holds each file's segment starts; a file is immutable while watched.
var cutCache sync.Map // playSource -> []float64 (nil: no index)

// copyCuts are the segment starts (seconds) for a copy of src, or nil when it
// has no keyframe index to cut at.
func (s *Server) copyCuts(ctx context.Context, src playSource) []float64 {
	src.low = false
	if v, ok := cutCache.Load(src); ok {
		return v.([]float64)
	}
	var cuts []float64
	if strings.EqualFold(filepath.Ext(src.path), ".mkv") {
		began := time.Now()
		ra, size, done, err := s.readerAt(ctx, src)
		if err == nil {
			kf, kerr := mkvsubs.Keyframes(ra, size)
			done()
			if kerr == nil {
				cuts = cutsFrom(kf)
			}
			err = kerr
		}
		slog.Info("player copy index", "path", logSafe(src.path), "segments", len(cuts), "took", time.Since(began).Round(time.Millisecond), "err", err)
	}
	cutCache.Store(src, cuts)
	return cuts
}

// cutsFrom lays segments on the keyframes: one starts at 0, every next one on
// the first keyframe at least hlsSegSec after the last start.
func cutsFrom(kf []time.Duration) []float64 {
	cuts := []float64{0}
	for _, k := range kf {
		if t := k.Seconds(); t-cuts[len(cuts)-1] >= hlsSegSec {
			cuts = append(cuts, t)
		}
	}
	return cuts
}

// copyPlaylist lists the copy's segments with their exact lengths.
func copyPlaylist(cuts []float64, duration float64, q url.Values) string {
	var b strings.Builder
	longest := 0.0
	for i, c := range cuts {
		if d := segEnd(cuts, i, duration) - c; d > longest {
			longest = d
		}
	}
	fmt.Fprintf(&b, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n", int(longest)+1)
	for i, c := range cuts {
		q.Set("n", strconv.Itoa(i))
		fmt.Fprintf(&b, "#EXTINF:%.3f,\nseg.ts?%s\n", segEnd(cuts, i, duration)-c, q.Encode())
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return b.String()
}

func segEnd(cuts []float64, i int, duration float64) float64 {
	if i+1 < len(cuts) {
		return cuts[i+1]
	}
	return duration
}

// copyArgs is the output side of a copy run starting at segment n: the
// picture as it is, the sound copied or as stereo AAC, cut by the segment
// muxer at the next segments' starts (relative to this run's), timestamps
// offset to where the run starts.
func copyArgs(k hlsKey, cuts []float64, n int, dir string) []string {
	args := []string{"-map", "0:v:0"}
	if k.audio >= 0 {
		args = append(args, "-map", "0:"+strconv.Itoa(k.audio))
	} else {
		args = append(args, "-map", "0:a:0?")
	}
	args = append(args, "-c:v", "copy")
	if k.acopy {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-ac", "2", "-b:a", "192k")
	}
	var times []string
	for _, c := range cuts[n+1:] {
		times = append(times, strconv.FormatFloat(c-cuts[n], 'f', 3, 64))
	}
	args = append(args, "-f", "segment", "-segment_format", "mpegts")
	if len(times) > 0 {
		args = append(args, "-segment_times", strings.Join(times, ","))
	}
	return append(args,
		"-segment_start_number", strconv.Itoa(n),
		"-segment_list", filepath.Join(dir, "list.csv"), "-segment_list_type", "csv",
		"-reset_timestamps", "0", "-output_ts_offset", strconv.FormatFloat(cuts[n], 'f', 3, 64),
		"-muxdelay", "0", "-muxpreload", "0", filepath.Join(dir, "%d.ts"))
}
