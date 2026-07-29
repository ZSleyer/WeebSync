package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// probeHeaderBytes is how much of a remote file to pull for ffprobe. Matroska
// (the common anime container) writes its Tracks element - which carries the
// per-track language - near the start, so a header slice is enough to read the
// audio/subtitle languages without downloading the whole file. mp4s that store
// their moov atom at the end won't parse from the header; probeRemoteLang then
// reports ok=false and the caller falls back to the filename.
const probeHeaderBytes = 12 << 20 // 12 MiB

// probeRemoteLang reads a remote video's real audio/subtitle languages by
// pulling only its header over the existing SFTP/FTP connection and running
// ffprobe on it. Results are cached (files are immutable) so the autosync loop
// never re-probes the same file. ok=false on any failure (no ffprobe, moov at
// EOF, dial error), letting the caller fall back to filename matching.
func (s *Server) probeRemoteLang(userID, serverID int64, remotePath string) (dub, sub map[string]bool, ok bool) {
	key := fmt.Sprintf("langprobe:%d:%s", serverID, remotePath)
	if p, hit := s.cacheGet(key, 720*time.Hour); hit {
		var v struct{ Dub, Sub []string }
		if json.Unmarshal([]byte(p), &v) == nil {
			return toSet(v.Dub), toSet(v.Sub), true
		}
	}
	ext := strings.ToLower(filepath.Ext(remotePath))
	if !transfer.VideoExt[ext] {
		return nil, nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client, _, err := s.dialServer(ctx, userID, serverID, pool.PriLow)
	if err != nil {
		return nil, nil, false
	}
	defer client.Close()
	rc, err := client.Open(remotePath, 0)
	if err != nil {
		return nil, nil, false
	}
	defer rc.Close()

	tmp, err := os.CreateTemp("", "wslp*"+ext)
	if err != nil {
		return nil, nil, false
	}
	defer os.Remove(tmp.Name())
	// EOF (file smaller than the header window) is fine - we still probe it
	if _, err := io.CopyN(tmp, rc, probeHeaderBytes); err != nil && err != io.EOF {
		tmp.Close()
		return nil, nil, false
	}
	tmp.Close()

	// a truncated container needs ffprobe to scan further before giving up
	streams, sok := ffprobeFile(ctx, tmp.Name(), "-analyzeduration", "20M", "-probesize", "20M")
	if !sok {
		// undLang for the same reason as streamsQuality, and it has to be the same
		// rule on both sides: a local copy that records a hole can only ever be
		// improved on by a remote copy that records one too, or the comparison
		// refuses every real gain instead of only the guessed ones.
		return nil, nil, false
	}
	dub, sub = map[string]bool{}, map[string]bool{}
	for _, st := range streams {
		switch st.CodecType {
		case "audio":
			dub[langOrUnd(st.Lang)] = true
		case "subtitle":
			sub[langOrUnd(st.Lang)] = true
		}
	}
	v := struct {
		Dub []string `json:"Dub"`
		Sub []string `json:"Sub"`
	}{keysSorted(dub), keysSorted(sub)}
	if b, err := json.Marshal(v); err == nil {
		s.cacheSet(key, string(b))
	}
	return dub, sub, true
}

func toSet(xs []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}
