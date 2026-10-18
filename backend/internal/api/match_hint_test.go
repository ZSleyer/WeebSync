package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

// fakeTmdb answers searches with fixed public titles and counts the calls.
func fakeTmdb(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/search/tv", func(w http.ResponseWriter, r *http.Request) {
		*calls++
		switch strings.ToLower(r.URL.Query().Get("query")) {
		case "neo yokio":
			w.Write([]byte(`{"results":[{"id":11,"name":"Neo Yokio","original_name":"Neo Yokio","first_air_date":"2017-09-22","poster_path":"/n.jpg","overview":"x","vote_count":300}]}`))
		case "treasure story":
			w.Write([]byte(`{"results":[
				{"id":21,"name":"Treasure Story","original_name":"Treasure Story","first_air_date":"1990-01-01","poster_path":"/a.jpg","overview":"x","vote_count":100},
				{"id":22,"name":"Treasure Story","original_name":"Treasure Story","first_air_date":"2012-01-01","poster_path":"/b.jpg","overview":"x","vote_count":100}]}`))
		case "software", "ordinary folder":
			w.Write([]byte(`{"results":[{"id":12,"name":"Software","original_name":"Software","first_air_date":"2000-01-01","poster_path":"/s.jpg","overview":"x","vote_count":900}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	})
	mux.HandleFunc("/search/movie", func(w http.ResponseWriter, r *http.Request) {
		*calls++
		w.Write([]byte(`{"results":[]}`))
	})
	mux.HandleFunc("/tv/22", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":22,"name":"Treasure Story","original_name":"Treasure Story","first_air_date":"2012-01-01","poster_path":"/b.jpg","overview":"x","number_of_episodes":4}`))
	})
	mux.HandleFunc("/tv/11", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":11,"name":"Neo Yokio","original_name":"Neo Yokio","first_air_date":"2017-09-22","poster_path":"/n.jpg","overview":"x","number_of_episodes":6,"seasons":[{"season_number":1,"episode_count":6}]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func hintServer(t *testing.T) (*Server, *int) {
	t.Helper()
	d := dbtest.Open(t)
	if err := db.SetSetting(d, "tmdb_api_key", "test.jwt.token"); err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`); err != nil {
		t.Fatal(err)
	}
	calls := new(int)
	c := tmdb.New(d)
	c.BaseURL = fakeTmdb(t, calls).URL
	return testServer(t, &Server{DB: d, Anilist: anilist.New(d), Tmdb: c}), calls
}

func lookup(t *testing.T, s *Server, folder string, force bool) {
	t.Helper()
	name := folder[strings.LastIndex(folder, "/")+1:]
	info := match.ParseName(name, GuessTitle(name), GuessAltTitle(name))
	if err := s.hintFolder(context.Background(), 1, folder, name, info, force); err != nil {
		t.Fatal(err)
	}
}

func TestHintOffered(t *testing.T) {
	s, _ := hintServer(t)
	lookup(t, s, "/Area/Neo Yokio [EngDub,NF]", false)
	h := s.hintFor(1, "/Area/Neo Yokio [EngDub,NF]")
	if h == nil || h.Source != "tmdb:tv" || h.MediaID != 11 || h.Year != 2017 || h.Title != "Neo Yokio" {
		t.Fatalf("hint = %+v", h)
	}
	// a hint is not a match: nothing in the match table, nothing bundled
	var n int
	if err := s.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM catalog_matches) + (SELECT COUNT(*) FROM series_provider)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a hint counted as a match: %d %v", n, err)
	}
}

func TestHintRefusesNonShows(t *testing.T) {
	s, calls := hintServer(t)
	// a name TMDB knows an entry for, but the folder only holds other folders
	for _, n := range []string{"Alpha", "Beta", "Gamma"} {
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,1)`,
			"/Area/Ordinary Folder/"+n, "/Area/Ordinary Folder", n)
	}
	lookup(t, s, "/Area/Ordinary Folder", false)
	// a category word, however well TMDB knows it
	lookup(t, s, "/Area/Software", false)
	// one generic word with no tag to vouch for it
	lookup(t, s, "/Area/Neo", false)
	for _, f := range []string{"/Area/Ordinary Folder", "/Area/Software", "/Area/Neo"} {
		if h := s.hintFor(1, f); h != nil {
			t.Errorf("%s got a hint: %+v", f, h)
		}
	}
	if *calls != 0 {
		t.Errorf("%d TMDB calls for folders that name no show", *calls)
	}
}

// Several entries with the folder's exact title are a guess, unless the
// folder's year picks one.
func TestHintAmbiguousTitle(t *testing.T) {
	s, _ := hintServer(t)
	lookup(t, s, "/Area/Treasure Story [EngDub]", false)
	if h := s.hintFor(1, "/Area/Treasure Story [EngDub]"); h != nil {
		t.Fatalf("hint among equals: %+v", h)
	}
	lookup(t, s, "/Area/Treasure Story (2012) [EngDub]", false)
	if h := s.hintFor(1, "/Area/Treasure Story (2012) [EngDub]"); h == nil || h.MediaID != 22 {
		t.Fatalf("the year should pick the entry: %+v", h)
	}
}

func TestHintNotAskedTwice(t *testing.T) {
	s, calls := hintServer(t)
	f := "/Area/Nothing Known Here [EngDub]"
	lookup(t, s, f, false)
	first := *calls
	if first != 1 {
		t.Fatalf("one search on the series list (TMDB tv) expected, got %d", first)
	}
	lookup(t, s, f, false)
	if *calls != first {
		t.Error("a folder with no hint was searched again at once")
	}
}

func TestHintDismissStays(t *testing.T) {
	s, _ := hintServer(t)
	f := "/Area/Neo Yokio [EngDub]"
	lookup(t, s, f, false)
	if s.hintFor(1, f) == nil {
		t.Fatal("no hint")
	}
	if _, err := s.DB.Exec(`UPDATE match_hints SET state = 'dismissed' WHERE folder = ?`, f); err != nil {
		t.Fatal(err)
	}
	lookup(t, s, f, true) // even a forced re-match does not bring it back
	if h := s.hintFor(1, f); h != nil {
		t.Fatalf("dismissed hint came back: %+v", h)
	}
}

func TestHintClearedByMatch(t *testing.T) {
	s, _ := hintServer(t)
	f := "/Area/Neo Yokio [EngDub]"
	lookup(t, s, f, false)
	if err := s.persistMatch(1, f, 0, false, "anilist"); err != nil || s.hintFor(1, f) == nil {
		t.Fatalf("an automatic miss must keep the hint: %v", err)
	}
	if err := s.persistMatch(1, f, 11, true, "tmdb:tv"); err != nil {
		t.Fatal(err)
	}
	if h := s.hintFor(1, f); h != nil {
		t.Fatalf("hint outlived the match: %+v", h)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM match_hints WHERE folder = ?`, f).Scan(&n); err != nil || n != 0 {
		t.Fatalf("hint row left: %d %v", n, err)
	}
}

func TestHintTier(t *testing.T) {
	for name, want := range map[string]match.HintTier{
		"Show [EngDub]":          match.HintStrong,
		"Show [GerDub,GerSub]":   match.HintStrong,
		"Show [GerJapDub]":       match.HintStrict,
		"Show [JapDub,EngSub]":   match.HintStrict,
		"Show [NF]":              match.HintStrong,
		"Show (1080p, DSNP)":     match.HintStrong,
		"Show":                   match.HintNormal,
		"Show [GerSub,Whatever]": match.HintNormal,
	} {
		if got := hintTierOf(name); got != want {
			t.Errorf("%q: tier %d, want %d", name, got, want)
		}
	}
}
