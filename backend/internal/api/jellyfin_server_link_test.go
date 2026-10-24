package api

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// The Jellyfin sign-in wrote the server into the database past JELLYFIN_URL /
// JELLYFIN_TOKEN, like the Plex one did: "connected", while the instance kept
// using the env server.
func TestJellyfinServerSignInRespectsEnvLock(t *testing.T) {
	t.Setenv("JELLYFIN_URL", "http://jellyfin.example.com:8096")
	t.Setenv("JELLYFIN_TOKEN", "env-key")
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	jf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/QuickConnect/Connect":
			io.WriteString(w, `{"Authenticated":true}`)
		case "/Users/AuthenticateWithQuickConnect":
			io.WriteString(w, `{"AccessToken":"jftok","User":{"Id":"u1","Name":"Admin","Policy":{"IsAdministrator":true}}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer jf.Close()
	d := dbtest.Open(t)
	offline := func(userID, serverID int64) (remote.Client, string, error) { return nil, "", errors.New("offline") }
	s := testServer(t, &Server{DB: d, DownloadRoot: t.TempDir(), Transfers: transfer.NewManager(d, offline, t.TempDir())})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1, 'a@example.com', 1)`)
	ck := cookieForUser(t, d, 1)

	// a sign-in the administrator already confirmed in Jellyfin
	jellyfinSignins.Lock()
	jellyfinSignins.m["9"] = jellyfinSignin{url: jf.URL, secret: "s", expires: time.Now().Add(time.Minute)}
	jellyfinSignins.Unlock()
	rememberLinkFlow(jellyfinServerFlow, "9", 1)
	t.Cleanup(func() {
		jellyfinSignins.Lock()
		delete(jellyfinSignins.m, "9")
		jellyfinSignins.Unlock()
		forgetLinkFlow(jellyfinServerFlow, "9")
	})

	do := func(method, path, body string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := do("POST", "/api/jellyfin/server/link/start", `{"url":"`+jf.URL+`"}`); code != http.StatusConflict {
		t.Errorf("start with env-locked Jellyfin: %d, want 409", code)
	}
	if code := do("GET", "/api/jellyfin/server/link/poll?id=9", ""); code != http.StatusConflict {
		t.Errorf("poll with env-locked Jellyfin: %d, want 409", code)
	}
	for _, k := range []string{"jellyfin_url", "jellyfin_token", "jellyfin_auth"} {
		if v := db.Setting(d, k); v != "" {
			t.Errorf("%s was written although the connection is set by the environment: %q", k, v)
		}
	}

	// without the env vars the confirmed sign-in connects, the token sealed
	os.Unsetenv("JELLYFIN_URL")
	os.Unsetenv("JELLYFIN_TOKEN")
	if code := do("GET", "/api/jellyfin/server/link/poll?id=9", ""); code != http.StatusOK {
		t.Fatalf("poll: %d, want 200", code)
	}
	if db.Setting(d, "jellyfin_url") != jf.URL || db.Setting(d, "jellyfin_auth") != "signin" {
		t.Error("the server was not stored")
	}
	if tok := secret.SettingOrEnv(d, "jellyfin_token", "JELLYFIN_TOKEN"); tok != "jftok" {
		t.Errorf("stored token reads %q", tok)
	}
}
