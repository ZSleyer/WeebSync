package api

import (
	"context"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
)

// ── search_media ──

// aiSearchMedia looks a title up at the providers: anime at AniList, series
// and films at TMDB (when configured). The entries carry the same flags the
// list tools do, so the model can tell what the user already has.
func (s *Server) aiSearchMedia(ctx context.Context, userID int64, query, kind string) any {
	query = strings.TrimSpace(query)
	if query == "" {
		return map[string]any{"error": "query required"}
	}
	have := s.aiHaveIndex(userID)
	type hit struct {
		aiListEntry
		Source   string `json:"source"`
		Episodes int    `json:"episodes,omitempty"`
		Airing   string `json:"airing,omitempty"`
	}
	out := []hit{}
	add := func(list []anilist.Media, source string) {
		for i, m := range list {
			if i >= 8 {
				break
			}
			out = append(out, hit{aiListEntry: aiListEntry{ID: m.ID, Title: aiTitle(m), Year: m.SeasonYear, Format: m.Format, Genres: m.Genres,
				Owned: have.owned(m, source), InAutoSync: have.inSync(m, source)}, Source: source, Episodes: m.Episodes, Airing: m.Status})
		}
	}
	switch kind {
	case "tv", "movie":
		if s.Tmdb == nil {
			return map[string]any{"error": "TMDB is not configured, only anime can be searched"}
		}
		list, err := s.Tmdb.Search(ctx, kind, query, 0)
		if err != nil {
			return map[string]any{"error": "TMDB unavailable: " + logSafe(err.Error())}
		}
		add(list, "tmdb:"+kind)
	default:
		list, err := s.Anilist.Search(ctx, query)
		if err != nil {
			return map[string]any{"error": "AniList unavailable: " + logSafe(err.Error())}
		}
		add(list, "anilist")
	}
	return map[string]any{"query": query, "results": out}
}

// ── library ──

type aiLocalFolder struct {
	Name       string   `json:"name"`
	Title      string   `json:"title,omitempty"` // what the catalog matched it to
	Season     int      `json:"season,omitempty"`
	IsMovie    bool     `json:"isMovie,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Dub        []string `json:"dub,omitempty"`
	Sub        []string `json:"sub,omitempty"`
}

// aiLibrary searches the local library (the indexed local folders) by words
// of a title, on the folder name and on the title it was matched to.
func (s *Server) aiLibrary(userID int64, query string) any {
	_ = userID // the library is shared, the index is per instance
	words := strings.Fields(match.GuessTitle(query))
	if len(words) == 0 {
		words = strings.Fields(query)
	}
	if len(words) == 0 {
		return map[string]any{"error": "query required"}
	}
	if len(words) > 6 {
		words = words[:6]
	}
	// the words are matched in SQL against the folder path and the bundled
	// series title, so only the survivors resolve their catalog title (that
	// is a media lookup each, and the library holds thousands of folders)
	q := `SELECT v.folder, v.res_rank, v.dub_codes, v.sub_codes, v.season, v.is_movie
		FROM catalog_variants v LEFT JOIN series se ON se.id = v.series_id
		WHERE v.server_id = 0`
	args := []any{}
	for _, wd := range words {
		q += ` AND (v.folder LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE OR COALESCE(se.title, '') LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE)`
		args = append(args, escapeLike(wd), escapeLike(wd))
	}
	q += ` ORDER BY v.folder LIMIT 30`
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	defer rows.Close()
	out := []aiLocalFolder{}
	for rows.Next() {
		var f aiLocalFolder
		var res, isMovie int
		var dub, sub string
		var folder string
		if rows.Scan(&folder, &res, &dub, &sub, &f.Season, &isMovie) != nil {
			continue
		}
		f.Name = aiLocalName(folder)
		f.Title = s.aiMatchedTitle(0, folder)
		if res > 0 {
			f.Resolution = fmtRes(res)
		}
		f.Dub, f.Sub, f.IsMovie = splitCSV(dub), splitCSV(sub), isMovie == 1
		out = append(out, f)
	}
	return map[string]any{"folders": out}
}

// ── downloads ──

// aiDownloads is the user's queue and history: the last 30 rows, or the
// last 30 of one status group (active = queued/running/paused, error, done).
func (s *Server) aiDownloads(userID int64, status string) any {
	q := `SELECT id, remote_path, local_path, size, transferred, status, error, error_code, created_at FROM downloads WHERE user_id = ?`
	args := []any{userID}
	switch status {
	case "active":
		q += ` AND status IN ('queued','running','paused')`
	case "error":
		q += ` AND status = 'error'`
	case "done":
		q += ` AND status = 'done'`
	case "":
	default:
		return map[string]any{"error": "status must be active, error or done"}
	}
	q += ` ORDER BY id DESC LIMIT 30`
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	defer rows.Close()
	type dl struct {
		ID        int64  `json:"id"`
		File      string `json:"file"`
		Folder    string `json:"folder"`
		Status    string `json:"status"`
		Error     string `json:"error,omitempty"`
		ErrorCode string `json:"errorCode,omitempty"`
		Size      string `json:"size,omitempty"`
		Progress  string `json:"progress,omitempty"`
		CreatedAt string `json:"createdAt"`
	}
	out := []dl{}
	counts := map[string]int{}
	for rows.Next() {
		var d dl
		var remote, local string
		var size, done int64
		if rows.Scan(&d.ID, &remote, &local, &size, &done, &d.Status, &d.Error, &d.ErrorCode, &d.CreatedAt) != nil {
			continue
		}
		d.File, d.Folder = path.Base(remote), aiName(path.Dir(remote))
		if size > 0 {
			d.Size = fmtBytes(size)
			if d.Status == "running" || d.Status == "paused" {
				d.Progress = strconv.Itoa(int(done*100/size)) + "%"
			}
		}
		counts[d.Status]++
		out = append(out, d)
	}
	return map[string]any{"downloads": out, "counts": counts}
}

// fmtBytes renders a size the way the dashboard does (binary units).
func fmtBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return strconv.FormatFloat(float64(n)/float64(div), 'f', 1, 64) + " " + string("KMGTPE"[exp]) + "iB"
}

// ── airing ──

// aiAiring is the calendar of the user's auto-syncs: what airs within the
// next days, what is missing locally, what lags behind the broadcast.
func (s *Server) aiAiring(userID int64, days int) any {
	if days <= 0 {
		days = 14
	}
	if days > 90 {
		days = 90
	}
	list, err := s.watchesFor(userID)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	until := time.Now().Add(time.Duration(days) * 24 * time.Hour).Unix()
	type slot struct {
		Episode int    `json:"episode"`
		At      string `json:"at"`
	}
	type entry struct {
		ID          int64  `json:"id"`
		Title       string `json:"title"`
		Category    string `json:"category,omitempty"`
		LocalFiles  int    `json:"localFiles"`
		Complete    bool   `json:"complete,omitempty"`
		NextEpisode int    `json:"nextEpisode,omitempty"`
		NextAiring  string `json:"nextAiring,omitempty"`
		Upcoming    []slot `json:"upcoming,omitempty"`
		Missing     []int  `json:"missing,omitempty"`
		Behind      int    `json:"behind,omitempty"`
		LastResult  string `json:"lastError,omitempty"`
	}
	out := []entry{}
	for _, w := range list {
		e := entry{ID: w.ID, Title: w.TitleOverride, Category: w.Category, LocalFiles: w.LocalFiles, Complete: w.Complete,
			NextEpisode: w.NextEpisode, Missing: w.Missing, Behind: w.Behind, LastResult: w.LastResult}
		if e.Title == "" && w.Media != nil {
			e.Title = aiTitle(*w.Media)
		}
		if e.Title == "" {
			e.Title = match.GuessTitle(path.Base(w.RemotePath))
		}
		if w.NextAiringAt > 0 {
			e.NextAiring = time.Unix(w.NextAiringAt, 0).Format(time.RFC3339)
		}
		for _, a := range w.Airings {
			if a.At <= until {
				e.Upcoming = append(e.Upcoming, slot{Episode: a.Episode, At: time.Unix(a.At, 0).Format(time.RFC3339)})
			}
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].NextAiring, out[j].NextAiring
		if (a == "") != (b == "") {
			return a != ""
		}
		return a < b
	})
	return map[string]any{"days": days, "watches": out}
}

// ── series_seasons ──

type aiSeason struct {
	Season     int           `json:"season"`
	Title      string        `json:"title,omitempty"`
	Year       int           `json:"year,omitempty"`
	AnilistID  int           `json:"anilistId,omitempty"`
	Local      []aiFolder    `json:"local,omitempty"`
	Remote     []aiFolder    `json:"remote,omitempty"`
	InAutoSync bool          `json:"inAutoSync,omitempty"`
	Candidates []aiCandidate `json:"candidates,omitempty"`
}

// aiSeriesSeasons lists every season of the show a media belongs to, with
// what the library holds of it, which remote folders carry it and whether an
// auto-sync exists. From the series bundle when the title was bundled, else
// (anime) along AniList's prequel/sequel chain.
func (s *Server) aiSeriesSeasons(ctx context.Context, userID int64, source string, mediaID int) any {
	if source == "" {
		source = "anilist"
	}
	if mediaID == 0 {
		return map[string]any{"error": "id required"}
	}
	seriesID := s.seriesByProvider(source, mediaID)
	if seriesID == 0 {
		if source != "anilist" {
			return map[string]any{"error": "that title is not bundled into a series yet"}
		}
		return s.aiRelationChain(ctx, userID, mediaID)
	}
	var title string
	s.DB.QueryRow(`SELECT title FROM series WHERE id = ?`, seriesID).Scan(&title)
	rows, err := s.DB.Query(`SELECT season, title, year FROM series_seasons WHERE series_id = ? ORDER BY season`, seriesID)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	seasons := map[int]*aiSeason{}
	var order []int
	for rows.Next() {
		var se aiSeason
		if rows.Scan(&se.Season, &se.Title, &se.Year) == nil {
			seasons[se.Season] = &se
			order = append(order, se.Season)
		}
	}
	rows.Close()
	at := func(n int) *aiSeason {
		if se, ok := seasons[n]; ok {
			return se
		}
		se := &aiSeason{Season: n}
		seasons[n] = se
		order = append(order, n)
		return se
	}
	// copies: local (server 0) and on the user's servers, by unit season
	vrows, err := s.DB.Query(`SELECT v.server_id, COALESCE(s.name, ''), v.folder, v.season, v.res_rank, v.dub_codes, v.sub_codes, v.is_movie
		FROM catalog_variants v LEFT JOIN servers s ON s.id = v.server_id
		WHERE v.series_id = ? AND (v.server_id = 0 OR s.user_id = ?) ORDER BY v.server_id, v.folder`, seriesID, userID)
	if err == nil {
		for vrows.Next() {
			var f aiFolder
			var serverID int64
			var folder string
			var res, isMovie int
			var dub, sub string
			if vrows.Scan(&serverID, &f.ServerName, &folder, &f.Season, &res, &dub, &sub, &isMovie) != nil {
				continue
			}
			f.Name = aiName(folder)
			if res > 0 {
				f.Resolution = fmtRes(res)
			}
			f.Dub, f.Sub, f.IsMovie = splitCSV(dub), splitCSV(sub), isMovie == 1
			se := at(f.Season)
			if serverID == 0 {
				f.Name = aiLocalName(folder)
				se.Local = append(se.Local, f)
			} else {
				f.Ref = s.aiRefFor(userID, serverID, folder)
				se.Remote = append(se.Remote, f)
			}
		}
		vrows.Close()
	}
	// auto-syncs: a watch whose folder sits in one of the seasons' units
	wrows, err := s.DB.Query(`SELECT COALESCE(v.season, 0) FROM watches w
		JOIN catalog_variants v ON v.server_id = w.server_id AND v.folder = w.remote_path
		WHERE w.user_id = ? AND v.series_id = ?`, userID, seriesID)
	if err == nil {
		for wrows.Next() {
			var n int
			if wrows.Scan(&n) == nil {
				at(n).InAutoSync = true
			}
		}
		wrows.Close()
	}
	// the AniList work of each season, so the model can show its card
	prows, err := s.DB.Query(`SELECT media_id FROM series_provider WHERE series_id = ? AND source = 'anilist'`, seriesID)
	if err == nil {
		for prows.Next() {
			var id int
			if prows.Scan(&id) != nil {
				continue
			}
			if a, ok := s.animeIDs(id); ok && a.tvdbSeason > 0 {
				if se, ok := seasons[a.tvdbSeason]; ok && se.AnilistID == 0 {
					se.AnilistID = id
				}
			}
		}
		prows.Close()
	}
	sort.Ints(order)
	out := make([]aiSeason, 0, len(order))
	for _, n := range order {
		out = append(out, *seasons[n])
	}
	return map[string]any{"series": title, "seasons": out}
}

// aiRelationChain walks AniList's prequel/sequel edges from one work and
// lists the chain in broadcast order, each with the library and remote
// flags of a seasonal entry.
func (s *Server) aiRelationChain(ctx context.Context, userID int64, mediaID int) any {
	start := s.aiMedia(ctx, "anilist", mediaID)
	if start == nil {
		return map[string]any{"error": "unknown AniList id"}
	}
	chain := []anilist.Media{*start}
	seen := map[int]bool{mediaID: true}
	for _, dir := range []string{"PREQUEL", "SEQUEL"} {
		cur := mediaID
		for hops := 0; hops < 8; hops++ {
			rels, err := s.Anilist.RelationsBatch(ctx, []int{cur})
			if err != nil {
				break
			}
			var next *anilist.Media
			for _, r := range rels[cur] {
				if r.RelationType == dir && !seen[r.Node.ID] && r.Node.Format != "MOVIE" {
					n := r.Node
					next = &n
					break
				}
			}
			if next == nil {
				break
			}
			seen[next.ID] = true
			if dir == "PREQUEL" {
				chain = append([]anilist.Media{*next}, chain...)
			} else {
				chain = append(chain, *next)
			}
			cur = next.ID
		}
	}
	have := s.aiHaveIndex(userID)
	out := make([]aiSeason, 0, len(chain))
	for i, m := range chain {
		se := aiSeason{Season: i + 1, Title: aiTitle(m), Year: m.SeasonYear, AnilistID: m.ID, InAutoSync: have.inSync(m, "anilist")}
		if have.owned(m, "anilist") {
			se.Local = []aiFolder{{Name: "(in the Plex library)"}}
		}
		se.Candidates = s.aiCands(userID, s.remoteCandidates(userID, m))
		out = append(out, se)
	}
	return map[string]any{"series": aiTitle(chain[0]), "seasons": out, "note": "seasons numbered along AniList's prequel/sequel chain"}
}
