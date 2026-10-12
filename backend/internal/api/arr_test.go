package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// Release names are what Sonarr/Radarr decide on, so they must say what the
// file is in words the apps parse: the show's own title, SxxEyy (or an
// absolute number for a long runner), languages, resolution and source.
func TestArrReleaseNames(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES (1, 'frieren', 'Sousou no Frieren', 2023), (2, 'conan', 'Meitantei Conan', 1996), (3, 'spirited', 'Sen to Chihiro', 2001)`)
	s.DB.Exec(`INSERT INTO series_titles (series_id, source, locale, title) VALUES (1, 'tvdb', 'en', 'Frieren: Beyond Journey''s End'),
		(2, 'tvdb', 'en', 'Detective Conan'), (3, 'tmdb', 'en', 'Spirited Away')`)

	for _, c := range []struct {
		f    arrFile
		want string
	}{
		{arrFile{path: "/seed/Sousou no Frieren S2/Sousou no Frieren S2 - 02 [1080p][AAC][GerJapDub][GerEngSub][Web-DL].mkv",
			folder: "/seed/Sousou no Frieren S2", season: 2, showKey: "tvdb:424536", seriesID: 1},
			"Frieren: Beyond Journey's End S02E02 German DL GerEngSub 1080p WEB-DL-WeebSync"},
		{arrFile{path: "/seed/Frieren/[Grp] Frieren - 05 [JapDub][GerSub].mkv", folder: "/seed/Frieren", season: 1, resRank: 720,
			showKey: "tvdb:424536", seriesID: 1},
			"Frieren: Beyond Journey's End S01E05 Japanese GerSub 720p WEB-DL-WeebSync"},
		{arrFile{path: "/seed/Detective Conan/Detective Conan - 1187 [1080p][GerSub].mkv", folder: "/seed/Detective Conan", season: 1,
			showKey: "tvdb:72071", seriesID: 2},
			"Detective Conan - 1187 GerSub 1080p WEB-DL-WeebSync"},
		{arrFile{path: "/seed/Spirited Away/Spirited.Away.2001.GERMAN.DL.1080p.BluRay.mkv", folder: "/seed/Spirited Away",
			showKey: "tmdb:129", seriesID: 3, isMovie: true},
			"Spirited Away (2001) German DL 1080p BluRay-WeebSync"},
	} {
		r, ok := s.arrReleaseOf(c.f)
		if !ok || r.title != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.f.path, r.title, c.want)
		}
	}

	if _, ok := s.arrReleaseOf(arrFile{path: "/seed/x/Show - 1165.5 [1080p].mkv", folder: "/seed/x", season: 1}); ok {
		t.Error("a fractional special was named; the apps cannot place it")
	}
}

func TestLangWords(t *testing.T) {
	for in, want := range map[string]string{
		"GerJapDub": "German DL", "GerDub": "German", "JapDub": "Japanese",
		"EngJapDub": "English DL", "GerEngDub": "German English", "": "",
	} {
		if got := langWords(in); got != want {
			t.Errorf("langWords(%q) = %q, want %q", in, got, want)
		}
	}
}

// The feed answers what the apps ask: one episode of a show by TVDB id, and a
// plain search in a movie category with the movies only. Every release shown
// is registered under its guid, which is all a grab may name.
func TestNewznabFeed(t *testing.T) {
	s, _ := sizeTestServer(t)
	setArrKey(s, "k")
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES (1, 'frieren', 'Frieren', 2023), (2, 'kiki', 'Kiki''s Delivery Service', 1989)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (1, '/seed/Frieren S2', 'tvdb:424536', 2, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, is_movie, series_id) VALUES (1, '/seed/Kiki', 'tmdb:16859', 1, 2)`)
	addRemoteFiles(t, s, 1, "/seed/Frieren S2", map[string]int64{
		"Frieren S2 - 01 [1080p].mkv": 100, "Frieren S2 - 02 [1080p].mkv": 100, "Frieren S2 - 03 [1080p].mkv": 100,
	})
	addRemoteFiles(t, s, 1, "/seed/Kiki", map[string]int64{"Kiki.1989.1080p.BluRay.mkv": 500})
	h := s.arrGate(s.handleNewznab)
	titles := func(q string) []string {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodGet, "/api/arr/newznab/api?apikey=k&"+q, nil))
		var out []string
		for _, part := range strings.Split(w.Body.String(), "<item><title>")[1:] {
			out = append(out, part[:strings.Index(part, "</title>")])
		}
		return out
	}
	if got := titles("t=tvsearch&tvdbid=424536&season=2&ep=3"); len(got) != 1 || !strings.Contains(got[0], "S02E03") {
		t.Errorf("episode search: %q", got)
	}
	if got := titles("t=search&cat=2000"); len(got) != 1 || !strings.HasPrefix(got[0], "Kiki") {
		t.Errorf("movie category search: %q", got)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM arr_releases`).Scan(&n)
	if n != 2 {
		t.Errorf("%d releases registered, want the 2 shown", n)
	}

	// a new film the id lists do not know yet is matched by title only; the
	// RSS sync lists it all the same, Radarr reads it by title and year
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES (3, 'roboco', 'Me & Roboco The Movie', 2025)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, is_movie, series_id) VALUES (1, '/seed/Roboco', 'fold:boku to roboco', 1, 3)`)
	addRemoteFiles(t, s, 1, "/seed/Roboco", map[string]int64{"Boku to Roboco Movie [1080p].mkv": 400})
	got := titles("t=movie&cat=2000")
	if len(got) != 2 || !strings.Contains(strings.Join(got, "|"), "Roboco The Movie (2025)") {
		t.Errorf("movie RSS without a TMDB id: %q", got)
	}
}

// Off until a key exists: an install that never set the source up answers
// 404 there, as if the routes did not exist.
func TestArrGate(t *testing.T) {
	s, _ := sizeTestServer(t)
	h := s.arrGate(s.handleNewznab)
	get := func(q string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodGet, "/api/arr/newznab/api?"+q, nil))
		return w
	}
	if w := get("t=caps&apikey=x"); w.Code != http.StatusNotFound {
		t.Fatalf("without a key: %d, want 404", w.Code)
	}
	setArrKey(s, "k")
	if w := get("t=caps&apikey=wrong"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d, want 401", w.Code)
	}
	if w := get("t=caps&apikey=k"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "tv-search") {
		t.Fatalf("right key: %d %s", w.Code, w.Body.String())
	}
}

// The key goes into three apps, so the settings page can show it again; a
// key that vanished on reload got regenerated and cut all of them off.
func TestArrKeyShownAgain(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	s, _ := sizeTestServer(t)
	call := func(h http.HandlerFunc, method string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(method, "/api/settings/arr-key", nil))
		return w
	}
	if w := call(s.handleArrKeyGet, http.MethodGet); w.Code != http.StatusNotFound {
		t.Fatalf("off: %d, want 404", w.Code)
	}
	created := call(s.handleArrKeyCreate, http.MethodPost).Body.String()
	if shown := call(s.handleArrKeyGet, http.MethodGet).Body.String(); shown != created {
		t.Fatalf("shown %s, minted %s", shown, created)
	}
	call(s.handleArrKeyDelete, http.MethodDelete)
	if w := call(s.handleArrKeyGet, http.MethodGet); w.Code != http.StatusNotFound {
		t.Fatalf("after switching off: %d, want 404", w.Code)
	}
}

// Without a download folder the app would build "/<category>" and fail on
// every grab; its connection test gets the reason instead.
func TestSabConfigWithoutFolder(t *testing.T) {
	s, _ := sizeTestServer(t)
	setArrKey(s, "k")
	w := httptest.NewRecorder()
	s.arrGate(s.handleSab)(w, httptest.NewRequest(http.MethodGet, "/api?mode=get_config&apikey=k", nil))
	if !strings.Contains(w.Body.String(), `"status":false`) || !strings.Contains(w.Body.String(), "download folder") {
		t.Fatalf("get_config without a folder: %s", w.Body.String())
	}
}

// setArrKey switches the source on with a known key, stored the way
// handleArrKeyCreate stores it.
func setArrKey(s *Server, key string) {
	sum := sha256.Sum256([]byte(key))
	db.SetSetting(s.DB, "arr_key_hash", hex.EncodeToString(sum[:]))
}
