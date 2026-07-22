package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
)

// fribbURL is the upstream anime-lists dataset that maps an AniList id to the
// TVDB/TMDB/IMDB ids and the season number it corresponds to. ~7.5 MB JSON.
const fribbURL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json"

// fribbEntry is one dataset row, decoded loosely because the shape varies:
// themoviedb_id is {"tv": N} for series but {"movie": [N, ...]} for films,
// imdb_id is a list, season is {"tvdb": N, "tmdb": N} (either key may be absent).
type fribbEntry struct {
	AnilistID int             `json:"anilist_id"`
	TVDBID    int             `json:"tvdb_id"`
	TMDB      json.RawMessage `json:"themoviedb_id"`
	IMDB      json.RawMessage `json:"imdb_id"`
	Season    struct {
		TVDB int `json:"tvdb"`
		TMDB int `json:"tmdb"`
	} `json:"season"`
}

// animeID is the resolved cross-provider identity of one AniList id.
type animeID struct {
	tvdbID     int
	tvdbSeason int
	tmdbID     int
	tmdbKind   string // tv | movie
	tmdbSeason int
	imdbID     string
}

// refreshAnimeIDs downloads the Fribb mapping and upserts it into anime_ids.
// Gated to once a day by the caller (setting anime_ids_at). Best-effort: a fetch
// or parse error just leaves the previous rows in place.
func (s *Server) refreshAnimeIDs() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fribbURL, nil)
	if err != nil {
		return
	}
	resp, err := netguard.Client(60 * time.Second).Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20)) // 32 MiB cap
	if err != nil {
		return
	}
	var entries []fribbEntry
	if json.Unmarshal(body, &entries) != nil {
		return
	}

	tx, err := s.DB.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO anime_ids
		(anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season, imdb_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return
	}
	defer stmt.Close()
	n := 0
	for _, e := range entries {
		if e.AnilistID == 0 {
			continue
		}
		id := parseFribb(e)
		if id.tvdbID == 0 && id.tmdbID == 0 && id.imdbID == "" {
			continue // no usable cross-provider id
		}
		if _, err := stmt.Exec(e.AnilistID, id.tvdbID, id.tvdbSeason,
			id.tmdbID, id.tmdbKind, id.tmdbSeason, id.imdbID); err == nil {
			n++
		}
	}
	if n == 0 {
		return
	}
	tx.Commit()
	db.SetSetting(s.DB, "anime_ids_at", time.Now().UTC().Format(time.RFC3339))
}

// parseFribb resolves one dataset row's variable-shaped id fields.
func parseFribb(e fribbEntry) animeID {
	id := animeID{tvdbID: e.TVDBID, tvdbSeason: e.Season.TVDB, tmdbSeason: e.Season.TMDB}
	// themoviedb_id: {"tv": N} or {"movie": [N, ...]}
	if len(e.TMDB) > 0 {
		var m map[string]json.RawMessage
		if json.Unmarshal(e.TMDB, &m) == nil {
			if raw, ok := m["tv"]; ok {
				id.tmdbID, id.tmdbKind = firstInt(raw), "tv"
			} else if raw, ok := m["movie"]; ok {
				id.tmdbID, id.tmdbKind = firstInt(raw), "movie"
			}
		}
	}
	// imdb_id: ["tt...", ...]; take the first
	if len(e.IMDB) > 0 {
		var list []string
		if json.Unmarshal(e.IMDB, &list) == nil && len(list) > 0 {
			id.imdbID = strings.TrimSpace(list[0])
		}
	}
	return id
}

// firstInt reads an int from a JSON value that is either a scalar (26209) or a
// list ([128, ...]); returns 0 when neither.
func firstInt(raw json.RawMessage) int {
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var list []int
	if json.Unmarshal(raw, &list) == nil && len(list) > 0 {
		return list[0]
	}
	return 0
}

// animeIDs looks up the cross-provider identity of an AniList id from the cached
// Fribb mapping. ok=false when the id is not in the dataset.
func (s *Server) animeIDs(anilistID int) (animeID, bool) {
	var a animeID
	err := s.DB.QueryRow(`SELECT tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season, imdb_id
		FROM anime_ids WHERE anilist_id = ?`, anilistID).
		Scan(&a.tvdbID, &a.tvdbSeason, &a.tmdbID, &a.tmdbKind, &a.tmdbSeason, &a.imdbID)
	if err != nil {
		return animeID{}, false
	}
	return a, true
}
