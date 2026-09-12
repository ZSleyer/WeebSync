package api

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/crunchyroll"
)

// how long the season a title maps to on Crunchyroll is trusted before it is
// looked up again
const crSeasonTTL = 7 * 24 * time.Hour

// recordDubAirings writes down when Crunchyroll released the episodes of a
// watched title in the dub its watch filters for. Only releases: Crunchyroll
// creates a language version the moment it goes live and not before, so there
// is no schedule to read; the calendar projects what is still to come from
// these (dubSlots). A title AniList does not link to a Crunchyroll series id
// is left to the lag its watch was given.
//
// Runs from the sweep once an hour. Two requests per title (its season's
// episodes, then the versions not yet recorded) - cheap enough that nothing
// here is cached beyond the season lookup.
func (s *Server) recordDubAirings(ctx context.Context) {
	if s.Crunchyroll == nil {
		return
	}
	rows, err := s.DB.Query(`SELECT DISTINCT cm.media_id, w.want_dub
		FROM watches w JOIN catalog_matches cm ON cm.server_id = w.server_id AND cm.folder = w.remote_path
		WHERE cm.source = 'anilist' AND cm.media_id != 0 AND w.want_dub != ''`)
	if err != nil {
		return
	}
	type want struct {
		id   int
		lang string
	}
	seen := map[want]bool{}
	var wants []want
	for rows.Next() {
		var id int
		var code string
		if rows.Scan(&id, &code) != nil {
			continue
		}
		w := want{id, dubLang(code)}
		if w.lang == "" || seen[w] {
			continue
		}
		seen[w] = true
		wants = append(wants, w)
	}
	rows.Close()
	n := 0
	for _, w := range wants {
		if ctx.Err() != nil {
			return
		}
		m, _ := s.Anilist.CachedMedia(w.id)
		if m == nil || m.CrunchyrollID() == "" {
			continue
		}
		locale := crunchyroll.Locale(w.lang)
		if locale == "" {
			continue
		}
		eps, err := s.crSeasonEpisodes(ctx, w.id, m)
		if err != nil {
			slog.Debug("dub airings: crunchyroll unavailable", "media", w.id, "err", err)
			continue
		}
		// the versions in the wanted language not written down yet
		have := map[int]bool{}
		hr, err := s.DB.Query(`SELECT episode FROM airings WHERE source = 'anilist' AND media_id = ? AND lang = ?`, w.id, w.lang)
		if err == nil {
			for hr.Next() {
				var ep int
				if hr.Scan(&ep) == nil {
					have[ep] = true
				}
			}
			hr.Close()
		}
		var ids []string
		byGUID := map[string]int{}
		for _, e := range eps {
			if have[e.Number] {
				continue
			}
			for _, v := range e.Versions {
				if v.AudioLocale == locale {
					ids = append(ids, v.GUID)
					byGUID[v.GUID] = e.Number
				}
			}
		}
		if len(ids) == 0 {
			continue
		}
		objs, err := s.Crunchyroll.Objects(ctx, ids)
		if err != nil {
			slog.Debug("dub airings: crunchyroll unavailable", "media", w.id, "err", err)
			continue
		}
		for _, o := range objs {
			at, ep := crunchyroll.At(o.PremiumAt), o.Number
			if ep == 0 {
				ep = byGUID[o.ID]
			}
			// a version exists only once released; a date ahead would be a
			// placeholder or a change of policy, either way not a release
			if at == 0 || ep == 0 || at > time.Now().Add(24*time.Hour).Unix() {
				continue
			}
			res, err := s.DB.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', ?, ?, ?, ?)
				ON CONFLICT(source, media_id, episode, lang) DO UPDATE SET airing_at = excluded.airing_at
				WHERE airing_at != excluded.airing_at`, w.id, at, ep, w.lang)
			if err != nil {
				continue
			}
			if c, _ := res.RowsAffected(); c > 0 {
				n++
			}
		}
	}
	if n > 0 {
		slog.Info("dub airings recorded", "new", n, "titles", len(wants))
	}
}

// crSeasonEpisodes lists the episodes of the Crunchyroll season that is the
// AniList title: AniList has one id per season, Crunchyroll one series with
// many. The season whose first episode aired the day AniList says the title
// started is the one; failing that the newest original season, which is
// right for whatever is releasing now. The choice is kept for a week.
//
// ponytail: a date match. A split cour AniList counts as its own season while
// Crunchyroll runs it on as one would pick the wrong half; the anime_ids
// bridge (TVDB season) is the upgrade path if that shows up.
func (s *Server) crSeasonEpisodes(ctx context.Context, mediaID int, m *anilist.Media) ([]crunchyroll.Episode, error) {
	key := fmt.Sprintf("cr:season:%d", mediaID)
	if id, ok := s.cacheGet(key, crSeasonTTL); ok {
		return s.Crunchyroll.Episodes(ctx, id)
	}
	seasons, err := s.Crunchyroll.Seasons(ctx, m.CrunchyrollID())
	if err != nil {
		return nil, err
	}
	start := fuzzyDay(m.StartDate)
	var best string
	var bestEps []crunchyroll.Episode
	for i := len(seasons) - 1; i >= 0; i-- { // newest first
		se := seasons[i]
		if !strings.HasPrefix(se.AudioLocale, "ja") {
			continue
		}
		eps, err := s.Crunchyroll.Episodes(ctx, se.ID)
		if err != nil {
			return nil, err
		}
		if best == "" {
			best, bestEps = se.ID, eps
		}
		if start.IsZero() {
			break
		}
		for _, e := range eps {
			if e.Number == 1 {
				if d := time.Unix(crunchyroll.At(e.AirDate), 0).Sub(start); d > -3*24*time.Hour && d < 3*24*time.Hour {
					best, bestEps = se.ID, eps
					s.cacheSet(key, best)
					return bestEps, nil
				}
				break
			}
		}
	}
	if best == "" {
		return nil, fmt.Errorf("no original season")
	}
	s.cacheSet(key, best)
	return bestEps, nil
}

// fuzzyDay is the UTC midnight of an AniList date, zero when unknown.
func fuzzyDay(d anilist.FuzzyDate) time.Time {
	y, mo, da := int(d)/10000, int(d)/100%100, int(d)%100
	if y == 0 || mo == 0 || da == 0 {
		return time.Time{}
	}
	return time.Date(y, time.Month(mo), da, 0, 0, 0, 0, time.UTC)
}
