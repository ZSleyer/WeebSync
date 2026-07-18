package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/rename"
)

// The remote index powers file search in the browser. It is fed passively
// from every browse listing (free, no extra remote requests) and by a slow
// background crawler with a strict budget, so it starts incomplete and
// improves over time. Change detection is mtime-based: subtrees whose
// directory mtime did not change are not re-listed.

const (
	crawlTick        = time.Minute     // scheduler granularity, not the crawl rate
	crawlInterval    = 5 * time.Minute // default per-server crawl interval
	crawlBatch       = 20              // default max listings per server per crawl
	crawlPause       = 2 * time.Second // pause between listings, spares real servers
	crawlMaxDepth    = 16
	crawlMaxInterval = 1440 // admin config bounds (minutes / listings)
	crawlMaxBatch    = 500
	// re-list even unchanged directories once in a while (mtime detection
	// misses in-place file changes); ponytail: fixed week-scale horizon.
	crawlRecheck = 7 * 24 * time.Hour
)

const sqliteTime = "2006-01-02 15:04:05"

// indexDir stores one directory listing in the index: upserts every entry,
// removes rows that vanished from the directory and stamps the directory's
// listed_at. Unchanged child directories inherit the stamp so the crawler
// skips their subtree.
func (s *Server) indexDir(serverID int64, dir string, entries []remote.Entry) {
	tx, err := s.DB.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(sqliteTime)

	seen := make([]any, 0, len(entries)+2)
	seen = append(seen, serverID, dir)
	for _, e := range entries {
		mod := e.ModTime.UTC().Format(sqliteTime)
		// child dirs with unchanged mtime inherit a fresh listed_at (their
		// subtree is unchanged); changed or new ones reset to '' so the
		// crawler picks them up soon
		tx.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, size, mod_time, listed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, '')
			ON CONFLICT(server_id, path) DO UPDATE SET
				parent = excluded.parent, name = excluded.name, is_dir = excluded.is_dir,
				size = excluded.size,
				listed_at = CASE
					WHEN NOT excluded.is_dir THEN ''
					WHEN mod_time = excluded.mod_time AND listed_at != '' THEN ?
					ELSE '' END,
				mod_time = excluded.mod_time`,
			serverID, e.Path, dir, e.Name, e.IsDir, e.Size, mod, now)
		seen = append(seen, e.Path)
	}
	q := `DELETE FROM remote_index WHERE server_id = ? AND parent = ?`
	if len(entries) > 0 {
		q += ` AND path NOT IN (?` + strings.Repeat(",?", len(entries)-1) + `)`
	}
	tx.Exec(q, seen...)
	// the directory itself was just listed
	tx.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, listed_at)
		VALUES (?, ?, '', ?, 1, ?)
		ON CONFLICT(server_id, path) DO UPDATE SET listed_at = excluded.listed_at`,
		serverID, dir, pathBase(dir), now)
	tx.Commit()
}

func pathBase(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// nextCrawlDirs picks the directories a crawl batch should list: known but
// never-listed ones first (discovery), then the stalest re-checks.
func (s *Server) nextCrawlDirs(serverID int64, limit int) []string {
	rows, err := s.DB.Query(`SELECT path FROM remote_index
		WHERE server_id = ? AND is_dir = 1 AND (listed_at = '' OR datetime(listed_at) <= datetime('now', ?))
		ORDER BY listed_at = '' DESC, listed_at ASC LIMIT ?`,
		serverID, "-"+strconv.Itoa(int(crawlRecheck/time.Second))+" seconds", limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var dirs []string
	for rows.Next() {
		var p string
		rows.Scan(&p)
		dirs = append(dirs, p)
	}
	return dirs
}

// crawlIntervalFor returns a server's crawl interval: the per-server
// crawl_interval_min:<id> setting in minutes, default 5.
func (s *Server) crawlIntervalFor(serverID int64) time.Duration {
	if n, _ := strconv.Atoi(db.Setting(s.DB, fmt.Sprintf("crawl_interval_min:%d", serverID))); n > 0 {
		return time.Duration(n) * time.Minute
	}
	return crawlInterval
}

// crawlBatchFor returns a server's per-crawl listing budget: the per-server
// crawl_batch:<id> setting, default 20.
func (s *Server) crawlBatchFor(serverID int64) int {
	if n, _ := strconv.Atoi(db.Setting(s.DB, fmt.Sprintf("crawl_batch:%d", serverID))); n > 0 {
		return n
	}
	return crawlBatch
}

// IndexLoop runs the background crawler: one budgeted batch of listings per
// due server over a single connection. The tick is only the scheduler
// granularity; each server crawls on its own (configurable) interval.
func (s *Server) IndexLoop(ctx context.Context) {
	tick := time.NewTicker(crawlTick)
	defer tick.Stop()
	lastCrawl := map[int64]time.Time{} // only this goroutine touches it
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			rows, err := s.DB.Query(`SELECT id, user_id, root_path FROM servers`)
			if err != nil {
				continue
			}
			type srv struct {
				id, userID int64
				root       string
			}
			var servers []srv
			for rows.Next() {
				var v srv
				rows.Scan(&v.id, &v.userID, &v.root)
				servers = append(servers, v)
			}
			rows.Close()
			now := time.Now()
			for _, v := range servers {
				if now.Sub(lastCrawl[v.id]) < s.crawlIntervalFor(v.id) {
					continue
				}
				lastCrawl[v.id] = now
				s.crawlServer(ctx, v.userID, v.id, v.root, s.crawlBatchFor(v.id))
			}
		}
	}
}

func (s *Server) crawlServer(ctx context.Context, userID, serverID int64, root string, batch int) {
	// seed: the root is always a known directory
	s.DB.Exec(`INSERT OR IGNORE INTO remote_index (server_id, path, parent, name, is_dir)
		VALUES (?, ?, '', ?, 1)`, serverID, root, pathBase(root))

	dirs := s.nextCrawlDirs(serverID, batch)
	if len(dirs) == 0 {
		return
	}
	client, _, err := s.DialServer(userID, serverID)
	if err != nil {
		slog.Debug("index crawl dial", "server", serverID, "err", err)
		return
	}
	defer client.Close()
	for i, dir := range dirs {
		if ctx.Err() != nil {
			return
		}
		if depth := strings.Count(dir, "/"); depth > crawlMaxDepth {
			continue
		}
		entries, err := client.List(dir)
		if err != nil {
			slog.Debug("index crawl list", "dir", dir, "err", err)
			// directory unreadable/gone: drop it and its children from the index
			s.DB.Exec(`DELETE FROM remote_index WHERE server_id = ? AND (path = ? OR parent = ?)`, serverID, dir, dir)
			continue
		}
		s.indexDir(serverID, dir, entries)
		if i < len(dirs)-1 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(crawlPause):
			}
		}
	}
}

// handleServerSearch searches the remote index of one server.
// GET /api/servers/{id}/search?q=... — multiple words AND-match the name.
func (s *Server) handleServerSearch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	words := strings.Fields(r.URL.Query().Get("q"))
	out := struct {
		Results []remote.Entry `json:"results"`
		Indexed int            `json:"indexed"`
	}{Results: []remote.Entry{}}
	s.DB.QueryRow(`SELECT COUNT(*) FROM remote_index WHERE server_id = ?`, id).Scan(&out.Indexed)
	if len(words) > 0 {
		q := `SELECT path, name, is_dir, size, mod_time FROM remote_index WHERE server_id = ?`
		args := []any{id}
		for _, wd := range words {
			// ESCAPE so a literal % or _ in the query is matched literally,
			// not treated as a LIKE wildcard (behavioural, not a security fix).
			q += ` AND name LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE`
			args = append(args, escapeLike(wd))
		}
		q += ` ORDER BY is_dir DESC, name COLLATE NOCASE LIMIT 50`
		rows, err := s.DB.Query(q, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var e remote.Entry
				var mod string
				rows.Scan(&e.Path, &e.Name, &e.IsDir, &e.Size, &mod)
				e.ModTime, _ = time.Parse(sqliteTime, mod)
				out.Results = append(out.Results, e)
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleServerLanguages returns the distinct dub/sub language codes present in
// a server's remote index (e.g. Ger, Eng, Jap), extracted from the language
// tags on file/folder names. Populates the per-watch language filter dropdown.
// GET /api/servers/{id}/languages
// ponytail: Full-Scan on-demand; cachen nur falls messbar langsam
func (s *Server) handleServerLanguages(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	dubSet, subSet := map[string]bool{}, map[string]bool{}
	rows, err := s.DB.Query(`SELECT name FROM remote_index WHERE server_id = ?`, id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var name string
			rows.Scan(&name)
			dub, sub := rename.LangTags(name)
			for _, c := range rename.Codes(dub) {
				dubSet[canonCode(c)] = true
			}
			for _, c := range rename.Codes(sub) {
				subSet[canonCode(c)] = true
			}
		}
	}
	out := struct {
		Dub []string `json:"dub"`
		Sub []string `json:"sub"`
	}{Dub: keysSorted(dubSet), Sub: keysSorted(subSet)}
	writeJSON(w, http.StatusOK, out)
}

// canonCode normalizes a language code's casing (GEr/ger -> Ger) so the
// dropdown lists each language once; matching stays case-insensitive.
func canonCode(c string) string {
	if c == "" {
		return c
	}
	return strings.ToUpper(c[:1]) + strings.ToLower(c[1:])
}

func keysSorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
