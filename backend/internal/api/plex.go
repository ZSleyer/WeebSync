package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/plex"
)

// Plex integration: read the user's Plex show libraries, match shows against
// AniList and suggest missing sequels, including the Plex storage folder (to
// keep a series in one place) and remote folder candidates from the index.

const plexSuggestTTL = 6 * time.Hour

func (s *Server) plexClient() *plex.Client {
	u := db.SettingOrEnv(s.DB, "plex_url", "PLEX_URL")
	t := db.SettingOrEnv(s.DB, "plex_token", "PLEX_TOKEN")
	if u == "" || t == "" {
		return nil
	}
	return plex.New(u, t)
}

// handlePlexSections lists the show sections for the settings checkboxes.
func (s *Server) handlePlexSections(w http.ResponseWriter, r *http.Request) {
	c := s.plexClient()
	if c == nil {
		writeErr(w, http.StatusBadRequest, "plex not configured")
		return
	}
	sections, err := c.Sections()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	shows := []plex.Section{}
	for _, sec := range sections {
		if sec.Type == "show" {
			shows = append(shows, sec)
		}
	}
	writeJSON(w, http.StatusOK, shows)
}

type plexSuggestion struct {
	ShowTitle  string          `json:"showTitle"`
	Year       int             `json:"year"`
	LeafCount  int             `json:"leafCount"`
	Folder     string          `json:"folder"` // Plex storage folder of the show
	Sequel     anilist.Media   `json:"sequel"`
	ChainNeed  int             `json:"chainNeed"` // episodes through the sequel
	Candidates []plexCandidate `json:"candidates"`
}

type plexCandidate struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
}

// handlePlexSuggestions serves the cached suggestion list and triggers a
// background rebuild when stale (or ?force=1). Remote candidates are
// resolved per requesting user at read time.
func (s *Server) handlePlexSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if s.plexClient() == nil {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false, "building": false, "suggestions": []plexSuggestion{}})
		return
	}
	force := r.URL.Query().Get("force") == "1"
	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = 'plex:suggestions'`).Scan(&payload, &fetched)
	fresh := false
	if t, err := time.Parse(sqliteTime, fetched); err == nil {
		fresh = time.Since(t) <= plexSuggestTTL
	}
	building := false
	if payload == "" || !fresh || force {
		building = true
		s.runJob("plex:suggest", func(ctx context.Context) { s.buildPlexSuggestions(ctx) })
	}
	var suggestions []plexSuggestion
	json.Unmarshal([]byte(payload), &suggestions)
	if suggestions == nil {
		suggestions = []plexSuggestion{}
	}
	for i := range suggestions {
		suggestions[i].Candidates = s.remoteCandidates(u.ID, suggestions[i].Sequel)
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "building": building, "suggestions": suggestions})
}

// remoteCandidates searches the requesting user's remote index for folders
// matching the sequel title (romaji, then english), max 3.
func (s *Server) remoteCandidates(userID int64, m anilist.Media) []plexCandidate {
	out := []plexCandidate{}
	seen := map[string]bool{}
	for _, title := range []string{m.Title.Romaji, m.Title.English} {
		words := significantWords(title, 3)
		if len(words) == 0 {
			continue
		}
		q := `SELECT i.server_id, s.name, i.path FROM remote_index i
			JOIN servers s ON s.id = i.server_id AND s.user_id = ?
			WHERE i.is_dir = 1`
		args := []any{userID}
		for _, wd := range words {
			q += ` AND i.name LIKE '%' || ? || '%' COLLATE NOCASE`
			args = append(args, wd)
		}
		q += ` LIMIT 3`
		rows, err := s.DB.Query(q, args...)
		if err != nil {
			continue
		}
		for rows.Next() {
			var c plexCandidate
			rows.Scan(&c.ServerID, &c.ServerName, &c.Path)
			if !seen[c.Path] && len(out) < 3 {
				seen[c.Path] = true
				out = append(out, c)
			}
		}
		rows.Close()
		if len(out) >= 3 {
			break
		}
	}
	return out
}

// significantWords picks up to n search-worthy words (len >= 3) of a title.
func significantWords(title string, n int) []string {
	var out []string
	for _, wd := range strings.FieldsFunc(title, func(r rune) bool {
		return !('a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9')
	}) {
		if len(wd) >= 3 {
			out = append(out, wd)
			if len(out) == n {
				break
			}
		}
	}
	return out
}

// sequelFormats: chain steps we count as "the series continues".
var sequelFormats = map[string]bool{"TV": true, "TV_SHORT": true, "ONA": true}

// walkChain follows SEQUEL edges from base, one step per relations wave the
// caller resolved. Returns the chain including base.
func walkChain(base anilist.Media, rels map[int][]anilist.Relation) []anilist.Media {
	chain := []anilist.Media{base}
	cur := base
	for range [8]int{} { // safety bound
		var next *anilist.Media
		for _, r := range rels[cur.ID] {
			if r.RelationType == "SEQUEL" && sequelFormats[r.Node.Format] && r.Node.Status != "NOT_YET_RELEASED" {
				n := r.Node
				next = &n
				break
			}
		}
		if next == nil {
			break
		}
		chain = append(chain, *next)
		cur = *next
	}
	return chain
}

// missingSequel finds the first chain entry whose cumulative episode count
// exceeds what Plex has. Unknown episode counts (still airing) count as 1.
func missingSequel(chain []anilist.Media, leaf int) (*anilist.Media, int) {
	cum := 0
	for i, m := range chain {
		eps := m.Episodes
		if eps <= 0 {
			eps = 1
		}
		cum += eps
		if i > 0 && leaf < cum {
			return &chain[i], cum
		}
	}
	return nil, 0
}

// buildPlexSuggestions recomputes the suggestion list: Plex shows → AniList
// matches (batched, cached) → relation chains → missing sequels + folders.
// Partial progress persists in the AniList cache, so a timed-out first run
// completes on the next poll.
func (s *Server) buildPlexSuggestions(ctx context.Context) {
	c := s.plexClient()
	if c == nil {
		return
	}
	sections, err := c.Sections()
	if err != nil {
		slog.Warn("plex sections", "err", err)
		return
	}
	wanted := map[string]bool{}
	for _, k := range strings.Split(db.Setting(s.DB, "plex_sections"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			wanted[k] = true
		}
	}
	var shows []plex.Show
	for _, sec := range sections {
		if sec.Type != "show" || (len(wanted) > 0 && !wanted[sec.Key]) {
			continue
		}
		list, err := c.Shows(sec.Key)
		if err != nil {
			slog.Warn("plex shows", "section", sec.Key, "err", err)
			continue
		}
		shows = append(shows, list...)
	}

	// match shows against AniList in batches; the response cache makes
	// repeat runs nearly free
	matched := map[string]anilist.Media{} // ratingKey → media
	for start := 0; start < len(shows); start += 10 {
		if ctx.Err() != nil {
			return
		}
		end := min(start+10, len(shows))
		reqs := make([]anilist.SearchReq, 0, 10)
		for _, sh := range shows[start:end] {
			reqs = append(reqs, anilist.SearchReq{Query: sh.Title})
		}
		results, err := s.Anilist.SearchBatch(ctx, reqs)
		if err != nil {
			slog.Warn("plex anilist match", "err", err)
			return
		}
		for i, list := range results {
			if len(list) > 0 {
				matched[shows[start+i].RatingKey] = list[0]
			}
		}
	}

	// resolve relation chains in waves (S1 → S2 → S3 ...)
	rels := map[int][]anilist.Relation{}
	need := map[int]bool{}
	for _, m := range matched {
		need[m.ID] = true
	}
	for range [4]int{} {
		var ids []int
		for id := range need {
			if _, ok := rels[id]; !ok {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			break
		}
		got, err := s.Anilist.RelationsBatch(ctx, ids)
		if err != nil {
			slog.Warn("plex relations", "err", err)
			return
		}
		for id, r := range got {
			rels[id] = r
			for _, e := range r {
				if e.RelationType == "SEQUEL" && sequelFormats[e.Node.Format] {
					need[e.Node.ID] = true
				}
			}
		}
	}

	var suggestions []plexSuggestion
	for _, sh := range shows {
		m, ok := matched[sh.RatingKey]
		if !ok {
			continue
		}
		chain := walkChain(m, rels)
		sequel, cum := missingSequel(chain, sh.LeafCount)
		if sequel == nil {
			continue
		}
		sug := plexSuggestion{ShowTitle: sh.Title, Year: sh.Year, LeafCount: sh.LeafCount, Sequel: *sequel, ChainNeed: cum}
		if detail, err := c.ShowDetail(sh.RatingKey); err == nil && len(detail.Locations) > 0 {
			sug.Folder = detail.Locations[0]
		}
		suggestions = append(suggestions, sug)
	}
	payload, _ := json.Marshal(suggestions)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('plex:suggestions', ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`, string(payload))
	slog.Info("plex suggestions built", "shows", len(shows), "matched", len(matched), "suggestions", len(suggestions))
}
