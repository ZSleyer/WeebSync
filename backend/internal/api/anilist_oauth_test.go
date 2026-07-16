package api

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

func TestAnilistOAuthHandlers(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Anilist: anilist.New(d)}
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

func jsonHas(b []byte, sub string) bool {
	return strings.Contains(string(b), sub)
}
