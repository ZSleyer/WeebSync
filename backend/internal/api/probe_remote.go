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
	if dub, sub, ok = s.cachedRemoteLang(serverID, remotePath); ok {
		return dub, sub, true
	}
	key := langProbeKey(serverID, remotePath)
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
		return nil, nil, false
	}
	dub, sub = map[string]bool{}, map[string]bool{}
	// undLang for the same reason as streamsQuality, and it has to be the same
	// rule on both sides: a local copy that records a hole can only ever be
	// improved on by a remote copy that records one too, or the comparison
	// refuses every real gain instead of only the guessed ones.
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

// representativeRemote picks the one file of a remote folder that stands in for
// it when its languages are measured. "" when the crawler has seen no video
// there yet.
//
// The choice has to be DETERMINISTIC, because the loop that makes the
// measurement and the scan that reads it back must land on the same file, and
// they run minutes apart from different code. The lowest path is the first
// episode - and the cheapest thing SQLite can answer.
//
// ponytail: one file per folder, so a season whose dub arrives mid-run reads as
// the first episode's languages. Same shortcut the local side takes, and the
// upgrade path is the same: sample more of them.
func (s *Server) representativeRemote(serverID int64, folder string) string {
	rows, err := s.DB.Query(`SELECT path, name FROM remote_index
		WHERE server_id = ? AND is_dir = 0 AND (parent = ? OR parent LIKE ?||'/%')
		ORDER BY path`, serverID, folder, folder)
	if err != nil {
		return ""
	}
	defer rows.Close()
	for rows.Next() {
		var p, name string
		if rows.Scan(&p, &name) != nil {
			continue
		}
		if transfer.VideoExt[strings.ToLower(filepath.Ext(name))] {
			return p
		}
	}
	return ""
}

func langProbeKey(serverID int64, remotePath string) string {
	return fmt.Sprintf("langprobe:%d:%s", serverID, remotePath)
}

// cachedRemoteLang answers from the probe cache alone and never dials.
//
// It exists so a read path can use a measurement without paying for one: the
// quality scan and the suggestions build must not depend on a reachable host,
// and they run far too often to pull a header per folder. Whoever wants the
// measurement made asks LangProbeLoop for it and reads the answer here on the
// next pass.
func (s *Server) cachedRemoteLang(serverID int64, remotePath string) (dub, sub map[string]bool, ok bool) {
	p, hit := s.cacheGet(langProbeKey(serverID, remotePath), 720*time.Hour)
	if !hit {
		return nil, nil, false
	}
	var v struct{ Dub, Sub []string }
	if json.Unmarshal([]byte(p), &v) != nil {
		return nil, nil, false
	}
	return toSet(v.Dub), toSet(v.Sub), true
}

func toSet(xs []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}
