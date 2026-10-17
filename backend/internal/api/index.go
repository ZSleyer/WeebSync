package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/rename"
)

// The remote index powers file search in the browser. It is fed passively
// from every browse listing (free, no extra remote requests) and by a slow
// background crawler with a strict budget, so it starts incomplete and
// improves over time. Change detection is mtime-based: a directory whose
// mtime moved is re-listed ahead of the queue; every directory is re-listed
// once its own stamp is crawlRecheck old, changed or not.

const (
	crawlTick        = time.Minute     // scheduler granularity, not the crawl rate
	crawlInterval    = 5 * time.Minute // default per-server crawl interval
	crawlBatch       = 20              // default max listings per server per crawl
	crawlPause       = 2 * time.Second // pause between listings, spares real servers
	crawlMaxDepth    = 16              // "/" count; deeper directories are never queued
	crawlMaxInterval = 1440            // admin config bounds (minutes / listings)
	crawlMaxBatch    = 500
	// re-list even unchanged directories once in a while (mtime detection
	// misses in-place file changes); ponytail: fixed week-scale horizon.
	crawlRecheck = 7 * 24 * time.Hour
)

const sqliteTime = "2006-01-02 15:04:05"

// indexDir stores one directory listing in the index: upserts every entry,
// removes rows that vanished from the directory - with everything below
// them - and stamps the directory's listed_at.
//
// A child directory keeps its own stamp when its mtime is unchanged and loses
// it when the mtime moved, which puts it at the front of the queue. It does
// not inherit the parent's fresh stamp any more: that refreshed every
// unchanged child on each parent listing, so a directory under a parent
// that was listed weekly was never listed itself - its recheck clock was
// reset from above every time - and a file replaced in place under the same
// name there was never seen.
//
// All or nothing: a listing that fails to land halfway is rolled back with
// the directory's stamp, so the crawler lists it again instead of taking a
// half-written index for current.
func (s *Server) indexDir(serverID int64, dir string, entries []remote.Entry) {
	if err := db.Tx(s.DB, func(tx *sql.Tx) error {
		return writeListing(tx, serverID, dir, entries)
	}); err != nil {
		slog.Warn("index listing not stored", "server", serverID, "dir", logSafe(dir), "err", err)
	}
}

func writeListing(tx *sql.Tx, serverID int64, dir string, entries []remote.Entry) error {
	now := time.Now().UTC().Format(sqliteTime)

	seen := make([]any, 0, len(entries)+2)
	seen = append(seen, serverID, dir)
	for _, e := range entries {
		mod := e.ModTime.UTC().Format(sqliteTime)
		// child dirs with unchanged mtime keep their own listed_at; changed
		// or new ones reset to '' so the crawler picks them up soon
		if _, err := tx.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, size, mod_time, listed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, '')
			ON CONFLICT(server_id, path) DO UPDATE SET
				parent = excluded.parent, name = excluded.name, is_dir = excluded.is_dir,
				size = excluded.size,
				listed_at = CASE
					WHEN NOT excluded.is_dir THEN ''
					WHEN mod_time = excluded.mod_time THEN listed_at
					ELSE '' END,
				mod_time = excluded.mod_time`,
			serverID, e.Path, dir, e.Name, e.IsDir, e.Size, mod); err != nil {
			return err
		}
		seen = append(seen, e.Path)
	}
	// what the listing no longer shows is gone, and so is everything that
	// was indexed below it. Dropping only the direct children left a removed
	// tree's deeper levels behind as orphans, each waiting for a listing slot
	// of its own to fail before it went.
	q := `SELECT path FROM remote_index WHERE server_id = ? AND parent = ?`
	if len(entries) > 0 {
		q += ` AND path NOT IN (?` + strings.Repeat(",?", len(entries)-1) + `)`
	}
	rows, err := tx.Query(q, seen...)
	if err != nil {
		return err
	}
	defer rows.Close()
	var gone []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			// skipping it would leave the vanished subtree behind as orphans
			return err
		}
		gone = append(gone, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range gone {
		if err := deleteSubtree(tx, serverID, p); err != nil {
			return err
		}
	}
	// the directory itself was just listed
	_, err = tx.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, listed_at)
		VALUES (?, ?, '', ?, 1, ?)
		ON CONFLICT(server_id, path) DO UPDATE SET listed_at = excluded.listed_at`,
		serverID, dir, pathBase(dir), now)
	return err
}

// subtreeCond is a SQL condition for "col is p or lies below it", plus its
// three arguments. An exact range, not LIKE p||'%': the path is user data, so
// LIKE would read "_" and "%" as wildcards, fold ASCII case and let "/a/Show"
// match "/a/Show 2". "/" and "0" are adjacent bytes, so [p/, p0) is exactly
// the strings that start with "p/".
func subtreeCond(col, p string) (string, []any) {
	p = strings.TrimRight(p, "/")
	return "(" + col + " = ? OR (" + col + " >= ? AND " + col + " < ?))", []any{p, p + "/", p + "0"}
}

// deleteSubtree drops a path and every row below it. A range, not LIKE: paths
// carry "_" and "%" and those are wildcards to LIKE. And not substr either,
// which no index can serve - every vanished entry scanned the whole server
// inside the listing's transaction. Range form as in remoteShowRoot.
func deleteSubtree(ex interface {
	Exec(string, ...any) (sql.Result, error)
}, serverID int64, p string) error {
	_, err := ex.Exec(`DELETE FROM remote_index WHERE server_id = ?1
		AND path >= ?2 AND path < ?2 || '0' AND (path = ?3 OR path >= ?2 || '/')`,
		serverID, strings.TrimRight(p, "/"), p)
	return err
}

// gone reports whether a listing failed because the directory is not there
// (any more) - as opposed to a timeout or a permission the crawler lacks.
// SFTP says so through fs.ErrNotExist, FTP with a 550 reply.
func gone(err error) bool {
	if errors.Is(err, fs.ErrNotExist) || os.IsNotExist(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no such file") || strings.Contains(msg, "not exist") || strings.Contains(msg, "550")
}

func pathBase(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// nextCrawlDirs picks the directories a crawl batch should list: known but
// never-listed ones first (discovery), then the stalest re-checks. Anything
// deeper than crawlMaxDepth is left out here rather than skipped in the
// loop: a skipped directory kept its empty stamp, sorted first every time
// and took a slot of every batch without ever being listed.
func (s *Server) nextCrawlDirs(serverID int64, limit int) []string {
	// a plain string compare on listed_at (written in sqliteTime, '' sorts
	// first) so idx_remote_index_crawl hands over the due dirs in order;
	// datetime() around the column read every row of the server and sorted
	rows, err := s.DB.Query(`SELECT path FROM remote_index
		WHERE server_id = ? AND is_dir = 1 AND listed_at <= ?
		AND length(path) - length(replace(path, '/', '')) <= ?
		ORDER BY listed_at LIMIT ?`,
		serverID, time.Now().UTC().Add(-crawlRecheck).Format(sqliteTime), crawlMaxDepth, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var dirs []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil // a partial batch would starve the dirs behind it; retry next tick
		}
		dirs = append(dirs, p)
	}
	if rows.Err() != nil {
		return nil // a partial batch would starve the dirs behind it; retry next tick
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
			type srv struct {
				id, userID int64
				root       string
			}
			servers, err := func() ([]srv, error) {
				rows, err := s.DB.Query(`SELECT id, user_id, root_path FROM servers`)
				if err != nil {
					return nil, err
				}
				defer rows.Close()
				var out []srv
				for rows.Next() {
					var v srv
					if err := rows.Scan(&v.id, &v.userID, &v.root); err != nil {
						return nil, err
					}
					out = append(out, v)
				}
				return out, rows.Err()
			}()
			if err != nil {
				continue // try again on the next tick
			}
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
	// a failed seed shows as nothing due below and is retried on the next tick
	_, _ = s.DB.Exec(`INSERT OR IGNORE INTO remote_index (server_id, path, parent, name, is_dir)
		VALUES (?, ?, '', ?, 1)`, serverID, root, pathBase(root))

	dirs := s.nextCrawlDirs(serverID, batch)
	if len(dirs) == 0 {
		return
	}
	// low priority: the crawler yields connection capacity to downloads
	client, _, err := s.dialServer(ctx, userID, serverID, pool.PriLow)
	if err != nil {
		slog.Debug("index crawl dial", "server", serverID, "err", err)
		return
	}
	defer client.Close()
	for i, dir := range dirs {
		if ctx.Err() != nil {
			return
		}
		entries, err := client.List(dir)
		if err != nil {
			if gone(err) {
				// the directory is not there any more: it goes, with its tree
				slog.Debug("index crawl list", "dir", dir, "err", err)
				if err := deleteSubtree(s.DB, serverID, dir); err != nil {
					slog.Warn("index crawl: dropping a vanished directory failed", "server", serverID, "dir", logSafe(dir), "err", err)
				}
				continue
			}
			// unreadable for now - a timeout, a permission: what is indexed
			// stays, and the directory is stamped so it does not take a slot
			// of every batch until the recheck brings it round again
			slog.Info("index crawl list failed", "server", serverID, "dir", dir, "err", err)
			// a failed stamp only means the directory is tried again sooner
			_, _ = s.DB.Exec(`UPDATE remote_index SET listed_at = ? WHERE server_id = ? AND path = ?`,
				time.Now().UTC().Format(sqliteTime), serverID, dir)
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

// ServerSearchResponse is the remote-index search result: matched entries plus
// the total number of indexed entries for the server.
type ServerSearchResponse struct {
	Results []remote.Entry `json:"results"`
	Indexed int            `json:"indexed"`
}

// handleServerSearch searches the remote index of one server.
// GET /api/servers/{id}/search?q=... - multiple words AND-match the name.
//
// @Summary      Search remote index
// @Description  Full-text search across a server's remote index; multiple whitespace-separated words AND-match the file/folder name.
// @Tags         Browse
// @Produce      json
// @Param        id  path   int     true   "Server ID"
// @Param        q     query  string  false  "Search query; space-separated words AND-match the name"
// @Param        path  query  string  false  "Only entries below this folder"
// @Success      200  {object}  ServerSearchResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/servers/{id}/search [get]
func (s *Server) handleServerSearch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var owned int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&owned); err != nil {
		dbErr(w)
		return
	}
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	words := strings.Fields(r.URL.Query().Get("q"))
	out := ServerSearchResponse{Results: []remote.Entry{}}
	_ = s.DB.QueryRow(`SELECT COUNT(*) FROM remote_index WHERE server_id = ?`, id).Scan(&out.Indexed) // a count for display
	if len(words) > 0 {
		q := `SELECT path, name, is_dir, size, mod_time FROM remote_index WHERE server_id = ?`
		args := []any{id}
		for _, wd := range words {
			// ESCAPE so a literal % or _ in the query is matched literally,
			// not treated as a LIKE wildcard (behavioural, not a security fix).
			q += ` AND name LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE`
			args = append(args, escapeLike(wd))
		}
		// the folder the browser stands in scopes the search: what is above
		// or beside it is not what the user is looking at
		if dir := strings.TrimRight(r.URL.Query().Get("path"), "/"); dir != "" {
			q += ` AND path LIKE ? || '/%' ESCAPE '\'`
			args = append(args, escapeLike(dir))
		}
		q += ` ORDER BY is_dir DESC, name COLLATE NOCASE LIMIT 50`
		rows, err := s.DB.Query(q, args...)
		if err != nil {
			dbErr(w)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var e remote.Entry
			var mod string
			if err := rows.Scan(&e.Path, &e.Name, &e.IsDir, &e.Size, &mod); err != nil {
				dbErr(w)
				return
			}
			e.ModTime, _ = time.Parse(sqliteTime, mod)
			out.Results = append(out.Results, e)
		}
		if rows.Err() != nil {
			dbErr(w)
			return
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleServerLanguages returns the distinct dub/sub language codes present in
// a server's remote index (e.g. Ger, Eng, Jap), extracted from the language
// tags on file/folder names. Populates the per-watch language filter dropdown.
// GET /api/servers/{id}/languages
// ponytail: Full-Scan on-demand; cachen nur falls messbar langsam
//
// @Summary      List remote language tags
// @Description  Distinct dub/sub language codes (e.g. Ger, Eng, Jap) extracted from the server's remote index; populates the per-watch language filter.
// @Tags         Browse
// @Produce      json
// @Param        id  path  int  true  "Server ID"
// @Success      200  {object}  ServerLanguagesResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/servers/{id}/languages [get]
func (s *Server) handleServerLanguages(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var owned int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&owned); err != nil {
		dbErr(w)
		return
	}
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	dubSet, subSet := map[string]bool{}, map[string]bool{}
	rows, err := s.DB.Query(`SELECT name FROM remote_index WHERE server_id = ?`, id)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			dbErr(w)
			return
		}
		dub, sub := rename.LangTags(name)
		for _, c := range rename.Codes(dub) {
			dubSet[canonCode(c)] = true
		}
		for _, c := range rename.Codes(sub) {
			subSet[canonCode(c)] = true
		}
	}
	if rows.Err() != nil {
		dbErr(w)
		return
	}
	out := ServerLanguagesResponse{Dub: keysSorted(dubSet), Sub: keysSorted(subSet)}
	writeJSON(w, http.StatusOK, out)
}

// ServerLanguagesResponse lists the distinct dub and sub language codes found
// in a server's remote index.
type ServerLanguagesResponse struct {
	Dub []string `json:"dub"`
	Sub []string `json:"sub"`
}

// canonCode normalizes a language code's casing (GEr/ger -> Ger) so the
// dropdown lists each language once; matching stays case-insensitive.
func canonCode(c string) string {
	if c == "" {
		return c
	}
	r, n := utf8.DecodeRuneInString(c)
	return strings.ToUpper(string(r)) + strings.ToLower(c[n:])
}

func keysSorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
