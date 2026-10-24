package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
)

func TestAnilistOAuthHandlers(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	cookie := cookieForUser(t, d, 1)

	// connect without configured client: clear error
	if rec := doReq(mux, "GET", "/api/anilist/connect", "", cookie); rec.Code != http.StatusBadRequest {
		t.Errorf("connect unconfigured: got %d, want 400", rec.Code)
	}
	// configured: redirects to AniList with state cookie
	db.SetSetting(d, "anilist_client_id", "123")
	db.SetSetting(d, "anilist_client_secret", "sec")
	rec := doReq(mux, "GET", "/api/anilist/connect", "", cookie)
	if rec.Code != http.StatusFound {
		t.Fatalf("connect: got %d", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if loc == "" || rec.Result().Cookies()[0].Name != "weebsync_anilist_state" {
		t.Fatalf("connect redirect/cookie missing: %q", loc)
	}
	// callback with mismatched state is rejected
	if rec := doReq(mux, "GET", "/api/anilist/callback?state=wrong&code=x", "", cookie); rec.Code != http.StatusBadRequest {
		t.Errorf("callback bad state: got %d, want 400", rec.Code)
	}
	// me: not connected
	rec = doReq(mux, "GET", "/api/anilist/me", "", cookie)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"connected":false`) {
		t.Errorf("me: %d %s", rec.Code, rec.Body)
	}
	// progress without linked account
	if rec := doReq(mux, "POST", "/api/anilist/progress", `{"mediaId":1,"progress":2}`, cookie); rec.Code != http.StatusBadRequest {
		t.Errorf("progress unlinked: got %d, want 400", rec.Code)
	}
	// suggestions without linked account: connected=false, no error
	rec = doReq(mux, "GET", "/api/anilist/suggestions", "", cookie)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"connected":false`) {
		t.Errorf("suggestions unlinked: %d %s", rec.Code, rec.Body)
	}
}

// The shared bearer must be a token AniList still honours: an expired account
// is skipped (the choice is stable, not whichever row the engine returns), and
// with none left the client goes anonymous.
func TestAnilistTokenSkipsExpiredAccounts(t *testing.T) {
	t.Setenv("ANILIST_TOKEN", "")
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 0), ('b@example.com', 0)`)
	old, _ := secret.Encrypt("expired-tok")
	good, _ := secret.Encrypt("good-tok")
	past := time.Now().UTC().Add(-time.Hour).Format(sqliteTime)
	future := time.Now().UTC().Add(time.Hour).Format(sqliteTime)
	d.Exec(`INSERT INTO anilist_accounts (user_id, anilist_user_id, token_enc, expires_at) VALUES (1, 11, ?, ?)`, old, past)
	d.Exec(`INSERT INTO anilist_accounts (user_id, anilist_user_id, token_enc, expires_at) VALUES (2, 22, ?, ?)`, good, future)
	if got := s.AnilistToken(); got != "good-tok" {
		t.Fatalf("token = %q, want the unexpired account's", got)
	}
	d.Exec(`UPDATE anilist_accounts SET expires_at = ? WHERE user_id = 2`, past)
	if got := s.AnilistToken(); got != "" {
		t.Fatalf("token = %q, want anonymous when every account expired", got)
	}
	// no known expiry stays usable
	d.Exec(`UPDATE anilist_accounts SET expires_at = '' WHERE user_id = 2`)
	if got := s.AnilistToken(); got != "good-tok" {
		t.Fatalf("token = %q, want the account without a recorded expiry", got)
	}
}

func jsonHas(b []byte, sub string) bool {
	return strings.Contains(string(b), sub)
}
