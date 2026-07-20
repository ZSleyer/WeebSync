// Package airmap resolves a series' aired-order season boundaries: it maps an
// absolute episode number to its (season, episode) in broadcast order, which
// can't be computed arithmetically for endless shows. The mapping is built
// once per TTL from the first available source - TVDB (native absoluteNumber),
// then Plex (positional over allLeaves), then TMDB (season episode counts) -
// and cached in season_maps. Used to name and file such episodes correctly
// (e.g. Detective Conan absolute 1187 -> Season 34 / S34E01).
package airmap

import (
	"context"
	"database/sql"
	"log/slog"
	"strconv"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// Series identifies a watched show and carries its rename profile. The profile
// fields (Provider/Ordering/TitleLang) are normally derived by the caller from
// Plex's per-show settings; empty fields fall back to sensible defaults here.
type Series struct {
	ServerID int64
	Folder   string // cache key together with ServerID
	Title    string // for TVDB/Plex lookup when no id is known
	TVDBID   int    // series id (e.g. from a Plex guid); 0 = search by title
	TMDBTVID int    // tv id; 0 = unknown

	Provider  string // tvdb | tmdb | "" (auto: tvdb if keyed, else tmdb)
	Ordering  string // official | dvd | absolute | aired | "" (default per provider)
	TitleLang string // BCP-47 for the localized series title; "" = provider default
}

// effective resolves the profile's provider and ordering, applying defaults:
// no provider → TVDB when keyed, else TMDB; no ordering → each provider's aired
// order. Provider is "" only when no keyed provider exists.
func (r *Resolver) effective(s Series) (provider, ordering string) {
	provider = s.Provider
	if provider == "" {
		if r.TVDB != nil && r.TVDB.Enabled() {
			provider = "tvdb"
		} else if r.TMDB != nil && r.TMDB.Enabled() {
			provider = "tmdb"
		}
	}
	ordering = s.Ordering
	if ordering == "" {
		if provider == "tmdb" {
			ordering = "aired"
		} else {
			ordering = "official"
		}
	}
	return provider, ordering
}

// sourceTag is the cache identity of a (provider, ordering, series-id) triple,
// so a changed ordering OR a changed resolved series id (e.g. matching improved
// from a spinoff to the main series) invalidates the cached map.
func sourceTag(provider, ordering string, id int) string {
	if provider == "" {
		return "none"
	}
	return provider + ":" + ordering + ":" + strconv.Itoa(id)
}

// seriesID returns the id used for the given provider.
func (s Series) seriesID(provider string) int {
	if provider == "tmdb" {
		return s.TMDBTVID
	}
	return s.TVDBID
}

// Resolver builds and caches aired-order maps. Plex may be nil.
type Resolver struct {
	DB   *sql.DB
	TVDB *tvdb.Client
	Plex *plex.Client
	TMDB *tmdb.Client
}

// Resolve returns the (season, episode) for an episode token, or ok=false when
// no mapping is known - the caller then falls back to its normal naming. The
// token is the parsed episode number: "1187" for a regular episode, or a
// fractional "1165.5" for a special/recap, which resolves to a season-0 entry.
// The per-series map is (re)built at most once per TTL.
func (r *Resolver) Resolve(ctx context.Context, s Series, token string) (season, episode int, ok bool) {
	if token == "" {
		return 0, 0, false
	}
	provider, ordering := r.effective(s)
	want := sourceTag(provider, ordering, s.seriesID(provider))
	if !r.fresh(s, want) {
		r.rebuild(ctx, s, provider, ordering, want)
	}
	err := r.DB.QueryRow(`SELECT season, episode FROM season_maps WHERE server_id=? AND folder=? AND token=?`,
		s.ServerID, s.Folder, token).Scan(&season, &episode)
	if err != nil {
		return 0, 0, false
	}
	return season, episode, true
}

// ttl is the season-map cache lifetime (setting ttl_tvdb_h, default 24h).
func (r *Resolver) ttl() time.Duration {
	if h, _ := strconv.Atoi(db.Setting(r.DB, "ttl_tvdb_h")); h > 0 {
		return time.Duration(h) * time.Hour
	}
	return 24 * time.Hour
}

// fresh reports whether the cached map for this series is within the TTL and
// was built for the wanted provider+ordering (a changed ordering forces a
// rebuild).
func (r *Resolver) fresh(s Series, want string) bool {
	var updated, source string
	err := r.DB.QueryRow(`SELECT updated_at, source FROM season_maps_meta WHERE server_id=? AND folder=?`,
		s.ServerID, s.Folder).Scan(&updated, &source)
	if err != nil || source != want {
		return false
	}
	t, err := time.Parse("2006-01-02 15:04:05", updated)
	return err == nil && time.Since(t) < r.ttl()
}

// rebuild refreshes the cached map for the given provider+ordering. On a
// transient source error it leaves the cache untouched (so the next file
// retries); on a definitive empty result it stamps the meta row with the
// wanted source, backing off API calls for one TTL.
func (r *Resolver) rebuild(ctx context.Context, s Series, provider, ordering, want string) {
	m, err := r.buildMap(ctx, s, provider, ordering)
	if err != nil {
		// quote the user-controlled folder: escapes CR/LF so it can't forge log lines
		slog.Warn("airmap rebuild", "folder", strconv.Quote(s.Folder), "err", err)
		return
	}
	source := want
	if len(m) == 0 {
		source = "none"
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	tx.Exec(`DELETE FROM season_maps WHERE server_id=? AND folder=?`, s.ServerID, s.Folder)
	for token, se := range m {
		if _, err := tx.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (?,?,?,?,?)`,
			s.ServerID, s.Folder, token, se[0], se[1]); err != nil {
			return
		}
	}
	tx.Exec(`INSERT INTO season_maps_meta (server_id, folder, source, updated_at) VALUES (?,?,?,datetime('now'))
		ON CONFLICT(server_id, folder) DO UPDATE SET source=excluded.source, updated_at=excluded.updated_at`,
		s.ServerID, s.Folder, source)
	tx.Commit()
}

// buildMap resolves the mapping from the chosen provider in the chosen order,
// never from Plex's own episode arrangement: a mis-synced library (the very
// problem this feature fixes) has drifted numbers, so trusting them would
// reproduce the error. Plex is only used to heal the series id from the matched
// show's guid. A nil error with an empty map means "no mapping" (back off); a
// non-nil error is transient (don't cache).
func (r *Resolver) buildMap(ctx context.Context, s Series, provider, ordering string) (map[string][2]int, error) {
	tvdbID, tmdbID := s.TVDBID, s.TMDBTVID
	if r.Plex != nil && ((provider == "tvdb" && tvdbID == 0) || (provider == "tmdb" && tmdbID == 0)) {
		pt, pm := r.plexIDs(s.Title)
		if tvdbID == 0 {
			tvdbID = pt
		}
		if tmdbID == 0 {
			tmdbID = pm
		}
	}
	switch provider {
	case "tvdb":
		if r.TVDB == nil || !r.TVDB.Enabled() {
			return nil, nil
		}
		id := tvdbID
		if id == 0 { // last resort: ambiguous title search
			if res, err := r.TVDB.Search(ctx, s.Title); err == nil && len(res) > 0 {
				id = tvdb.ParseID(res[0].TVDBID)
			}
		}
		if id == 0 {
			return nil, nil
		}
		eps, err := r.TVDB.Episodes(ctx, id, ordering) // official | dvd | absolute
		if err != nil {
			return nil, err
		}
		return tvdb.SeasonTokenMap(eps), nil // regular tokens + ".5" specials
	case "tmdb":
		if r.TMDB == nil || !r.TMDB.Enabled() || tmdbID == 0 {
			return nil, nil
		}
		// TMDB has no special ordering: absolute-number tokens only
		abs, err := r.TMDB.SeasonMap(ctx, tmdbID)
		if err != nil {
			return nil, err
		}
		m := make(map[string][2]int, len(abs))
		for n, se := range abs {
			m[strconv.Itoa(n)] = se
		}
		return m, nil
	}
	return nil, nil
}

// SeriesTitle returns the localized series title from the chosen provider (in
// s.TitleLang), for use as the rename title. "" when unavailable.
func (r *Resolver) SeriesTitle(ctx context.Context, s Series) string {
	provider, _ := r.effective(s)
	tvdbID, tmdbID := s.TVDBID, s.TMDBTVID
	if r.Plex != nil && ((provider == "tvdb" && tvdbID == 0) || (provider == "tmdb" && tmdbID == 0)) {
		pt, pm := r.plexIDs(s.Title)
		if tvdbID == 0 {
			tvdbID = pt
		}
		if tmdbID == 0 {
			tmdbID = pm
		}
	}
	switch provider {
	case "tvdb":
		if r.TVDB == nil || !r.TVDB.Enabled() {
			return ""
		}
		id := tvdbID
		if id == 0 {
			if res, err := r.TVDB.Search(ctx, s.Title); err == nil && len(res) > 0 {
				id = tvdb.ParseID(res[0].TVDBID)
			}
		}
		if id > 0 {
			if n, _ := r.TVDB.SeriesTitle(ctx, id, s.TitleLang); n != "" {
				return n
			}
		}
	case "tmdb":
		if r.TMDB != nil && r.TMDB.Enabled() && tmdbID > 0 {
			if n, _ := r.TMDB.SeriesTitle(ctx, tmdbID, s.TitleLang); n != "" {
				return n
			}
		}
	}
	return ""
}

// plexIDs finds the matched show by normalized title and returns its
// authoritative (tvdb, tmdb) series ids from the show guid, 0 when unknown.
// Runs at most once per TTL, so the full section listing plus one ShowDetail
// is affordable.
// ponytail: linear title scan; a title->ratingKey index if it ever gets slow.
func (r *Resolver) plexIDs(title string) (tvdbID, tmdbID int) {
	secs, err := r.Plex.Sections()
	if err != nil {
		return 0, 0
	}
	want := match.Normalize(title)
	for _, sec := range secs {
		if sec.Type != "show" {
			continue
		}
		shows, err := r.Plex.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			if match.Normalize(sh.Title) == want || (sh.OriginalTitle != "" && match.Normalize(sh.OriginalTitle) == want) {
				// the bulk listing rarely carries the guid array; fetch the
				// show's detail for the authoritative ids
				if d, err := r.Plex.ShowDetail(sh.RatingKey); err == nil {
					return d.TVDBID, d.TMDBID
				}
			}
		}
	}
	return 0, 0
}
