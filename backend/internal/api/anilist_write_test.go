package api

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
)

// fakeAnilist stands in for AniList's GraphQL endpoint: every request the
// client sends lands in answer, whatever URL it was addressed to, and is
// recorded. Nothing leaves the test.
type fakeAnilist struct {
	mu     sync.Mutex
	calls  []fakeCall
	answer func(query string, vars map[string]any) string
}

type fakeCall struct {
	Query string
	Vars  map[string]any
	Auth  string
}

func (f *fakeAnilist) RoundTrip(r *http.Request) (*http.Response, error) {
	raw, _ := io.ReadAll(r.Body)
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	json.Unmarshal(raw, &req)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{req.Query, req.Variables, r.Header.Get("Authorization")})
	f.mu.Unlock()
	body := `{"data":{}}`
	if f.answer != nil {
		body = f.answer(req.Query, req.Variables)
	}
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Type", "application/json")
	rec.WriteString(body)
	res := rec.Result()
	res.Request = r
	return res, nil
}

func (f *fakeAnilist) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeAnilist) last() fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

// linkedServer is a server whose user 1 has a linked AniList account (id 77,
// token "tok") and whose AniList client talks only to the returned fake.
func linkedServer(t *testing.T) (*Server, *http.ServeMux, *http.Cookie, *fakeAnilist, *sql.DB) {
	t.Helper()
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d := dbtest.Open(t)
	s := &Server{DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d)}
	fake := &fakeAnilist{}
	s.Anilist.HTTP = &http.Client{Transport: fake}
	s.Anilist.WithoutRateLimit()
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('demo@example.com', 0)`)
	enc, err := secret.Encrypt("tok")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO anilist_accounts (user_id, anilist_user_id, anilist_name, token_enc) VALUES (1, 77, 'demo', ?)`, enc); err != nil {
		t.Fatal(err)
	}
	return s, mux, cookieForUser(t, d, 1), fake, d
}

func TestAnilistWritesNeedTheSwitch(t *testing.T) {
	_, mux, c, fake, _ := linkedServer(t)
	fake.answer = func(string, map[string]any) string { return `{"data":{"SaveMediaListEntry":{"id":5}}}` }

	// off by default: refused before AniList hears of it
	rec := doReq(mux, "POST", "/api/anilist/progress", `{"mediaId":9,"progress":3}`, c)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "turned off") {
		t.Fatalf("switch off: got %d %s", rec.Code, rec.Body)
	}
	if fake.n() != 0 {
		t.Fatalf("a refused write reached AniList %d times", fake.n())
	}

	// /me reports the switches
	rec = doReq(mux, "GET", "/api/anilist/me", "", c)
	if !jsonHas(rec.Body.Bytes(), `"allow":{"list":false,"social":false}`) {
		t.Fatalf("me: %s", rec.Body)
	}

	// turning the list switch on leaves the other one alone
	rec = doReq(mux, "PUT", "/api/anilist/permissions", `{"list":true}`, c)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `{"list":true,"social":false}`) {
		t.Fatalf("permissions: got %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "POST", "/api/anilist/progress", `{"mediaId":9,"progress":3}`, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch on: got %d %s", rec.Code, rec.Body)
	}
	if fake.n() != 1 || fake.last().Auth != "Bearer tok" || !strings.Contains(fake.last().Query, "SaveMediaListEntry") {
		t.Fatalf("calls %+v", fake.calls)
	}

	// and off again
	doReq(mux, "PUT", "/api/anilist/permissions", `{"list":false}`, c)
	if rec := doReq(mux, "POST", "/api/anilist/progress", `{"mediaId":9,"progress":4}`, c); rec.Code != http.StatusForbidden {
		t.Fatalf("switched off again: got %d", rec.Code)
	}
}

func TestPlayerTracksProgressOnlyWithTheSwitch(t *testing.T) {
	s, _, _, _, d := linkedServer(t)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/media/anime/Show', 'anilist', 9)`)
	list, _ := json.Marshal([]anilist.ListEntry{{Status: "CURRENT", Progress: 2, Media: anilist.Media{ID: 9}}})
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('alist2:77', ?)`, string(list))
	src := playSource{userID: 1, serverID: 1, path: "/media/anime/Show/Show - 03.mkv"}
	if got := s.playAnilist(src); got != nil {
		t.Fatalf("switch off: the player must not offer the step, got %+v", got)
	}
	d.Exec(`UPDATE users SET anilist_write_list = 1 WHERE id = 1`)
	if got := s.playAnilist(src); got == nil || got.Episode != 3 || got.Progress != 2 {
		t.Fatalf("switch on: got %+v", got)
	}
}
