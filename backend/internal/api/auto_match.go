package api

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
)

// The "automatic" scope. A mark of any other kind fixes one provider for the
// folders under it; this one only says that the folders here are titles, and
// each folder is looked up on the providers the routing setting lists
// (match_routing.go): AniList, TVDB and TMDB in the admin's order, per kind
// (series or film), the ones switched off or without a key skipped. Nothing
// new matches: the per-provider pipelines run as they do under their own
// marks (AniList with its fallback chain and the sequel walk, TMDB and TVDB
// with their exact-title pick and the show-plus-season numbering), so a
// season is handled the way its provider does it. What is new is who may
// overrule whom:
//
//   - a provider is asked only when the one before gave no confident match,
//     and the name's tags never change the order;
//   - the first provider asked is taken on its own confidence, as under its
//     own mark; every provider after it only when it passes the strict title
//     gate (match.AutoAccept), where the tags can only make the gate
//     stricter (audio tagged Japanese asks for an exact title), never looser,
//     because one title is often both an anime and a live-action series, and
//     a guess between them is worse than no match; when the gate says no the
//     folder stays unmatched and the hint for it stays available
//     (match_hint.go);
//   - a season folder follows the provider its sibling of the same title has
//     (siblingProvider), so "Title" and "Title S2" never land on two;
//   - a folder that cannot be a title (a category, a collection, a container
//     of other titles) is looked up on no provider at all.

// scopeAuto is the scope kind of an automatic mark.
const scopeAuto = "auto"

// isAutoSource reports whether a match source is one an automatic mark may
// have filed a folder under. Manga is a mark of its own, never chosen.
func isAutoSource(source string) bool {
	switch source {
	case "anilist", "tmdb:tv", "tmdb:movie", "tvdb", tvdbMovieSource:
		return true
	}
	return false
}

// expectedSource is the source a folder is filed under in its scope. Under an
// automatic mark that is the source its stored match has - any provider is
// right there - AniList when it has none yet or a source the mark does not
// choose among. Every other scope names its source.
func expectedSource(scope, stored string) string {
	if scope == scopeAuto && isAutoSource(stored) {
		return stored
	}
	return sourceForScope(scope)
}

// plexSourcesFor lists the sources the local library asks Plex for before it
// searches by title. Plex knows a show by its TVDB or TMDB id, which maps back
// to AniList only for an anime: that is evidence; a TMDB or TVDB id would be
// taken for the right provider without any, so an automatic mark leaves the
// western providers to the title lookup.
func (s *Server) plexSourcesFor(scope string) []string {
	return []string{sourceForScope(scope)}
}

// autoPlan says what the AniList step of an automatic match does.
type autoPlan struct {
	// the providers asked when AniList had no confident pick, in order:
	// "tvdb" and "tmdb", the ones the routing leaves after AniList
	rest []string
	// AniList is not the first provider asked: its pick has to pass the strict
	// gate before it counts
	gated bool
	// how strict the gate is for the providers after the first (autoTier)
	tier match.HintTier
}

// autoMovie reports whether a folder holds a film, as the catalog lists it:
// the folder's contents decide (a single main video is a film, season
// folders or several episodes are a series), the name's Movie word only when
// the index has nothing to say. Unclear counts as a series.
func (s *Server) autoMovie(serverID int64, folder, name string, info match.Info) bool {
	switch s.itemKind(serverID, folder, name) {
	case "movie":
		return true
	case "series":
		return false
	}
	return info.Movie
}

// autoAnime reports whether a folder's name reads as an anime, which picks the
// routing list: audio in English or German alone, or a streaming-service tag,
// is a western release; a Japanese track, and a name with nothing to say,
// count as an anime (AniList-first lists).
func autoAnime(name string) bool {
	return hintTierOf(name) != match.HintStrong
}

// autoTier is the strictness of the gate for a folder: Japanese audio asks for
// every word of the title; no other tag loosens it (a one-word name still
// needs its year, an audience).
func autoTier(name string) match.HintTier {
	if hintTierOf(name) == match.HintStrict {
		return match.HintStrict
	}
	return match.HintNormal
}

// queueAutoMatch resolves one folder under an automatic mark in the background.
func (s *Server) queueAutoMatch(serverID int64, folder, name string, force bool) {
	info := match.ParseName(name, GuessTitle(name), GuessAltTitle(name))
	if match.NonTitle(info) || s.isContainerFolder(serverID, folder) {
		// no relation to a title: no provider is asked, and the folder shows
		// as searched, not as pending
		if force || !s.hasManualMatch(serverID, folder) {
			_ = s.persistMatch(serverID, folder, 0, false, "anilist") // logged; the next poll asks again
		}
		return
	}
	seq := s.providerSequence(autoAnime(name), s.autoMovie(serverID, folder, name, info))
	if sib := s.siblingProvider(serverID, folder, name, info); sib != "" && slices.Contains(seq, sib) {
		seq = []string{sib} // the sibling vouches for it: first, so on its own confidence
	}
	s.autoWalk(serverID, folder, name, info, seq, autoTier(name), force)
}

// autoWalk asks the providers of seq in turn. AniList is asked through the
// batch queue, which carries on with the rest of the sequence; the others
// right here.
func (s *Server) autoWalk(serverID int64, folder, name string, info match.Info, seq []string, tier match.HintTier, force bool) {
	if len(seq) > 0 && seq[0] == "anilist" {
		s.enqueueMatch(matchJob{serverID: serverID, folder: folder, name: name, force: force,
			auto: &autoPlan{rest: seq[1:], tier: tier}})
		return
	}
	s.runJob(fmt.Sprintf("ma:%d:%s", serverID, folder), func(ctx context.Context) {
		if !force && s.hasManualMatch(serverID, folder) {
			return
		}
		movie := s.autoMovie(serverID, folder, name, info)
		for k, p := range seq {
			if p == "anilist" {
				s.enqueueMatch(matchJob{serverID: serverID, folder: folder, name: name, force: force,
					auto: &autoPlan{rest: seq[k+1:], gated: true, tier: tier}})
				return
			}
			src, id, err := s.westLookup(ctx, serverID, folder, name, p, movie, force)
			if err != nil {
				return // retried by the next catalog poll
			}
			// the first provider is taken on its own confidence, a later one
			// is a guess between look-alikes unless it passes the gate
			if id == 0 || (k > 0 && !s.westAccept(ctx, src, id, info, tier)) {
				continue
			}
			// persistMatch logs a failure; the next catalog poll retries
			_ = s.persistMatch(serverID, folder, id, false, src)
			return
		}
		_ = s.persistMatch(serverID, folder, 0, false, "anilist") // logged; the next poll asks again
	})
}

// westLookup asks one western provider for a folder: the entry's source tag
// and id, 0 when none carries the folder's name, an error when the search failed.
func (s *Server) westLookup(ctx context.Context, serverID int64, folder, name, provider string, movie, force bool) (string, int, error) {
	switch provider {
	case "tmdb":
		kind := "tv"
		if movie {
			kind = "movie"
		}
		id, err := s.tmdbLookup(ctx, serverID, folder, name, kind, force)
		return "tmdb:" + kind, id, err
	case "tvdb":
		if movie {
			id, err := s.tvdbMovieLookup(ctx, serverID, folder, name)
			return tvdbMovieSource, id, err
		}
		id, err := s.tvdbLookup(ctx, serverID, folder, name)
		return "tvdb", id, err
	}
	return "", 0, fmt.Errorf("unknown provider %q", provider)
}

// westAccept is the strict gate for a western pick: the candidate's record has
// to say what the folder says and nothing more (match.AutoAccept).
func (s *Server) westAccept(ctx context.Context, src string, id int, info match.Info, tier match.HintTier) bool {
	m := s.autoRecord(ctx, src, id)
	if m == nil {
		return false
	}
	// TVDB counts no audience: the poster or overview has to vouch for it
	return match.AutoAccept(info, match.HintQuery(info), *m, tier, src != "tvdb" && src != tvdbMovieSource)
}

// autoRecord loads one record of TMDB or TVDB (from the cache when it is
// there), nil when the provider does not answer.
func (s *Server) autoRecord(ctx context.Context, src string, id int) *anilist.Media {
	var m *anilist.Media
	var err error
	switch {
	case strings.HasPrefix(src, "tmdb:") && s.Tmdb != nil:
		m, err = s.Tmdb.Media(ctx, strings.TrimPrefix(src, "tmdb:"), id)
	case src == "tvdb" && s.Tvdb != nil:
		m, err = s.Tvdb.Media(ctx, id)
	case src == tvdbMovieSource && s.Tvdb != nil:
		m, err = s.Tvdb.Movie(ctx, id)
	default:
		return nil
	}
	if err != nil {
		slog.Debug("auto match: record not loaded", "source", src, "media", id, "err", err)
		return nil
	}
	return m
}

// autoFallback asks the providers after AniList for a folder AniList had no
// confident pick for. A pick counts only through the strict gate.
func (s *Server) autoFallback(ctx context.Context, b matchJob, info match.Info) (string, int) {
	movie := s.autoMovie(b.serverID, b.folder, b.name, info)
	for _, p := range b.auto.rest {
		src, id, err := s.westLookup(ctx, b.serverID, b.folder, b.name, p, movie, b.force)
		if err != nil {
			slog.Debug("auto match lookup", "folder", logSafe(b.folder), "provider", p, "err", err)
			if ctx.Err() != nil {
				return "", 0
			}
			continue
		}
		if id == 0 || !s.westAccept(ctx, src, id, info, b.auto.tier) {
			continue
		}
		slog.Debug("auto match fell to another provider", "folder", logSafe(b.folder), "source", src, "media", id)
		return src, id
	}
	return "", 0
}

// gateAutoPicks drops the AniList picks of folders whose routing put AniList
// after another provider: they have to pass the strict gate.
func gateAutoPicks(batch []matchJob, infos []match.Info, picked []*anilist.Media) {
	for i, b := range batch {
		if b.auto == nil || !b.auto.gated || picked[i] == nil {
			continue
		}
		if !match.AutoAccept(infos[i], match.HintQuery(infos[i]), *picked[i], b.auto.tier, true) {
			slog.Debug("auto match: pick refused by the strict gate", "folder", logSafe(b.folder), "media", picked[i].ID)
			picked[i] = nil
		}
	}
}

// siblingProvider names the provider ("anilist", "tmdb", "tvdb") that the
// folders beside this one with the same title - the other seasons of it - have
// been matched on, "" when there are none or they disagree. Only a folder with
// a season, part or similar marker asks: "Title S2" follows "Title", and the
// decision stays that of the provider that knows seasons of that title.
func (s *Server) siblingProvider(serverID int64, folder, name string, info match.Info) string {
	stem := match.FoldKey(match.StripFolderMarkers(GuessTitle(name)))
	if stem == "" || info.Season < 2 {
		return ""
	}
	parent := strings.TrimRight(path.Dir(folder), "/")
	rows, err := s.DB.Query(`SELECT folder, source FROM catalog_matches
		WHERE server_id = ?1 AND media_id != 0 AND folder != ?2
		AND folder >= ?3 AND folder < ?4 AND instr(substr(folder, length(?3) + 1), '/') = 0`,
		serverID, folder, parent+"/", parent+"0")
	if err != nil {
		return ""
	}
	defer rows.Close()
	found := ""
	for rows.Next() {
		var f, src string
		if rows.Scan(&f, &src) != nil {
			return ""
		}
		if !isAutoSource(src) || match.FoldKey(match.StripFolderMarkers(GuessTitle(path.Base(f)))) != stem {
			continue
		}
		p := strings.SplitN(src, ":", 2)[0]
		if found != "" && found != p {
			return "" // the sisters disagree: no one is followed
		}
		found = p
	}
	if rows.Err() != nil {
		return ""
	}
	return found
}
