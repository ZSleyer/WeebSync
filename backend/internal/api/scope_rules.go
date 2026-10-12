package api

import (
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// Scope rules: a mark that also covers the folders a parent will hold later.
// A server that files its titles under one folder per broadcast season gets
// a new season folder every quarter, and a mark is per folder, so the new one
// stayed unmatched until someone marked it - nothing on it reached the
// catalog, the suggestions or the Sonarr feed.
//
// A rule is made from a folder the user marks: same parent, same name shape,
// same kind. The shape keeps every word and only lets numbers and the names of
// seasons vary, so "Anderes" beside "2026-3 Summer" is never caught, nor
// "Anime-1080P" beside "Shows-1080p". No folder name lives in the code.

// scopeNone is a stored "no mark" that overrides a rule for one folder.
const scopeNone = "none"

var (
	shapeSeasonRe = regexp.MustCompile(`(?i)\b(?:winter|spring|summer|fall|autumn|frühling|fruehling|frühjahr|fruehjahr|sommer|herbst)\b`)
	shapeNumberRe = regexp.MustCompile(`\d+`)
)

// folderShape is a folder name with its numbers and season names replaced by
// placeholders: "2026-3 Summer" -> "{n}-{n} {season}".
func folderShape(name string) string {
	s := shapeSeasonRe.ReplaceAllString(name, "{season}")
	return shapeNumberRe.ReplaceAllString(s, "{n}")
}

// shapeVaries reports whether a shape can match another name at all; a rule
// from a name without numbers or seasons would only ever match itself.
func shapeVaries(shape string) bool {
	return strings.Contains(shape, "{n}") || strings.Contains(shape, "{season}")
}

// ruleScope is the kind a rule gives p, "" when none covers it.
func (s *Server) ruleScope(serverID int64, p string) (id int64, kind string) {
	parent, name := path.Dir(p), path.Base(p)
	if parent == p {
		return 0, ""
	}
	s.DB.QueryRow(`SELECT id, kind FROM catalog_scope_rules WHERE server_id = ? AND parent = ? AND shape = ?`,
		serverID, parent, folderShape(name)).Scan(&id, &kind)
	return id, kind
}

// ruleMarks are the folders the server's rules cover, as the sweep sees marks:
// the indexed children of each rule's parent whose name has the rule's shape
// and that carry no mark of their own.
func (s *Server) ruleMarks(serverID int64) (marks [][2]string) {
	rows, err := s.DB.Query(`SELECT r.parent, r.shape, r.kind, ri.path, ri.name FROM catalog_scope_rules r
		JOIN remote_index ri ON ri.server_id = r.server_id AND ri.parent = r.parent AND ri.is_dir = 1
		WHERE r.server_id = ? AND NOT EXISTS (SELECT 1 FROM catalog_scopes cs
			WHERE cs.server_id = ri.server_id AND cs.path = ri.path)`, serverID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var parent, shape, kind, p, name string
		if rows.Scan(&parent, &shape, &kind, &p, &name) == nil && folderShape(name) == shape {
			marks = append(marks, [2]string{p, kind})
		}
	}
	return marks
}

// scopeHint is an unmarked folder that looks like its marked siblings.
type scopeHint struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	Kind       string `json:"kind" enums:"anime,manga,tv,movie,tvdb"` // the siblings' mark
	Sibling    string `json:"sibling"`                                // a marked sibling's name, for the reason
}

// scopeHints finds the folders a user would most likely mark next: unmarked,
// not covered by a rule, beside marked folders whose names have the same
// varying shape - a new season folder beside last season's. Nothing is
// marked here; ignoring one stores "none" for it.
func (s *Server) scopeHints(userID int64) ([]scopeHint, error) {
	rows, err := s.DB.Query(`SELECT cs.server_id, sv.name, cs.path, cs.kind FROM catalog_scopes cs
		JOIN servers sv ON sv.id = cs.server_id WHERE sv.user_id = ? AND cs.kind != ?`, userID, scopeNone)
	if err != nil {
		return nil, err
	}
	type group struct {
		serverID   int64
		serverName string
		parent     string
	}
	type mark struct{ kind, name string }
	marks := map[group]map[string]mark{} // shape -> mark; "" kind = siblings disagree
	for rows.Next() {
		var g group
		var p, kind string
		if rows.Scan(&g.serverID, &g.serverName, &p, &kind) != nil {
			continue
		}
		g.parent = path.Dir(p)
		shape := folderShape(path.Base(p))
		if g.parent == p || !shapeVaries(shape) {
			continue
		}
		if marks[g] == nil {
			marks[g] = map[string]mark{}
		}
		if m, ok := marks[g][shape]; ok && m.kind != kind {
			marks[g][shape] = mark{} // two kinds for one shape: no guess
		} else if !ok {
			marks[g][shape] = mark{kind, path.Base(p)}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []scopeHint{}
	for g, shapes := range marks {
		kids, err := s.DB.Query(`SELECT ri.path, ri.name FROM remote_index ri
			WHERE ri.server_id = ? AND ri.parent = ? AND ri.is_dir = 1
			  AND NOT EXISTS (SELECT 1 FROM catalog_scopes cs WHERE cs.server_id = ri.server_id AND cs.path = ri.path)
			ORDER BY ri.name`, g.serverID, g.parent)
		if err != nil {
			return nil, err
		}
		for kids.Next() {
			var p, name string
			if kids.Scan(&p, &name) != nil {
				continue
			}
			m, ok := shapes[folderShape(name)]
			if !ok || m.kind == "" {
				continue
			}
			if id, _ := s.ruleScope(g.serverID, p); id != 0 {
				continue
			}
			out = append(out, scopeHint{g.serverID, g.serverName, p, name, m.kind, m.name})
		}
		kids.Close()
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ServerName != out[j].ServerName {
			return out[i].ServerName < out[j].ServerName
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// handleScopeHints lists unmarked folders that look like their marked siblings.
//
//	@Summary		Folders that look like marked ones
//	@Description	Unmarked folders, not covered by a scope rule, beside marked folders whose names have the same shape (numbers and season names vary) - typically a new season folder. Nothing is marked by this call.
//	@Tags			Catalog
//	@Produce		json
//	@Success		200	{array}		scopeHint
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/catalog/scope-hints [get]
func (s *Server) handleScopeHints(w http.ResponseWriter, r *http.Request) {
	out, err := s.scopeHints(auth.UserFrom(r.Context()).ID)
	if err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scopeRule is one rule as the settings list shows it.
type scopeRule struct {
	ID         int64  `json:"id"`
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"` // "" for the local library
	Parent     string `json:"parent"`
	Shape      string `json:"shape"` // name with {n} and {season} placeholders
	Kind       string `json:"kind" enums:"anime,manga,tv,movie,tvdb"`
}

// handleScopeRules lists the user's scope rules.
//
//	@Summary		List catalog scope rules
//	@Description	Rules that mark new folders like a marked one: same parent, same name shape (numbers and season names vary), same kind.
//	@Tags			Catalog
//	@Produce		json
//	@Success		200	{array}		scopeRule
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/catalog/scope-rules [get]
func (s *Server) handleScopeRules(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT r.id, r.server_id, COALESCE(sv.name, ''), r.parent, r.shape, r.kind
		FROM catalog_scope_rules r LEFT JOIN servers sv ON sv.id = r.server_id
		WHERE r.server_id = 0 OR sv.user_id = ? ORDER BY sv.name, r.parent, r.shape`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	out := []scopeRule{}
	for rows.Next() {
		var sr scopeRule
		if err := rows.Scan(&sr.ID, &sr.ServerID, &sr.ServerName, &sr.Parent, &sr.Shape, &sr.Kind); err != nil {
			dbErr(w)
			return
		}
		out = append(out, sr)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleScopeRuleDelete removes a rule. The folders it covered lose their
// mark again; the ones marked on their own keep theirs, and matches already
// made stay.
//
//	@Summary		Delete a catalog scope rule
//	@Description	Removes a scope rule. Folders it covered are no longer marked by it; folders with their own mark keep it, and matches already made stay.
//	@Tags			Catalog
//	@Produce		json
//	@Param			id	path		int	true	"Rule id"
//	@Success		200	{object}	OkResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/catalog/scope-rules/{id} [delete]
func (s *Server) handleScopeRuleDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	res, err := s.DB.Exec(`DELETE FROM catalog_scope_rules WHERE id = ? AND (server_id = 0
		OR server_id IN (SELECT id FROM servers WHERE user_id = ?))`, pathID(r), u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "rule not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
