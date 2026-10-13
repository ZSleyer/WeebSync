package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"path"
	"sort"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// Explanations: why a folder got the series it got. Nothing here is stored.
// The match is replayed on request with the search cache, so the answer is
// what matching would decide now, next to what it decided when it ran.

// explainParse is what the folder name told the matcher.
type explainParse struct {
	Title  string `json:"title"` // the search query
	Full   string `json:"full"`  // name without bracket tags and paren groups
	Alt    string `json:"alt,omitempty"`
	Season int    `json:"season,omitempty"`
	Final  bool   `json:"final,omitempty"`
	Movie  bool   `json:"movie,omitempty"`
	OVA    bool   `json:"ova,omitempty"`
	Year   int    `json:"year,omitempty"`
}

// explainScope says where the folder's metadata source came from.
type explainScope struct {
	Kind string `json:"kind"` // "" | anime | manga | tv | movie | tvdb
	// marked: a mark on the folder itself; shelf: the mark of the folder
	// above an alphabet shelf; rule: a rule on the parent; none: no source
	Origin   string `json:"origin" enums:"marked,shelf,rule,none"`
	RuleID   int64  `json:"ruleId,omitempty"`
	RuleFrom string `json:"ruleFrom,omitempty"` // the parent the rule sits on
	Shape    string `json:"shape,omitempty"`    // the name shape the rule covers
}

// explainCandidate is one search result with the points it got.
type explainCandidate struct {
	ID      int            `json:"id"`
	Title   string         `json:"title"`
	English string         `json:"english,omitempty"`
	Format  string         `json:"format,omitempty"`
	Year    int            `json:"year,omitempty"`
	Season  int            `json:"season"` // season marker in the title, -1 final
	Cover   string         `json:"cover,omitempty"`
	Score   int            `json:"score"`
	Vetoed  bool           `json:"vetoed,omitempty"`
	Signals []match.Signal `json:"signals"`
}

// explainChosen is the stored match of the folder.
type explainChosen struct {
	MediaID int    `json:"mediaId"` // 0: searched, nothing found
	Manual  bool   `json:"manual"`
	Source  string `json:"source"`
}

// catalogExplainResponse is the answer to "why this series".
type catalogExplainResponse struct {
	Folder string         `json:"folder"`
	Parse  explainParse   `json:"parse"`
	Scope  explainScope   `json:"scope"`
	Chosen *explainChosen `json:"chosen"` // nil: never matched
	// false for TMDB and TVDB: they take the first hit, there are no points
	Scored     bool               `json:"scored"`
	Tried      []searchStep       `json:"tried"`
	Candidates []explainCandidate `json:"candidates"` // best first, at most 3
	// the pick replayed now; 0 when nothing reached the bar
	Pick      int  `json:"pick"`
	Confident bool `json:"confident"`
	MinScore  int  `json:"minScore"`
	// set when the SEQUEL chain moved the pick to the season the folder names
	SequelFrom int `json:"sequelFrom,omitempty"`
	// other folders in the same directory with the same series: one card
	Bundle []string `json:"bundle"`
}

// handleCatalogExplain replays the match of one catalog folder.
//
//	@Summary		Explain a catalog match
//	@Description	Replay the match of a folder with the search cache: parsed name, searches, scored candidates, scope origin.
//	@Tags			Catalog
//	@Produce		json
//	@Param			id		path		int		true	"Server id"
//	@Param			folder	query		string	true	"Folder path"
//	@Success		200		{object}	catalogExplainResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/explain [get]
func (s *Server) handleCatalogExplain(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	folder := r.URL.Query().Get("folder")
	if folder == "" || path.Dir(folder) == folder {
		writeErr(w, http.StatusBadRequest, "folder required")
		return
	}
	if serverID != localServerID {
		var one int
		if err := s.DB.QueryRow(`SELECT 1 FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&one); err != nil {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	out, err := s.explainFolder(ctx, serverID, folder)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) explainFolder(ctx context.Context, serverID int64, folder string) (catalogExplainResponse, error) {
	name := path.Base(folder)
	info := match.ParseName(name, GuessTitle(name), GuessAltTitle(name))
	out := catalogExplainResponse{
		Folder: folder,
		Parse: explainParse{Title: info.Title, Full: info.Full, Alt: info.Alt, Season: info.Season, Final: info.Final,
			Movie: info.Movie, OVA: info.OVA, Year: info.Year},
		// a title folder is matched under the scope of the listing it sits in
		Scope:      s.explainScopeOf(serverID, path.Dir(folder)),
		Tried:      []searchStep{},
		Candidates: []explainCandidate{},
		Bundle:     []string{},
		MinScore:   match.MinScore,
	}
	var c explainChosen
	var manual int
	err := s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&c.MediaID, &manual, &c.Source)
	switch {
	case err == nil:
		c.Manual = manual == 1
		out.Chosen = &c
		out.Bundle = s.bundleOf(serverID, folder, c)
	case !errors.Is(err, sql.ErrNoRows):
		return out, err
	}
	src := sourceForScope(scopeForItem(out.Scope.Kind, s.folderKind(serverID, folder, name)))
	if src != "anilist" && src != mangaSource {
		return out, nil // TMDB and TVDB take their first hit: nothing to score
	}
	out.Scored = true
	job := matchJob{serverID: serverID, folder: folder, name: name, manga: src == mangaSource}
	results, infos, trace, err := s.searchChain(ctx, []matchJob{job})
	if err != nil {
		return out, err
	}
	out.Tried = trace[0]
	list := results[0]
	if len(list) == 0 {
		return out, nil
	}
	idx, ok, scored := match.PickExplain(infos[0], list)
	cands := make([]explainCandidate, 0, len(scored))
	for _, sc := range scored {
		m := list[sc.Index]
		cands = append(cands, explainCandidate{ID: m.ID, Title: m.Title.Romaji, English: m.Title.English, Format: m.Format,
			Year: m.SeasonYear, Season: match.SeasonOf(m), Cover: m.CoverImage.Large, Score: sc.Score, Vetoed: sc.Vetoed, Signals: sc.Signals})
	}
	// best first; vetoed ones last, they were never in the running
	sort.SliceStable(cands, func(a, b int) bool {
		if cands[a].Vetoed != cands[b].Vetoed {
			return !cands[a].Vetoed
		}
		return cands[a].Score > cands[b].Score
	})
	out.Candidates = cands[:min(3, len(cands))]
	if !ok && !rescuable(infos[0], list[idx], job.manga) {
		return out, nil
	}
	picked := []*anilist.Media{&list[idx]}
	s.fixSequelPicks(ctx, infos, picked, []bool{!ok})
	if picked[0] == nil {
		return out, nil // a rescue the relations did not confirm
	}
	out.Pick, out.Confident = picked[0].ID, ok
	if picked[0].ID != list[idx].ID {
		out.SequelFrom = list[idx].ID
	}
	return out, nil
}

// explainScopeOf mirrors scopeFor for a listing and says which of its
// branches answered.
func (s *Server) explainScopeOf(serverID int64, p string) explainScope {
	var kind string
	if err := s.DB.QueryRow(`SELECT kind FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, p).Scan(&kind); err == nil {
		if kind == scopeNone {
			return explainScope{Origin: "none"}
		}
		return explainScope{Kind: kind, Origin: "marked"}
	}
	parent := path.Dir(p)
	if isShelf(path.Base(p)) && parent != p {
		if k := s.scopeFor(serverID, parent); k != "" {
			return explainScope{Kind: k, Origin: "shelf"}
		}
		return explainScope{Origin: "none"}
	}
	if id, k := s.ruleScope(serverID, p); id != 0 && k != scopeNone && k != "" {
		return explainScope{Kind: k, Origin: "rule", RuleID: id, RuleFrom: parent, Shape: folderShape(path.Base(p))}
	}
	return explainScope{Origin: "none"}
}

// bundleOf lists the sibling folders that matched the same series and so show
// as one catalog card.
func (s *Server) bundleOf(serverID int64, folder string, c explainChosen) []string {
	out := []string{}
	if c.MediaID == 0 {
		return out
	}
	rows, err := s.DB.Query(`SELECT folder FROM catalog_matches WHERE server_id = ? AND media_id = ? AND source = ? AND folder != ?`,
		serverID, c.MediaID, c.Source, folder)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var f string
		if rows.Scan(&f) == nil && path.Dir(f) == path.Dir(folder) {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}
