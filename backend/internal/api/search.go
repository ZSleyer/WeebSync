package api

import (
	"net/http"
	"path"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// SearchHit is one file or folder found by handleSearch.
type SearchHit struct {
	// ServerID is the server whose index holds it, 0 for the local library
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName,omitempty"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	IsDir      bool   `json:"isDir"`
}

// SearchResponse is returned by handleSearch.
type SearchResponse struct {
	Results []SearchHit `json:"results"`
}

// how many hits each kind of source gives the palette at most
const (
	searchRemoteLimit = 30
	searchLocalLimit  = 15
)

// @Summary  Search everywhere
// @Description Searches the remote index of every server the user owns and the folders of the local library the catalog knows. Space-separated words AND-match the name. Fewer than two characters return nothing.
// @Tags     Browse
// @Produce  json
// @Param    q query string true "Search words"
// @Success  200 {object} SearchResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/search [get]
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	out := SearchResponse{Results: []SearchHit{}}
	words := strings.Fields(q)
	if len([]rune(q)) < 2 || len(words) == 0 {
		writeJSON(w, http.StatusOK, out)
		return
	}
	like := func(col string) (string, []any) {
		var sb strings.Builder
		args := make([]any, 0, len(words))
		for _, wd := range words {
			sb.WriteString(` AND ` + col + ` LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE`)
			args = append(args, escapeLike(wd))
		}
		return sb.String(), args
	}

	// every indexed server of this user, folders first
	cond, args := like("ri.name")
	rows, err := s.DB.Query(`SELECT ri.server_id, sv.name, ri.path, ri.name, ri.is_dir
		FROM remote_index ri JOIN servers sv ON sv.id = ri.server_id
		WHERE sv.user_id = ?`+cond+`
		ORDER BY ri.is_dir DESC, ri.name COLLATE NOCASE LIMIT ?`,
		append(append([]any{u.ID}, args...), searchRemoteLimit)...)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var h SearchHit
		if rows.Scan(&h.ServerID, &h.ServerName, &h.Path, &h.Name, &h.IsDir) == nil {
			out.Results = append(out.Results, h)
		}
	}
	rows.Close()

	// the local library has no file index; the catalog's folders are what
	// is known of it without walking the disks. SQL narrows on the whole
	// path, the folder's own name decides: "anime" must not return every
	// folder below an anime root.
	// ponytail: folder names only, a local file index if titles inside matter
	cond, args = like("folder")
	rows, err = s.DB.Query(`SELECT folder FROM catalog_matches WHERE server_id = ?`+cond+`
		ORDER BY folder COLLATE NOCASE LIMIT 500`,
		append([]any{localServerID}, args...)...)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	local := 0
	for rows.Next() && local < searchLocalLimit {
		var folder string
		if rows.Scan(&folder) != nil {
			continue
		}
		name := path.Base(folder)
		if !containsAll(strings.ToLower(name), words) {
			continue
		}
		out.Results = append(out.Results, SearchHit{ServerID: localServerID, Path: folder, Name: name, IsDir: true})
		local++
	}
	writeJSON(w, http.StatusOK, out)
}

func containsAll(s string, words []string) bool {
	for _, w := range words {
		if !strings.Contains(s, strings.ToLower(w)) {
			return false
		}
	}
	return true
}
