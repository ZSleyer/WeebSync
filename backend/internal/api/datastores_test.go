package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// userDataTables are the tables that hold what a person put in or what a
// transfer produced. Nothing here is rebuildable, so none of it may ever end up
// in the data store registry - that registry sits behind delete buttons.
var userDataTables = map[string]bool{
	"users":                true,
	"servers":              true,
	"watches":              true,
	"downloads":            true,
	"sessions":             true,
	"settings":             true,
	"anilist_accounts":     true,
	"tmdb_accounts":        true,
	"plex_accounts":        true,
	"user_totp":            true,
	"webauthn_credentials": true,
	"user_recovery_codes":  true,
	"push_subscriptions":   true,
	"login_pending":        true,
	"plex_stream_queue":    true,
	// bookkeeping of the migration runner itself
	"schema_migrations": true,
}

// TestDataStoresCoverEverything is the drift guard: it reads the real schema of
// a freshly migrated database and insists that every table is either inventoried
// as a data store or explicitly declared user data. A migration that adds a
// derived table now fails this test instead of quietly becoming another blind
// spot on the maintenance page.
func TestDataStoresCoverEverything(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "schema.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	rows, err := d.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	rows.Close()
	if len(tables) == 0 {
		t.Fatal("no tables in a migrated database - the schema dump is broken, not the registry")
	}
	sort.Strings(tables)

	covered := map[string]bool{}
	for _, st := range dataStores {
		for _, table := range st.tables {
			covered[table] = true
		}
	}

	var missing []string
	for _, table := range tables {
		if !covered[table] && !userDataTables[table] {
			missing = append(missing, table)
		}
	}
	if len(missing) > 0 {
		t.Errorf(`tables in the schema that no data store covers: %s

A migration introduced these tables and nobody told the maintenance page about
them. Pick one:
  - the table holds derived or cached data -> add it to dataStores in
    datastores.go (name, kind, what rebuilds it, what it depends on) and add a
    settings.jobs.data.stores.<slug> text to frontend/src/locales/{de,en}.json
  - the table holds something a user typed or a transfer produced -> add it to
    userDataTables in this test, and never put it behind a delete button.`,
			strings.Join(missing, ", "))
	}

	// the other direction: a registry entry pointing at a table that no longer
	// exists would make every count and every delete fail silently
	exists := map[string]bool{}
	for _, table := range tables {
		exists[table] = true
	}
	for _, st := range dataStores {
		if len(st.tables) == 0 {
			t.Errorf("data store %q lists no tables", st.name)
		}
		for _, table := range st.tables {
			if !exists[table] {
				t.Errorf("data store %q references table %q, which the schema does not have", st.name, table)
			}
		}
		if userDataTables[st.tables[0]] {
			t.Errorf("data store %q claims user data table %q", st.name, st.tables[0])
		}
	}
}

// TestDataStoresWellFormed keeps the registry self-consistent: unique slugs,
// known kinds, dependencies that resolve, and cache stores that actually carry
// a prefix (an empty one would match every key in the shared table).
func TestDataStoresWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, st := range dataStores {
		if seen[st.name] {
			t.Errorf("duplicate data store slug %q", st.name)
		}
		seen[st.name] = true
		switch st.kind {
		case kindCache, kindDerived, kindDecision:
		default:
			t.Errorf("data store %q has unknown kind %q", st.name, st.kind)
		}
		if st.kind == kindCache && len(st.prefixes) == 0 && !st.catchAll {
			t.Errorf("cache store %q has no key prefix - it would match the whole table", st.name)
		}
		if st.kind != kindCache && (len(st.prefixes) > 0 || st.catchAll) {
			t.Errorf("non-cache store %q carries cache key prefixes", st.name)
		}
		if st.catchAll && len(st.prefixes) > 0 {
			t.Errorf("catch-all store %q also claims prefixes; its filter is generated", st.name)
		}
		if st.timeTable != "" {
			found := false
			for _, table := range st.tables {
				found = found || table == st.timeTable
			}
			if !found {
				t.Errorf("data store %q times off %q, which is not one of its tables", st.name, st.timeTable)
			}
		}
	}
	for _, st := range dataStores {
		for _, need := range st.needs {
			if !seen[need] {
				t.Errorf("data store %q depends on unknown store %q", st.name, need)
			}
		}
	}
	// the cache scope wrapper must still resolve every cache store, otherwise
	// the key-level detail views 404
	for _, st := range dataStores {
		if st.kind != kindCache {
			continue
		}
		short := strings.TrimPrefix(st.name, "cache:")
		if short == st.name {
			t.Errorf("cache store %q is not named cache:<scope>", st.name)
		}
		if got, ok := cacheStoreFor(short); !ok || got.name != st.name {
			t.Errorf("cacheStoreFor(%q) does not resolve to %q", short, st.name)
		}
	}
	if _, ok := cacheStoreFor("remote-index"); ok {
		t.Error("cacheStoreFor resolved a non-cache store")
	}

	// Exactly one catch-all, or the complement filter means nothing.
	catchAlls := 0
	for _, st := range dataStores {
		if st.catchAll {
			catchAlls++
		}
	}
	if catchAlls != 1 {
		t.Errorf("catch-all cache stores: got %d, want exactly 1", catchAlls)
	}

	// No prefix may start with another: overlapping prefixes would count the
	// same row into two stores and make the catch-all's NOT LIKE chain exclude
	// more than the named stores actually cover.
	prefixes := claimedCachePrefixes()
	owner := map[string]string{}
	for _, st := range dataStores {
		for _, p := range st.prefixes {
			owner[p] = st.name
		}
	}
	for _, a := range prefixes {
		for _, b := range prefixes {
			if a != b && strings.HasPrefix(a, b) {
				t.Errorf("cache prefix %q (%s) is inside %q (%s); rows would count twice",
					a, owner[a], b, owner[b])
			}
		}
	}
}

// TestCacheStoresCoverEveryKey is the key-level twin of the table-level
// coverage test: a prefix nobody claimed used to survive a full reset in
// silence (31 rows did, on a real database). The catch-all makes that
// impossible by construction, and this proves it with a prefix the registry
// has never heard of.
func TestCacheStoresCoverEveryKey(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)

	// one row per known prefix, plus two families the registry does not know
	keys := []string{"whatever:1", "brandnew:2"}
	for _, p := range claimedCachePrefixes() {
		keys = append(keys, p+"x")
	}
	for _, k := range keys {
		if _, err := s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, '[]')`, k); err != nil {
			t.Fatal(err)
		}
	}
	total := count(t, s, `SELECT COUNT(*) FROM anilist_cache`)

	rec := doReq(mux, "GET", "/api/admin/data", "", adminC)
	if rec.Code != http.StatusOK {
		t.Fatalf("inventory: %d %s", rec.Code, rec.Body)
	}
	var out adminDataResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var sum, other int64
	for _, st := range out.Stores {
		if st.Kind != kindCache {
			continue
		}
		sum += st.Rows
		if st.Name == "cache:other" {
			other = st.Rows
		}
	}
	// every row is counted, and counted once
	if sum != int64(total) {
		t.Errorf("cache stores sum to %d rows, anilist_cache holds %d", sum, total)
	}
	if other != 2 {
		t.Errorf("cache:other rows: got %d, want 2 (the two unclaimed families)", other)
	}
}

// TestCacheKeyFamiliesRouting pins where each key shape the code actually
// writes ends up. The list is drawn from the cache setters in internal/api,
// internal/anilist, internal/tmdb and internal/tvdb plus what a real database
// held; eight of these families used to belong to no store at all and survived
// every reset. Anything landing in cache:other here is a family that deserves
// its own row.
func TestCacheKeyFamiliesRouting(t *testing.T) {
	want := map[string]string{
		"search: Naruto|ANIME":     "cache:anilist-search",
		"media:21":                 "cache:anilist-media",
		"rel2:21":                  "cache:anilist-relations",
		"reviews:21":               "cache:anilist-reviews", // legacy, still on disk
		"reviews2:21":              "cache:anilist-reviews", // legacy, still on disk
		"reviews3:21":              "cache:anilist-reviews",
		"trending:anime":           "cache:anilist-trending",
		"alist:12345":              "cache:anilist-userlist",
		"tmdb:search:tv:Naruto|0":  "cache:tmdb-search",
		"tmdb:media:tv:1429":       "cache:tmdb-media",
		"tmdb:title:tv:1429:de":    "cache:tmdb-media",
		"tmdb:season:1429:1":       "cache:tmdb-media",
		"tmdb:collection:1241":     "cache:tmdb-collections",
		"tmdb:coll-of:299536":      "cache:tmdb-collections",
		"tmdb:reviews3:tv:1429":    "cache:tmdb-reviews",
		"tmdb:trending:tv":         "cache:tmdb-trending",
		"tmdb:watchlist:42:tv":     "cache:tmdb-userlist",
		"tvdb:media:81797":         "cache:tvdb",
		"tvdb:title:81797:de":      "cache:tvdb",
		"tvdb:eps:81797:official:": "cache:tvdb",
		"plex:suggestions:v3":      "cache:plex",
		"plex:guididx:1":           "cache:plex",
		"plex:streams:9":           "cache:plex",
		"langprobe:1:/r/A/01.mkv":  "cache:langprobe",
		"suggestions:1":            "cache:suggestions",
	}
	for key, store := range want {
		var hits []string
		for _, st := range dataStores {
			if st.kind == kindCache && st.ownsKey(key) {
				hits = append(hits, st.name)
			}
		}
		switch {
		case len(hits) == 0:
			t.Errorf("key %q belongs to no cache store at all", key)
		case len(hits) > 1:
			t.Errorf("key %q is claimed by %v; it must belong to exactly one", key, hits)
		case hits[0] != store:
			t.Errorf("key %q went to %q, want %q", key, hits[0], store)
		}
	}
}

// TestCacheCatchAllScope covers the catch-all through the key-level endpoints:
// it must page exactly the unclaimed rows and refuse to delete a claimed one.
func TestCacheCatchAllScope(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES
		('whatever:1', '[]'), ('search:claimed', '[]')`)

	rec := doReq(mux, "GET", "/api/admin/cache/other/entries", "", adminC)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"total":1`) {
		t.Fatalf("catch-all entries: %d %s", rec.Code, rec.Body)
	}
	if !jsonHas(rec.Body.Bytes(), `"key":"whatever:1"`) {
		t.Errorf("catch-all entries do not list the unclaimed key: %s", rec.Body)
	}
	// a key another scope owns must not be reachable through the catch-all
	if rec := doReq(mux, "DELETE", "/api/admin/cache/other/entries?key=search:claimed", "", adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("claimed key via catch-all: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/admin/cache/other/entries?key=whatever:1", "", adminC); rec.Code != http.StatusOK {
		t.Errorf("unclaimed key via catch-all: got %d, want 200: %s", rec.Code, rec.Body)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM anilist_cache`); n != 1 {
		t.Errorf("rows after catch-all delete: got %d, want 1", n)
	}
}

func TestAdminDataInventory(t *testing.T) {
	mux, s, adminC, userC := setupAdminTest(t)

	if rec := doReq(mux, "GET", "/api/admin/data", "", userC); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin: got %d, want 403", rec.Code)
	}

	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('search:a', '[1]'), ('search:b', '[22]'), ('media:1', '[]')`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (0, '/a', 1, 0, 'anilist'), (0, '/b', 2, 1, 'anilist')`)
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (0, '/a', 'anime')`)

	rec := doReq(mux, "GET", "/api/admin/data", "", adminC)
	if rec.Code != http.StatusOK {
		t.Fatalf("inventory: %d %s", rec.Code, rec.Body)
	}
	var out adminDataResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Stores) != len(dataStores) {
		t.Fatalf("stores: got %d, want %d", len(out.Stores), len(dataStores))
	}
	byName := map[string]adminDataStore{}
	for _, st := range out.Stores {
		byName[st.Name] = st
	}
	// bytes are the real payload sizes ('[1]' + '[22]'), not an estimate
	if got := byName["cache:anilist-search"]; got.Rows != 2 || got.Bytes != 7 || got.TTLSec != 24*3600 {
		t.Errorf("cache:anilist-search: %+v", got)
	}
	if got := byName["cache:anilist-search"]; got.Oldest == "" || got.Newest == "" {
		t.Errorf("cache:anilist-search has no age span: %+v", got)
	}
	// the where filter has to bite in both directions
	if got := byName["catalog-matches"]; got.Rows != 1 {
		t.Errorf("catalog-matches rows: got %d, want 1 (manual = 0 only)", got.Rows)
	}
	// decisions: one manual match plus one scope mark
	if got := byName["catalog-decisions"]; got.Rows != 2 {
		t.Errorf("catalog-decisions rows: got %d, want 2", got.Rows)
	}
	if got := byName["catalog-decisions"]; got.Kind != kindDecision || !got.KeptOnReset {
		t.Errorf("catalog-decisions: %+v", got)
	}
	if got := byName["remote-index"]; !got.KeptOnReset || got.Rebuild != "index-crawl" {
		t.Errorf("remote-index: %+v", got)
	}
	if got := byName["series"]; len(got.Needs) == 0 || got.Bytes != 0 {
		t.Errorf("series: %+v", got)
	}
}

func count(t *testing.T, s *Server, query string) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}
