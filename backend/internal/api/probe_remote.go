package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// probeHeaderBytes is how much of a remote file to pull for ffprobe. Matroska
// (the common anime container) writes its Tracks element - which carries the
// per-track language - near the start, so a header slice is enough to read the
// audio/subtitle languages without downloading the whole file.
//
// The window is small on purpose: it is paid per candidate folder, and a
// catalogue has hundreds of them.
const probeHeaderBytes = 12 << 20 // 12 MiB

// probeHeaderRetryBytes is the second, larger attempt for a file whose header
// did not parse at the first size.
//
// An anime release commonly embeds its subtitle fonts as attachments, and
// ffprobe reads past them before it will report anything: one measured file
// carries 41 of them and needs 13 MiB, which is just past the first window.
// Growing only for the files that need it keeps the common case cheap - the
// alternative, a flat larger window, costs every folder in the catalogue three
// times the transfer to rescue a sixth of them.
const probeHeaderRetryBytes = 48 << 20 // 48 MiB

// probeRemoteLang reads a remote video's real audio/subtitle languages by
// pulling only its header over the existing SFTP/FTP connection and running
// ffprobe on it. Results are cached (files are immutable) so the autosync loop
// never re-probes the same file. ok=false on any failure (no ffprobe, moov at
// EOF, dial error), letting the caller fall back to filename matching.
func (s *Server) probeRemoteLang(userID, serverID int64, remotePath string) (dub, sub map[string]bool, ok bool) {
	if dub, sub, ok = s.cachedRemoteLang(serverID, remotePath); ok {
		return dub, sub, true
	}
	ext := strings.ToLower(filepath.Ext(remotePath))
	if !transfer.VideoExt[ext] {
		return nil, nil, false
	}

	// generous enough for the larger of the two windows on a slow host; the
	// pool already runs this at the lowest priority
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	client, _, err := s.dialServer(ctx, userID, serverID, pool.PriLow)
	if err != nil {
		slog.Warn("remote language probe", "server", serverID, "path", logSafe(remotePath),
			"reason", "the server could not be reached", "err", err)
		return nil, nil, false
	}
	defer client.Close()

	// Try the small window first and grow once. A file whose head simply does
	// not describe it - an mp4 with its moov atom at the end - fails both, and
	// that is the answer: its languages cannot be read without the whole file.
	for _, window := range []int64{probeHeaderBytes, probeHeaderRetryBytes} {
		streams, reason := probeRemoteHead(ctx, client, remotePath, ext, window)
		if reason != "" {
			slog.Warn("remote language probe", "server", serverID, "path", logSafe(remotePath),
				"headerMiB", window>>20, "reason", reason)
			if reason == readFailed {
				return nil, nil, false // reading it again will not go better
			}
			continue
		}
		dub, sub = map[string]bool{}, map[string]bool{}
		// undLang for the same reason as streamsQuality, and it has to be the
		// same rule on both sides: a local copy that records a hole can only
		// ever be improved on by a remote copy that records one too, or the
		// comparison refuses every real gain instead of only the guessed ones.
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
			s.cacheSet(langProbeKey(serverID, remotePath), string(b))
		}
		return dub, sub, true
	}
	return nil, nil, false
}

// the two ways probeRemoteHead can come back empty, kept apart because only one
// of them is worth a second, larger attempt
const (
	readFailed  = "the file could not be read from the server"
	parseFailed = "ffprobe found no streams in the header"
)

// probeRemoteHead pulls the first window bytes of a remote file and reads its
// streams. reason is "" on success.
func probeRemoteHead(ctx context.Context, client remote.Client, remotePath, ext string, window int64) ([]probeStream, string) {
	rc, err := client.Open(remotePath, 0)
	if err != nil {
		return nil, readFailed
	}
	defer rc.Close()
	tmp, err := os.CreateTemp("", "wslp*"+ext)
	if err != nil {
		return nil, readFailed
	}
	defer os.Remove(tmp.Name())
	// EOF (file smaller than the window) is fine - we still probe what came
	if _, err := io.CopyN(tmp, rc, window); err != nil && err != io.EOF {
		tmp.Close()
		return nil, readFailed
	}
	tmp.Close()

	// a truncated container needs ffprobe to scan further before giving up
	streams, ok := ffprobeFile(ctx, tmp.Name(), "-analyzeduration", "20M", "-probesize", "20M")
	if !ok || len(streams) == 0 {
		return nil, parseFailed
	}
	return streams, ""
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
