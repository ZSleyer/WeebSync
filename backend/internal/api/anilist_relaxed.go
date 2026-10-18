package api

import (
	"log/slog"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
)

// relaxedMaxQueries bounds the extra searches one folder may cost: the
// queries of a round are batched across folders, so a batch of ten folders
// costs at most this many more AniList requests.
const relaxedMaxQueries = 4

// relaxedSearch is the last stage of the match chain, for folders every other
// query found nothing for: looser queries (see match.RelaxedQueries), one
// round per query across all folders still empty. The first query that finds
// anything ends a folder's search, and what it found only counts when it
// passes match.RelaxedAccept - a looser query also finds siblings, and a
// folder left unmatched is better than one filed under the wrong show.
func (s *Server) relaxedSearch(batch []matchJob, reqs []anilist.SearchReq, infos []match.Info, results [][]anilist.Media,
	run func(stage string, idx []int, build func(i int) anilist.SearchReq)) {
	queries := make([][]string, len(batch))
	for i, b := range batch {
		if len(results[i]) != 0 || b.manga {
			continue
		}
		q := reqs[i].Query
		queries[i] = match.RelaxedQueries(infos[i].Full,
			[]string{q, GuessAltTitle(b.name), match.StripFolderMarkers(q), match.StripMovieWord(q)}, relaxedMaxQueries)
	}
	done := make([]bool, len(batch))
	for round := range relaxedMaxQueries {
		var idx []int
		for i := range batch {
			if !done[i] && len(results[i]) == 0 && round < len(queries[i]) {
				idx = append(idx, i)
			}
		}
		if len(idx) == 0 {
			return
		}
		run("relaxed", idx, func(i int) anilist.SearchReq {
			return anilist.SearchReq{Query: queries[i][round], Force: reqs[i].Force}
		})
		for _, i := range idx {
			if len(results[i]) == 0 {
				continue
			}
			done[i] = true
			query := queries[i][round]
			kept := results[i][:0:0]
			for _, m := range results[i] {
				if match.RelaxedAccept(infos[i], query, m) {
					kept = append(kept, m)
				}
			}
			slog.Debug("match relaxed gate", "folder", logSafe(batch[i].folder), "query", query,
				"candidates", len(results[i]), "accepted", len(kept))
			results[i] = kept
		}
	}
}
