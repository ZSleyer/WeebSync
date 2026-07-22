package api

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// UpgradeDims is which quality axes a user wants upgrade suggestions for.
type UpgradeDims struct {
	Res bool `json:"res"`
	Sub bool `json:"sub"`
	Dub bool `json:"dub"`
}

// upgradeDimsFor reads a user's enabled upgrade axes from users.upgrade_dims
// (CSV, default "res,sub,dub"). An empty column means the default was cleared,
// i.e. nothing.
func (s *Server) upgradeDimsFor(userID int64) UpgradeDims {
	var csv string
	s.DB.QueryRow(`SELECT upgrade_dims FROM users WHERE id = ?`, userID).Scan(&csv)
	set := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		set[strings.TrimSpace(p)] = true
	}
	return UpgradeDims{Res: set["res"], Sub: set["sub"], Dub: set["dub"]}
}

// handleUpgradeDimsGet returns the user's upgrade axes.
//
//	@Summary		Get upgrade suggestion axes
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	UpgradeDims
//	@Security		CookieAuth
//	@Router			/api/auth/upgrade-dims [get]
func (s *Server) handleUpgradeDimsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	writeJSON(w, http.StatusOK, s.upgradeDimsFor(u.ID))
}

// handleUpgradeDimsPut stores the user's upgrade axes.
//
//	@Summary		Set upgrade suggestion axes
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			body	body		UpgradeDims	true	"Enabled axes"
//	@Success		200		{object}	OkResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/upgrade-dims [put]
func (s *Server) handleUpgradeDimsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in UpgradeDims
	if !readJSON(w, r, &in) {
		return
	}
	var dims []string
	if in.Res {
		dims = append(dims, "res")
	}
	if in.Sub {
		dims = append(dims, "sub")
	}
	if in.Dub {
		dims = append(dims, "dub")
	}
	s.DB.Exec(`UPDATE users SET upgrade_dims = ? WHERE id = ?`, strings.Join(dims, ","), u.ID)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// UpgradeVariant is one physical copy of a series and its quality.
type UpgradeVariant struct {
	ServerID int64    `json:"serverId"`
	Folder   string   `json:"folder"`
	ResRank  int      `json:"resRank"`
	Dub      []string `json:"dub"`
	Sub      []string `json:"sub"`
}

// UpgradeSuggestion proposes replacing a series' weaker copy (From) with a
// better one that already exists elsewhere (To), naming which axes improve.
type UpgradeSuggestion struct {
	SeriesID    int64          `json:"seriesId"`
	Title       string         `json:"title"`
	From        UpgradeVariant `json:"from"`
	To          UpgradeVariant `json:"to"`
	ImprovesRes bool           `json:"improvesRes"`
	ImprovesSub bool           `json:"improvesSub"`
	ImprovesDub bool           `json:"improvesDub"`
}

// handleUpgrades lists, per series, every copy that a sibling copy beats on one
// of the user's enabled axes (higher resolution, or a strict superset of the
// sub/dub languages). Read-time over catalog_variants; nothing is stored.
//
//	@Summary		Upgrade suggestions
//	@Description	Better-quality copies (resolution / more sub or dub) of series already present.
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}	UpgradeSuggestion
//	@Security		CookieAuth
//	@Router			/api/upgrades [get]
func (s *Server) handleUpgrades(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	ignored := s.dismissedKeys(u.ID, "upgrade")
	out := []UpgradeSuggestion{}
	for _, up := range s.buildUpgrades(u.ID) {
		if !ignored[fmt.Sprintf("series:%d", up.SeriesID)] {
			out = append(out, up)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// buildUpgrades computes a user's upgrade suggestions (no dismiss filter - that
// is applied by the caller). Shared by /api/upgrades and the cached
// /api/suggestions blob.
func (s *Server) buildUpgrades(userID int64) []UpgradeSuggestion {
	dims := s.upgradeDimsFor(userID)
	rows, err := s.DB.Query(`SELECT sp.series_id, se.title, v.server_id, v.folder, v.res_rank, v.dub_codes, v.sub_codes
		FROM catalog_variants v
		JOIN catalog_matches m  ON m.server_id = v.server_id AND m.folder = v.folder AND m.media_id != 0
		JOIN series_provider sp ON sp.source = m.source AND sp.media_id = m.media_id
		JOIN series se          ON se.id = sp.series_id
		ORDER BY sp.series_id`)
	if err != nil {
		return []UpgradeSuggestion{}
	}
	defer rows.Close()

	groups := map[int64][]seriesVariant{}
	var order []int64
	for rows.Next() {
		var sid int64
		var title, folder, dub, sub string
		var serverID int64
		var res int
		if rows.Scan(&sid, &title, &serverID, &folder, &res, &dub, &sub) != nil {
			continue
		}
		if _, ok := groups[sid]; !ok {
			order = append(order, sid)
		}
		groups[sid] = append(groups[sid], seriesVariant{
			v:     UpgradeVariant{ServerID: serverID, Folder: folder, ResRank: res, Dub: splitCSV(dub), Sub: splitCSV(sub)},
			title: title,
		})
	}

	out := []UpgradeSuggestion{}
	for _, sid := range order {
		vs := groups[sid]
		if len(vs) < 2 {
			continue
		}
		top := bestVariant(vs)
		for _, cur := range vs {
			if cur.v.Folder == top.v.Folder && cur.v.ServerID == top.v.ServerID {
				continue
			}
			impRes := dims.Res && top.v.ResRank > cur.v.ResRank
			impSub := dims.Sub && strictSuperset(top.v.Sub, cur.v.Sub)
			impDub := dims.Dub && strictSuperset(top.v.Dub, cur.v.Dub)
			if !impRes && !impSub && !impDub {
				continue
			}
			out = append(out, UpgradeSuggestion{
				SeriesID: sid, Title: cur.title, From: cur.v, To: top.v,
				ImprovesRes: impRes, ImprovesSub: impSub, ImprovesDub: impDub,
			})
		}
	}
	return out
}

// seriesVariant pairs a copy's quality with the series' display title.
type seriesVariant struct {
	v     UpgradeVariant
	title string
}

// bestVariant picks the strongest copy: highest resolution, then most dub
// languages, then most sub languages.
func bestVariant(vs []seriesVariant) seriesVariant {
	best := vs[0]
	for _, cur := range vs[1:] {
		switch {
		case cur.v.ResRank != best.v.ResRank:
			if cur.v.ResRank > best.v.ResRank {
				best = cur
			}
		case len(cur.v.Dub) != len(best.v.Dub):
			if len(cur.v.Dub) > len(best.v.Dub) {
				best = cur
			}
		case len(cur.v.Sub) > len(best.v.Sub):
			best = cur
		}
	}
	return best
}

// strictSuperset reports whether a contains every element of b plus at least one
// more (a ⊋ b).
func strictSuperset(a, b []string) bool {
	if len(a) <= len(b) {
		return false
	}
	for _, x := range b {
		if !slices.Contains(a, x) {
			return false
		}
	}
	return true
}

func splitCSV(s string) []string {
	if s == "" {
		return []string{} // non-nil: marshals as [] not null, so the client can read .length
	}
	return strings.Split(s, ",")
}
