package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// fakePlexLibrary is a Plex server with an anime show library whose listing
// fails (a scan in progress, a timeout) and a film library that answers.
func fakePlexLibrary(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all":
			w.Write([]byte(`{"MediaContainer":{"Directory":[
				{"key":"1","type":"show","title":"Anime"},
				{"key":"2","type":"movie","title":"Filme"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/1/all"):
			http.Error(w, "busy", http.StatusInternalServerError)
		case strings.HasPrefix(r.URL.Path, "/library/sections/2/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"7","title":"The Matrix",
				"year":1999,"Guid":[{"id":"tmdb://603"}]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// One library failing used to be cached as the whole library: the films
// alone counted as a complete index, and the reconcile pass then marked every
// anime folder as "Plex has no such show" for good.
func TestPlexPartialLibraryIsNotACompleteIndex(t *testing.T) {
	srv := fakePlexLibrary(t)
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'a@example.com')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'frieren','Frieren')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',424536,1)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1,'/ftp/Frieren',424536,0,'tvdb')`)

	s.reconcilePlex(10)
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM plex_reconciled`).Scan(&n)
	if n != 0 {
		t.Error("a folder was marked as reconciled against a library that could only be read in part")
	}
	if _, ok := s.cacheGet(plexGuidKey, time.Hour); ok {
		t.Error("the partial guid index was cached as complete")
	}

	c := s.plexClient()
	if _, ok := buildPlexTitleIndex(c); ok {
		t.Error("the partial title index reported success")
	}
	s.plexShowList(c)
	if _, ok := s.cacheGet("plex:showlist:v1", time.Hour); ok {
		t.Error("the partial show list was cached for an hour")
	}
}

// suggestionsAge is how old the cached suggestion list claims to be.
func suggestionsAge(t *testing.T, s *Server) time.Duration {
	t.Helper()
	var fetched string
	if err := s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'plex:suggestions:v3'`).Scan(&fetched); err != nil {
		t.Fatalf("no suggestion list cached: %v", err)
	}
	at, err := time.Parse(sqliteTime, fetched)
	if err != nil {
		t.Fatal(err)
	}
	return time.Since(at)
}

// A library that could not be read used to leave the suggestion list fresh
// for the whole TTL (six hours): the shows of that library were missing from
// it all that time. A partial list is kept, but the next poll soon rebuilds.
func TestPlexSuggestionsPartialLibraryIsRebuiltSoon(t *testing.T) {
	srv := fakePlexLibrary(t)
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")

	s.buildPlexSuggestions(context.Background())
	if age := suggestionsAge(t, s); age < s.plexSuggestTTL()-time.Hour {
		t.Errorf("a partial suggestion list is fresh for another %v", s.plexSuggestTTL()-age)
	}
}

// relationsCutCtx lets the first Err check pass and is done from then on: the
// AniList matches come from the cache, and the relation lookup is cut off the
// way a deadline or rate limit cuts it, without a request leaving the test.
type relationsCutCtx struct {
	context.Context
	calls int
}

func (c *relationsCutCtx) Done() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func (c *relationsCutCtx) Err() error {
	c.calls++
	if c.calls == 1 {
		return nil
	}
	return context.Canceled
}

// The relation chains cut off half way: the comment promised "the next poll
// fills the rest", but the list stayed fresh for the whole TTL.
func TestPlexSuggestionsCutRelationsAreRebuiltSoon(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all":
			w.Write([]byte(`{"MediaContainer":{"Directory":[{"key":"1","type":"show","title":"Anime"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/1/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"3","title":"Frieren",
				"year":2023,"leafCount":28}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")
	s.cacheSet("search:frieren", `[{"id":154587,"format":"TV","episodes":28,"title":{"romaji":"Frieren"}}]`)

	s.buildPlexSuggestions(&relationsCutCtx{Context: context.Background()})
	if age := suggestionsAge(t, s); age < s.plexSuggestTTL()-time.Hour {
		t.Errorf("a list with cut relation chains is fresh for another %v", s.plexSuggestTTL()-age)
	}
}

// A server change used to keep the suggestion list and the folder names of
// the old server's items, filed under ratingKeys that name other items on the
// new one.
func TestForgetMediaServerDropsSuggestionsAndFolderNames(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_url", "http://plex.example.com:32400")
	db.SetSetting(d, "plex_token", "tok")
	db.SetSetting(d, "media_server_kind", "plex")
	s.cacheSet("plex:suggestions:v3", `[]`)
	s.cacheSet("plex:loc:123", "Old Show")
	s.cacheSet("search:frieren", `[]`) // not about the server: stays

	if err := s.forgetMediaServer(s.plexClient(), "new", "old"); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"plex:suggestions:v3", "plex:loc:123"} {
		if _, ok := s.cacheGet(k, time.Hour); ok {
			t.Errorf("%s survived the server change", k)
		}
	}
	if _, ok := s.cacheGet("search:frieren", time.Hour); !ok {
		t.Error("an unrelated cache row was dropped")
	}
}
