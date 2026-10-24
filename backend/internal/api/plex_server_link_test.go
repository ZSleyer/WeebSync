package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/secret"
)

// With PLEX_URL/PLEX_TOKEN set in the environment, the sign-in used to write
// another server into the database and answer "connected", while every Plex
// feature kept talking to the env server - until the env var was removed one
// day and the connection jumped. The settings route already refuses that.
func TestPlexServerSignInRespectsEnvLock(t *testing.T) {
	t.Setenv("PLEX_URL", "http://plex.example.com:32400")
	t.Setenv("PLEX_TOKEN", "env-token")
	status, body := http.StatusOK, `{"id":1,"code":"ABCD"}` // plex.tv, should anything ask it
	plexTVFake(t, &status, &body)
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1, 'a@example.com', 1)`)
	ck := cookieForUser(t, d, 1)

	// a finished sign-in whose server would answer
	plexSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"machineIdentifier":"m1"}}`))
	}))
	defer plexSrv.Close()
	var res plex.Resource
	if err := json.Unmarshal([]byte(`{"name":"Other","clientIdentifier":"m1","accessToken":"tok",
		"connections":[{"uri":"`+plexSrv.URL+`","local":true}]}`), &res); err != nil {
		t.Fatal(err)
	}
	rememberLinkFlow(plexServerFlow, "7", 1)
	plexServerSignins.Lock()
	plexServerSignins.m["7"] = plexServerSignin{expires: time.Now().Add(time.Minute), servers: []plex.Resource{res}}
	plexServerSignins.Unlock()
	t.Cleanup(func() {
		plexServerSignins.Lock()
		delete(plexServerSignins.m, "7")
		plexServerSignins.Unlock()
		forgetLinkFlow(plexServerFlow, "7")
	})

	post := func(path, body string) int {
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := post("/api/plex/server/connect", `{"id":"7","server":"m1"}`); code != http.StatusConflict {
		t.Errorf("connect with env-locked Plex: %d, want 409", code)
	}
	for _, k := range []string{"plex_url", "plex_token", "plex_auth", "plex_server_name"} {
		if v := db.Setting(d, k); v != "" {
			t.Errorf("%s was written although the connection is set by the environment: %q", k, v)
		}
	}
	// nor is a sign-in started that could not be used
	if code := post("/api/plex/server/link/start", `{}`); code != http.StatusConflict {
		t.Errorf("start with env-locked Plex: %d, want 409", code)
	}

	// without the env vars the same sign-in connects, the token stored sealed
	os.Unsetenv("PLEX_URL")
	os.Unsetenv("PLEX_TOKEN")
	if code := post("/api/plex/server/connect", `{"id":"7","server":"m1"}`); code != http.StatusOK {
		t.Fatalf("connect: %d, want 200", code)
	}
	if db.Setting(d, "plex_url") != plexSrv.URL || db.Setting(d, "plex_auth") != "signin" {
		t.Error("the chosen server was not stored")
	}
	if tok := secret.SettingOrEnv(d, "plex_token", "PLEX_TOKEN"); tok != "tok" {
		t.Errorf("stored token reads %q, want the server's token", tok)
	}
}
