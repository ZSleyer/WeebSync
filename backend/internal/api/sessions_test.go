package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The account sees its own sessions with the current one marked, can end
// another one but not the current one, and can end all others at once; a
// second account's sessions are never listed or touched.
func TestSessions(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1, 'a@example.com', 1), (2, 'b@example.com', 0)`)
	login := func(id int64, ua string) *http.Cookie {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", nil)
		req.Header.Set("User-Agent", ua)
		if err := auth.CreateSession(d, rec, req, id, true); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0]
	}
	me := login(1, "Firefox desktop")
	login(1, "Chrome phone")
	login(1, "Chrome tablet")
	login(2, "someone else")

	list := func() []sessionInfo {
		t.Helper()
		rec := doReq(mux, "GET", "/api/auth/sessions", "", me)
		var out []sessionInfo
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	got := list()
	if len(got) != 3 {
		t.Fatalf("listed %d sessions, want the 3 of this account", len(got))
	}
	var current, other sessionInfo
	for _, x := range got {
		if x.Current {
			current = x
		} else if other.ID == "" {
			other = x
		}
		if x.CreatedAt == "" || x.UserAgent == "" {
			t.Errorf("session %+v lacks its start or browser", x)
		}
	}
	if current.UserAgent != "Firefox desktop" {
		t.Errorf("current = %+v, want the Firefox one", current)
	}
	if rec := doReq(mux, "DELETE", "/api/auth/sessions/"+current.ID, "", me); rec.Code != http.StatusNotFound {
		t.Errorf("ending the current session: %d, want 404 (that is logout)", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/auth/sessions/nothex", "", me); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id: %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/auth/sessions/"+other.ID, "", me); rec.Code != http.StatusOK {
		t.Fatalf("ending another session: %d %s", rec.Code, rec.Body)
	}
	if n := len(list()); n != 2 {
		t.Errorf("after ending one: %d sessions, want 2", n)
	}
	rec := doReq(mux, "DELETE", "/api/auth/sessions/others", "", me)
	var ended sessionsEndedResponse
	json.Unmarshal(rec.Body.Bytes(), &ended)
	if ended.Ended != 1 || len(list()) != 1 {
		t.Errorf("end others: ended %d, left %d; want 1 and 1", ended.Ended, len(list()))
	}
	var b int
	d.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = 2`).Scan(&b)
	if b != 1 {
		t.Errorf("the other account has %d sessions, want its 1 untouched", b)
	}
}
