package api

import (
	"log/slog"
	"time"
)

const (
	// how far back the calendar may look, and how long a recorded slot is kept
	airingsLookback = 7 * 24 * time.Hour
	airingsKeep     = 30 * 24 * time.Hour
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
			res, err := s.DB.Exec(`INSERT INTO airings (source, media_id, airing_at, episode) VALUES (?, ?, ?, ?)
				ON CONFLICT(source, media_id, episode) DO UPDATE SET airing_at = excluded.airing_at
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
		WHERE source = ? AND media_id = ? AND airing_at >= ? AND airing_at < ? ORDER BY airing_at`,
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
