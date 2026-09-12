package api

import (
	"log/slog"
	"sort"
	"strings"
	"time"
)

const (
	// how far back the calendar may look, and how long a recorded slot is
	// kept. The keep is generous because a dub's lag is measured against the
	// original slot of the same episode, and a dub can trail by a month.
	airingsLookback = 7 * 24 * time.Hour
	airingsKeep     = 90 * 24 * time.Hour
)

// recordAirings copies every scheduled slot the provider caches currently hold
// into the airings table. The providers only ever hand out the future, so a
// slot is gone from their side the moment it airs - this is the only place it
// is ever written down, and the calendar's view of the past week is exactly as
// good as how often this ran.
//
// Reads caches only: no provider is dialled, so it is cheap enough for the
// sweep's five-minute tick.
func (s *Server) recordAirings() {
	rows, err := s.DB.Query(`SELECT DISTINCT cm.source, cm.media_id
		FROM watches w JOIN catalog_matches cm ON cm.server_id = w.server_id AND cm.folder = w.remote_path
		WHERE cm.media_id != 0`)
	if err != nil {
		return
	}
	type pair struct {
		source string
		id     int
	}
	var pairs []pair
	for rows.Next() {
		var p pair
		if rows.Scan(&p.source, &p.id) == nil {
			pairs = append(pairs, p)
		}
	}
	rows.Close()
	n := 0
	for _, p := range pairs {
		m := s.cachedMedia(p.source, p.id)
		if m == nil {
			continue
		}
		for _, a := range m.Airings() {
			if a.AiringAt == 0 {
				continue
			}
			// a slot the provider has moved overwrites the time it had; once
			// the episode airs it drops off their side and the last time they
			// gave stands
			res, err := s.DB.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES (?, ?, ?, ?, '')
				ON CONFLICT(source, media_id, episode, lang) DO UPDATE SET airing_at = excluded.airing_at
				WHERE airing_at != excluded.airing_at`,
				p.source, p.id, a.AiringAt, a.Episode)
			if err != nil {
				continue
			}
			if c, _ := res.RowsAffected(); c > 0 {
				n++
			}
		}
	}
	if _, err := s.DB.Exec(`DELETE FROM airings WHERE airing_at < ?`, time.Now().Add(-airingsKeep).Unix()); err != nil {
		slog.Debug("airings prune failed", "err", err)
	}
	if n > 0 {
		slog.Debug("airings recorded", "new", n, "media", len(pairs))
	}
}

// pastAirings reads back what a title aired between from and to, absolute
// episode numbers as the provider counted them.
func (s *Server) pastAirings(source string, mediaID int, from, to time.Time) []Airing {
	if source == "" || mediaID == 0 {
		return nil
	}
	rows, err := s.DB.Query(`SELECT airing_at, episode FROM airings
		WHERE source = ? AND media_id = ? AND lang = '' AND airing_at >= ? AND airing_at < ? ORDER BY airing_at`,
		source, mediaID, from.Unix(), to.Unix())
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Airing
	for rows.Next() {
		var a Airing
		if rows.Scan(&a.At, &a.Episode) == nil {
			out = append(out, a)
		}
	}
	return out
}

// langAirings reads back everything recorded for a title in one language,
// ” being the original; absolute episode numbers, oldest first.
func (s *Server) langAirings(source string, mediaID int, lang string) []Airing {
	rows, err := s.DB.Query(`SELECT airing_at, episode FROM airings
		WHERE source = ? AND media_id = ? AND lang = ? ORDER BY airing_at`, source, mediaID, lang)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Airing
	for rows.Next() {
		a := Airing{Dub: lang}
		if rows.Scan(&a.At, &a.Episode) == nil {
			out = append(out, a)
		}
	}
	return out
}

// dubLang maps the download filter's language code (Ger, Eng, ... as the
// file names spell it) to the short tag a dub slot carries. "" for a code no
// dub source speaks - and for Japanese, which is the original, not a dub.
func dubLang(wantDub string) string {
	switch strings.ToLower(wantDub) {
	case "ger", "deu", "de":
		return "de"
	case "eng", "en":
		return "en"
	case "fre", "fra", "fr":
		return "fr"
	case "ita", "it":
		return "it"
	case "spa", "es":
		return "es"
	case "por", "pt":
		return "pt"
	}
	return ""
}

// dubSlots lists a title's releases in one dub language, in the watch's
// local numbering: what was recorded as released, and for every original
// slot without a release yet a projection. Nobody publishes the projected
// dates; they are the original slot plus the lag the last releases showed
// against theirs (the median of up to three), or, before any release has
// been seen, the lag the watch was given. With neither there is nothing to
// project and only the recorded releases show.
//
// ponytail: constant lag. Catch-up weeks (two episodes at once) and
// skipped weeks shift the projection until the next release corrects it.
func (s *Server) dubSlots(source string, mediaID int, lang string, lagDays int, orig []Airing, from time.Time, offset, start int) []Airing {
	released := s.langAirings(source, mediaID, lang)
	// the originals for the lag: everything recorded, plus what the provider
	// still has dated ahead (orig carries the past week and the future)
	origAt := map[int]int64{}
	for _, a := range s.langAirings(source, mediaID, "") {
		origAt[a.Episode] = a.At
	}
	for _, a := range orig {
		origAt[a.Episode] = a.At
	}
	lag, known := lagFromReleases(released, origAt)
	if !known {
		lag, known = int64(lagDays)*86400, lagDays > 0
	}
	var out []Airing
	add := func(at int64, episode int, est bool) {
		if at < from.Unix() || episode+offset < start {
			return
		}
		air := Airing{At: at, Episode: episode + offset, Dub: lang, Est: est}
		if offset != 0 {
			air.EpisodeAbs = episode
		}
		out = append(out, air)
	}
	have := map[int]bool{}
	for _, a := range released {
		have[a.Episode] = true
		add(a.At, a.Episode, false)
	}
	if !known {
		return out
	}
	seen := map[int]bool{}
	for _, a := range orig {
		if have[a.Episode] || seen[a.Episode] {
			continue
		}
		seen[a.Episode] = true
		add(a.At+lag, a.Episode, true)
	}
	return out
}

// lagFromReleases is the median gap between a dub release and the original
// slot of the same episode, over the newest three episodes both sides know.
// A gap of zero is a simuldub and as known as any; false when they share no
// episode.
func lagFromReleases(released []Airing, origAt map[int]int64) (int64, bool) {
	byEp := append([]Airing(nil), released...)
	sort.Slice(byEp, func(i, j int) bool { return byEp[i].Episode > byEp[j].Episode })
	var gaps []int64
	for _, d := range byEp {
		if o, ok := origAt[d.Episode]; ok && d.At >= o {
			gaps = append(gaps, d.At-o)
		}
		if len(gaps) == 3 {
			break
		}
	}
	if len(gaps) == 0 {
		return 0, false
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i] < gaps[j] })
	return gaps[len(gaps)/2], true
}
