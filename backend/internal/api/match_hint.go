package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/rename"
)

// hintRecheck is how long a folder that got no hint is left alone before the
// next lookup (a forced re-match looks again at once).
const hintRecheck = 7 * 24 * time.Hour

// hintStreamTags are streaming-service tags in a folder name ("[NF]").
var hintStreamTags = map[string]bool{
	"nf": true, "amz": true, "amzn": true, "dsnp": true, "atvp": true, "hmax": true, "pcok": true, "hulu": true,
}

var hintTagGroupRe = regexp.MustCompile(`[\[(]([^\])]*)[\])]`)

// hintTierOf reads the tags of a folder name for the hint priority. Audio in
// English or German with no Japanese track, or a streaming-service tag, point
// to a western or live-action release: such folders are looked up first and
// may be named by a single word. Japanese audio does not rule a hint out (a
// dubbed western cartoon is still one) but asks for an exact title.
func hintTierOf(name string) match.HintTier {
	dub, _ := rename.LangTags(name)
	jap, west := false, false
	for _, c := range rename.Codes(dub) {
		switch strings.ToLower(c) {
		case "jap", "ja":
			jap = true
		case "ger", "eng", "de", "en":
			west = true
		}
	}
	if jap {
		return match.HintStrict
	}
	if west {
		return match.HintStrong
	}
	for _, g := range hintTagGroupRe.FindAllStringSubmatch(name, -1) {
		for _, tok := range strings.Split(g[1], ",") {
			if hintStreamTags[strings.ToLower(strings.TrimSpace(tok))] {
				return match.HintStrong
			}
		}
	}
	return match.HintNormal
}

// hintSeasonDirRe names the subfolders a show has besides its episodes.
var hintSeasonDirRe = regexp.MustCompile(`(?i)^(?:s(?:eason)?[ ._-]*\d+|staffel[ ._-]*\d+|specials?|extras?|ovas?|movies?|featurettes?|bonus|sample|subs?)\b`)

// isContainerFolder reports whether the index shows a folder that only holds
// other folders - several that are not seasons - which is a category or a
// collection, never one show. No index evidence reads as "not a container":
// the name rules decide then.
func (s *Server) isContainerFolder(serverID int64, folder string) bool {
	rows, err := s.DB.Query(`SELECT name FROM remote_index WHERE server_id = ? AND parent = ? AND is_dir = 1`, serverID, folder)
	if err != nil {
		return false
	}
	defer rows.Close()
	titled := 0
	for rows.Next() {
		var n string
		if rows.Scan(&n) != nil {
			return false
		}
		if !hintSeasonDirRe.MatchString(n) && !isHelperDir(n) {
			titled++
		}
	}
	// two non-season subfolders can be a show with two cuts of its extras
	return rows.Err() == nil && titled >= 3
}

// hintBatch looks up the folders of a match batch that stayed unmatched, the
// ones tagged as western or streamed releases first.
func (s *Server) hintBatch(ctx context.Context, batch []matchJob, infos []match.Info, idx []int) {
	if s.Tmdb == nil || !s.Tmdb.Enabled() || len(idx) == 0 {
		return
	}
	order := make([]int, 0, len(idx))
	for _, i := range idx {
		if hintTierOf(batch[i].name) == match.HintStrong {
			order = append(order, i)
		}
	}
	for _, i := range idx {
		if hintTierOf(batch[i].name) != match.HintStrong {
			order = append(order, i)
		}
	}
	for _, i := range order {
		if err := s.hintFolder(ctx, batch[i].serverID, batch[i].folder, batch[i].name, infos[i], batch[i].force); err != nil {
			slog.Debug("match hint lookup", "folder", logSafe(batch[i].folder), "err", err)
			if ctx.Err() != nil {
				return
			}
		}
	}
}

// hintFolder looks one folder up on TMDB - one tv search, one movie search -
// and stores what passes the gate (match.HintAccept) as the folder's hint. A
// dismissed hint is never replaced; a failed lookup stores nothing, so the
// next pass retries.
func (s *Server) hintFolder(ctx context.Context, serverID int64, folder, name string, info match.Info, force bool) error {
	var state string
	var checked int64
	err := s.DB.QueryRow(`SELECT state, checked_at FROM match_hints WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&state, &checked)
	switch {
	case err == nil:
		if state == "dismissed" || (!force && (state == "hint" || time.Since(time.Unix(checked, 0)) < hintRecheck)) {
			return nil
		}
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	query := match.HintQuery(info)
	if query == "" || s.isContainerFolder(serverID, folder) {
		return nil
	}
	tier := hintTierOf(name)
	type cand struct {
		kind  string
		m     anilist.Media
		score int
	}
	var best *cand
	var cands []cand
	for _, kind := range []string{"tv", "movie"} {
		list, err := s.Tmdb.Search(ctx, kind, query, 0)
		if err != nil {
			return err
		}
		for _, m := range list {
			if !match.HintAccept(info, query, m, tier) {
				continue
			}
			c := cand{kind: kind, m: m}
			// the entry whose title is the folder's, then the kind the
			// folder says, then the one most people rated
			for _, t := range []string{m.Title.Romaji, m.Title.English} {
				if t != "" && match.Normalize(t) == match.Normalize(query) {
					c.score = 4
				}
			}
			if (kind == "movie") == info.Movie {
				c.score += 2
			}
			cands = append(cands, c)
			if best == nil || c.score > best.score || (c.score == best.score && m.Popularity > best.m.Popularity) {
				best = &c
			}
		}
	}
	// several entries that are the folder's title equally well ("Treasure
	// Island" has a dozen) and no year to tell them apart: a guess among them
	// is no hint
	if best != nil && info.Year == 0 {
		for _, c := range cands {
			if c.score == best.score && (c.kind != best.kind || c.m.ID != best.m.ID) {
				best = nil
				break
			}
		}
	}
	h := matchHint{}
	if best != nil {
		// the details show what a search result does not: a series with no
		// episode is a placeholder, and the poster/overview must still be there
		full, err := s.Tmdb.Media(ctx, best.kind, best.m.ID)
		if err != nil {
			return err
		}
		if (best.kind == "movie" || full.Episodes > 0) && (full.CoverImage.Large != "" || strings.TrimSpace(full.Description) != "") {
			h = matchHint{Source: "tmdb:" + best.kind, MediaID: best.m.ID, Title: displayTitle(*full, "tmdb:"+best.kind), Year: full.SeasonYear}
		}
	}
	st := "none"
	if h.MediaID != 0 {
		st = "hint"
	}
	_, err = s.DB.Exec(`INSERT OR REPLACE INTO match_hints (server_id, folder, state, source, media_id, title, year, checked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, serverID, folder, st, h.Source, h.MediaID, h.Title, h.Year, time.Now().Unix())
	if err == nil && h.MediaID != 0 {
		slog.Debug("match hint", "folder", logSafe(folder), "source", h.Source, "media", h.MediaID, "title", h.Title)
	}
	return err
}
