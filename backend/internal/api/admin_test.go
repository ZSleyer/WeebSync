package api

import (
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

func setupAdminTest(t *testing.T) (*http.ServeMux, *Server, *http.Cookie, *http.Cookie) {
	t.Helper()
	// background jobs queued by rematch must fail fast instead of calling out
	t.Setenv("TMDB_API_KEY", "")
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('admin@example.com', 1)`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('user@example.com', 0)`)

	s := &Server{DB: d, Anilist: anilist.New(d), Tmdb: tmdb.New(d)}
	mux := http.NewServeMux()
	s.Register(mux)
	return mux, s, cookieForUser(t, d, 1), cookieForUser(t, d, 2)
}

func TestAdminRoutesGuard(t *testing.T) {
	mux, _, adminC, userC := setupAdminTest(t)

	routes := []struct{ method, path, body string }{
		{"GET", "/api/admin/jobs", ""},
		{"POST", "/api/admin/jobs/plex-suggestions/run", ""},
		{"DELETE", "/api/admin/cache/plex", ""},
		{"DELETE", "/api/admin/index/1", ""},
		{"GET", "/api/admin/cache/plex/entries", ""},
		{"DELETE", "/api/admin/cache/plex/entries?key=plex:x", ""},
		{"GET", "/api/admin/matches?serverId=1", ""},
		{"DELETE", "/api/admin/matches?serverId=1&folder=%2Fx", ""},
		{"PUT", "/api/admin/ttl", `{"anilistH":0,"tmdbH":0,"plexH":0}`},
		{"PUT", "/api/admin/index/1/config", `{"intervalMin":0,"batch":0}`},
	}
	for _, rt := range routes {
		if rec := doReq(mux, rt.method, rt.path, rt.body, userC); rec.Code != http.StatusForbidden {
			t.Errorf("non-admin %s %s: got %d, want 403", rt.method, rt.path, rec.Code)
		}
		if rec := doReq(mux, rt.method, rt.path, rt.body, adminC); rec.Code != http.StatusOK {
			t.Errorf("admin %s %s: got %d, want 200: %s", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
}

func TestAdminCacheFlushScoped(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	for _, key := range []string{"search:foo", "search:bar", "media:1", "tmdb:search:tv:foo|0"} {
		s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, '[]')`, key)
	}
	rec := doReq(mux, "DELETE", "/api/admin/cache/anilist-search", "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"deleted":2`) {
		t.Fatalf("flush anilist-search: %d %s", rec.Code, rec.Body)
	}
	count := func(prefix string) (n int) {
		s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE key LIKE ? || '%'`, prefix).Scan(&n)
		return
	}
	if n := count("search:"); n != 0 {
		t.Errorf("anilist-search rows after flush: got %d, want 0", n)
	}
	if n := count("media:"); n != 1 {
		t.Errorf("anilist-media rows: got %d, want 1", n)
	}
	if n := count("tmdb:search:"); n != 1 {
		t.Errorf("tmdb-search rows: got %d, want 1", n)
	}
	if rec := doReq(mux, "DELETE", "/api/admin/cache/nope", "", adminC); rec.Code != http.StatusNotFound {
		t.Errorf("unknown scope: got %d, want 404", rec.Code)
	}
}

func TestAdminRematch(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	res, _ := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'dev', 'sftp', 'example.com', 22, 'u', X'', '/r')`)
	serverID, _ := res.LastInsertId()
	// tmdb source: the queued background search fails fast without an API key
	seed := []struct {
		folder  string
		mediaID int
		manual  int
		source  string
	}{
		{"/r/A", 0, 0, "tmdb:tv"}, // automatic "no match"
		{"/r/B", 7, 0, "tmdb:tv"}, // automatic match
		{"/r/C", 9, 1, "anilist"}, // manual match, must survive everything
	}
	for _, m := range seed {
		s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, ?, ?)`,
			serverID, m.folder, m.mediaID, m.manual, m.source)
	}
	exists := func(folder string) bool {
		var n int
		s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE server_id = ? AND folder = ?`, serverID, folder).Scan(&n)
		return n > 0
	}

	// default: only unmatched automatic rows
	body := fmt.Sprintf(`{"serverId":%d}`, serverID)
	rec := doReq(mux, "POST", "/api/admin/jobs/rematch/run", body, adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"queued":1`) {
		t.Fatalf("rematch default: %d %s", rec.Code, rec.Body)
	}
	if exists("/r/A") || !exists("/r/B") || !exists("/r/C") {
		t.Errorf("rematch default rows: A=%v B=%v C=%v, want false true true", exists("/r/A"), exists("/r/B"), exists("/r/C"))
	}

	// all=true: every automatic row, manual still untouched
	body = fmt.Sprintf(`{"serverId":%d,"all":true}`, serverID)
	rec = doReq(mux, "POST", "/api/admin/jobs/rematch/run", body, adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"queued":1`) {
		t.Fatalf("rematch all: %d %s", rec.Code, rec.Body)
	}
	if exists("/r/B") || !exists("/r/C") {
		t.Errorf("rematch all rows: B=%v C=%v, want false true", exists("/r/B"), exists("/r/C"))
	}
	var manual int
	s.DB.QueryRow(`SELECT manual FROM catalog_matches WHERE server_id = ? AND folder = '/r/C'`, serverID).Scan(&manual)
	if manual != 1 {
		t.Errorf("manual row flag: got %d, want 1", manual)
	}

	// missing serverId
	if rec := doReq(mux, "POST", "/api/admin/jobs/rematch/run", `{}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("rematch without serverId: got %d, want 400", rec.Code)
	}
	// unknown job name
	if rec := doReq(mux, "POST", "/api/admin/jobs/frobnicate/run", "", adminC); rec.Code != http.StatusNotFound {
		t.Errorf("unknown job: got %d, want 404", rec.Code)
	}
}

func TestAdminCacheEntries(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('search:foo', '[]')`)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('search:bar', '[]')`)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('search:old', '[]', datetime('now', '-2 days'))`)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:1', '{}')`)

	// scope filter + total
	rec := doReq(mux, "GET", "/api/admin/cache/anilist-search/entries", "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"total":3`) {
		t.Fatalf("entries: %d %s", rec.Code, rec.Body)
	}
	// staleness against the scope TTL (24h)
	if !jsonHas(rec.Body.Bytes(), `"key":"search:old","fetchedAt":`) || !jsonHas(rec.Body.Bytes(), `"stale":true`) {
		t.Errorf("stale entry missing: %s", rec.Body)
	}
	// pagination: total stays, page shrinks
	rec = doReq(mux, "GET", "/api/admin/cache/anilist-search/entries?limit=2", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"total":3`) || strings.Count(rec.Body.String(), `"key":`) != 2 {
		t.Errorf("entries limit=2: %s", rec.Body)
	}
	// q filter (substring, case-insensitive)
	rec = doReq(mux, "GET", "/api/admin/cache/anilist-search/entries?q=FOO", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"total":1`) || !jsonHas(rec.Body.Bytes(), `"key":"search:foo"`) {
		t.Errorf("entries q=FOO: %s", rec.Body)
	}
	// LIKE wildcards in q match literally
	rec = doReq(mux, "GET", "/api/admin/cache/anilist-search/entries?q=%25", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"total":0`) {
		t.Errorf("entries q=%%: %s", rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/admin/cache/nope/entries", "", adminC); rec.Code != http.StatusNotFound {
		t.Errorf("unknown scope entries: got %d, want 404", rec.Code)
	}

	// single delete: key outside the scope is rejected, nothing deleted
	rec = doReq(mux, "DELETE", "/api/admin/cache/anilist-search/entries?key=media:1", "", adminC)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("cross-scope delete: got %d, want 400", rec.Code)
	}
	rec = doReq(mux, "DELETE", "/api/admin/cache/anilist-search/entries?key=search:foo", "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"deleted":1`) {
		t.Errorf("single delete: %d %s", rec.Code, rec.Body)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache`).Scan(&n)
	if n != 3 {
		t.Errorf("rows after single delete: got %d, want 3", n)
	}
}

func TestAdminTTLConfig(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	// a 2h old row: fresh under the 24h default, stale once the TTL is 1h
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('search:foo', '[]', datetime('now', '-2 hours'))`)

	rec := doReq(mux, "GET", "/api/admin/jobs", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"ttl":{"anilistH":24,"tmdbH":24,"plexH":6}`) {
		t.Errorf("default ttl info: %s", rec.Body)
	}
	if !jsonHas(rec.Body.Bytes(), `"scope":"anilist-search","count":1,`) || !jsonHas(rec.Body.Bytes(), `"ttlSec":86400,"stale":0`) {
		t.Errorf("default anilist-search stat: %s", rec.Body)
	}

	if rec := doReq(mux, "PUT", "/api/admin/ttl", `{"anilistH":1,"tmdbH":48,"plexH":12}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("set ttl: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/admin/jobs", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"ttl":{"anilistH":1,"tmdbH":48,"plexH":12}`) {
		t.Errorf("ttl info after set: %s", rec.Body)
	}
	// effective TTL flows into the scope stat and the stale computation
	if !jsonHas(rec.Body.Bytes(), `"ttlSec":3600,"stale":1`) {
		t.Errorf("anilist-search stat with 1h ttl: %s", rec.Body)
	}
	// and into the entries listing
	rec = doReq(mux, "GET", "/api/admin/cache/anilist-search/entries", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"stale":true`) {
		t.Errorf("entries stale with 1h ttl: %s", rec.Body)
	}

	// 0 resets to defaults
	if rec := doReq(mux, "PUT", "/api/admin/ttl", `{"anilistH":0,"tmdbH":0,"plexH":0}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("reset ttl: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/admin/jobs", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"ttl":{"anilistH":24,"tmdbH":24,"plexH":6}`) {
		t.Errorf("ttl info after reset: %s", rec.Body)
	}
	// validation
	if rec := doReq(mux, "PUT", "/api/admin/ttl", `{"anilistH":721}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("ttl above bound: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/admin/ttl", `{"plexH":-1}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("negative ttl: got %d, want 400", rec.Code)
	}
}

func TestAdminIndexConfig(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	res, _ := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'dev', 'sftp', 'example.com', 22, 'u', X'', '/r')`)
	serverID, _ := res.LastInsertId()
	cfgPath := fmt.Sprintf("/api/admin/index/%d/config", serverID)

	rec := doReq(mux, "GET", "/api/admin/jobs", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"intervalMin":5,"batch":20`) {
		t.Errorf("default crawler config: %s", rec.Body)
	}
	if rec := doReq(mux, "PUT", cfgPath, `{"intervalMin":10,"batch":50}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("set config: %d %s", rec.Code, rec.Body)
	}
	if s.crawlIntervalFor(serverID) != 10*time.Minute || s.crawlBatchFor(serverID) != 50 {
		t.Errorf("effective config: interval=%v batch=%d, want 10m 50", s.crawlIntervalFor(serverID), s.crawlBatchFor(serverID))
	}
	rec = doReq(mux, "GET", "/api/admin/jobs", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"intervalMin":10,"batch":50`) {
		t.Errorf("config in jobs report: %s", rec.Body)
	}
	// 0 resets to defaults
	if rec := doReq(mux, "PUT", cfgPath, `{"intervalMin":0,"batch":0}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("reset config: %d %s", rec.Code, rec.Body)
	}
	if s.crawlIntervalFor(serverID) != 5*time.Minute || s.crawlBatchFor(serverID) != 20 {
		t.Errorf("config after reset: interval=%v batch=%d, want 5m 20", s.crawlIntervalFor(serverID), s.crawlBatchFor(serverID))
	}
	// validation
	if rec := doReq(mux, "PUT", cfgPath, `{"intervalMin":1441,"batch":20}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("interval above bound: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "PUT", cfgPath, `{"intervalMin":5,"batch":501}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("batch above bound: got %d, want 400", rec.Code)
	}
}

func TestAdminMatchesListing(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	res, _ := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'dev', 'sftp', 'example.com', 22, 'u', X'', '/r')`)
	serverID, _ := res.LastInsertId()
	seed := []struct {
		folder  string
		mediaID int
		manual  int
		source  string
	}{
		{"/r/A", 0, 0, "anilist"},
		{"/r/B", 7, 0, "tmdb:tv"},
		{"/r/C", 9, 1, "anilist"},
	}
	for _, m := range seed {
		s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, ?, ?)`,
			serverID, m.folder, m.mediaID, m.manual, m.source)
	}
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:9', '{"title":{"romaji":"Foo Show"}}')`)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('tmdb:media:tv:7', '{"title":{"romaji":"","english":"Bar Show"}}')`)

	if rec := doReq(mux, "GET", "/api/admin/matches", "", adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("matches without serverId: got %d, want 400", rec.Code)
	}
	base := fmt.Sprintf("/api/admin/matches?serverId=%d", serverID)
	rec := doReq(mux, "GET", base, "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"total":3`) {
		t.Fatalf("matches all: %d %s", rec.Code, rec.Body)
	}
	// titles resolved from both cache namespaces
	if !jsonHas(rec.Body.Bytes(), `"title":"Foo Show"`) || !jsonHas(rec.Body.Bytes(), `"title":"Bar Show"`) {
		t.Errorf("matches titles: %s", rec.Body)
	}
	rec = doReq(mux, "GET", base+"&filter=unmatched", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"total":1`) || !jsonHas(rec.Body.Bytes(), `"folder":"/r/A"`) {
		t.Errorf("matches unmatched: %s", rec.Body)
	}
	rec = doReq(mux, "GET", base+"&filter=manual", "", adminC)
	if !jsonHas(rec.Body.Bytes(), `"total":1`) || !jsonHas(rec.Body.Bytes(), `"folder":"/r/C"`) {
		t.Errorf("matches manual: %s", rec.Body)
	}
	if rec := doReq(mux, "GET", base+"&filter=bogus", "", adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("matches invalid filter: got %d, want 400", rec.Code)
	}

	// single delete removes even manual rows
	rec = doReq(mux, "DELETE", base+"&folder="+url.QueryEscape("/r/C"), "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"deleted":1`) {
		t.Fatalf("match delete: %d %s", rec.Code, rec.Body)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE server_id = ? AND folder = '/r/C'`, serverID).Scan(&n)
	if n != 0 {
		t.Errorf("manual row still present after delete")
	}
}
