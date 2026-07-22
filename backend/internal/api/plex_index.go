package api

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/plex"
)

// indexPlexLibrary records the quality of the user's LOCAL copies (the Plex
// library) as server-0 catalog variants, so upgrade suggestions can compare
// what you already own against a better REMOTE source instead of comparing two
// remote copies. For each Plex show that maps to a known series it reads the
// local quality - by ffprobe when the Plex file path is a shared local mount
// (the accurate case), else falling back to Plex's own resolution/languages -
// and writes a server-0 catalog_match + variant bound to the series.
//
// Runs from the sweep, gated to once an hour (Plex-API heavy).
func (s *Server) indexPlexLibrary() {
	c := s.plexClient()
	if c == nil {
		return
	}
	bySrc, _ := s.seriesProviderMaps()
	sections, err := c.Sections()
	if err != nil {
		return
	}
	for _, sec := range sections {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			// bind to a series via one of Plex's authoritative ids
			source, mediaID := "", 0
			switch {
			case sh.TVDBID != 0 && bySrc["tvdb|"+strconv.Itoa(sh.TVDBID)] != 0:
				source, mediaID = "tvdb", sh.TVDBID
			case sh.TMDBID != 0 && bySrc["tmdb:tv|"+strconv.Itoa(sh.TMDBID)] != 0:
				source, mediaID = "tmdb:tv", sh.TMDBID
			case sh.IMDBID != 0 && bySrc["imdb|"+strconv.Itoa(sh.IMDBID)] != 0:
				source, mediaID = "imdb", sh.IMDBID
			}
			if source == "" {
				continue // this Plex show is not one of our matched series
			}
			sm, err := c.ShowMedia(sh.RatingKey)
			if err != nil {
				continue
			}
			q, folder := s.plexLocalQuality(sm, sh.RatingKey)
			s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (0, ?, ?, 0, ?)`,
				folder, mediaID, source)
			s.DB.Exec(`INSERT OR REPLACE INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, computed_at) VALUES (0, ?, ?, ?, ?, ?)`,
				folder, q.ResRank, strings.Join(q.Dub, ","), strings.Join(q.Sub, ","), time.Now().UTC().Format(time.RFC3339))
		}
	}
	db.SetSetting(s.DB, "plex_indexed_at", time.Now().UTC().Format(time.RFC3339))
}

// plexLocalQuality resolves a Plex show's local quality and the folder key to
// store it under. When the Plex episode path is a shared local mount that
// actually exists, ffprobe reads the true tracks; otherwise Plex's own
// resolution/languages are used. The folder is the real local directory when
// available (nicer in the UI), else a stable "plex:{ratingKey}" key.
func (s *Server) plexLocalQuality(sm plex.ShowMedia, ratingKey string) (FolderQuality, string) {
	folder := "plex:" + ratingKey
	// the Plex path is a shared mount only if it sits under a configured local
	// root and the file is actually there
	if sm.File != "" && underLocalRoot(s.LocalRoots, sm.File) {
		if _, err := os.Stat(sm.File); err == nil {
			folder = filepath.Dir(sm.File)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if streams, ok := ffprobeFile(ctx, sm.File); ok {
				return streamsQuality(streams), folder
			}
		}
	}
	// fallback: Plex's own metadata
	q := FolderQuality{ResRank: sm.ResHeight}
	dub, sub := map[string]bool{}, map[string]bool{}
	for _, l := range sm.Dub {
		if c := langCode(l); c != "" {
			dub[c] = true
		}
	}
	for _, l := range sm.Sub {
		if c := langCode(l); c != "" {
			sub[c] = true
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q, folder
}

// underLocalRoot reports whether p sits under one of the configured local roots.
func underLocalRoot(roots []string, p string) bool {
	for _, r := range roots {
		if p == r || strings.HasPrefix(p, strings.TrimRight(r, "/")+"/") {
			return true
		}
	}
	return false
}

// streamsQuality aggregates ffprobe streams into a FolderQuality.
func streamsQuality(streams []probeStream) FolderQuality {
	q := FolderQuality{}
	dub, sub := map[string]bool{}, map[string]bool{}
	for _, st := range streams {
		switch st.CodecType {
		case "video":
			if st.Height > q.ResRank {
				q.ResRank = st.Height
			}
		case "audio":
			if c := langCode(st.Lang); c != "" {
				dub[c] = true
			}
		case "subtitle":
			if c := langCode(st.Lang); c != "" {
				sub[c] = true
			}
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q
}
