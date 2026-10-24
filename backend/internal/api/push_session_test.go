package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/secret"
)

// A push subscription belongs to the browser session that made it: logging
// out, or ending that session from the list, takes the subscription with it,
// so the notifications (a "new sign-in" notice among them) stop reaching a
// browser the account has left. Other sessions' subscriptions stay.
func TestPushSubscriptionEndsWithItsSession(t *testing.T) {
	dir := t.TempDir()
	if err := secret.Init(dir); err != nil {
		t.Fatal(err)
	}
	d := dbtest.OpenAt(t, filepath.Join(dir, "test.db"))
	p, err := push.New(d)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d, Push: p, OIDC: auth.NewManager(context.Background(), d)})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1, 'a@example.com', 1)`)
	login := func() *http.Cookie {
		t.Helper()
		rec := httptest.NewRecorder()
		if err := auth.CreateSession(d, rec, httptest.NewRequest("POST", "/", nil), 1, true); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0]
	}
	subscribe := func(c *http.Cookie, name string) {
		t.Helper()
		body := `{"endpoint":"https://8.8.8.8/push/` + name + `","keys":{"p256dh":"k","auth":"a"}}`
		if rec := doReq(mux, "POST", "/api/push/subscribe", body, c); rec.Code != http.StatusCreated {
			t.Fatalf("subscribe %s: %d %s", name, rec.Code, rec.Body)
		}
	}
	subs := func() map[string]bool {
		t.Helper()
		rows, err := d.Query(`SELECT endpoint FROM push_subscriptions`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		defer func() {
			if err := rows.Err(); err != nil {
				t.Error(err)
			}
		}()
		got := map[string]bool{}
		for rows.Next() {
			var e string
			rows.Scan(&e)
			got[e[len("https://8.8.8.8/push/"):]] = true
		}
		return got
	}
	want := func(names ...string) {
		t.Helper()
		got := subs()
		if len(got) != len(names) {
			t.Fatalf("subscriptions = %v, want %v", got, names)
		}
		for _, n := range names {
			if !got[n] {
				t.Fatalf("subscriptions = %v, want %v", got, names)
			}
		}
	}

	// logout
	a, b := login(), login()
	subscribe(a, "a")
	subscribe(b, "b")
	rec := doReq(mux, "POST", "/api/auth/logout", "", a)
	if rec.Code != http.StatusOK {
		t.Fatalf("logout: %d", rec.Code)
	}
	if got := rec.Header().Get("Clear-Site-Data"); got != "" {
		t.Errorf("Clear-Site-Data = %q, want none (it would wipe theme and language)", got)
	}
	want("b")

	// ending another session from the list
	c := login()
	subscribe(c, "c")
	var id string
	for _, x := range sessionList(t, mux, c) {
		if !x.Current && x.ID != "" {
			if r := doReq(mux, "DELETE", "/api/auth/sessions/"+x.ID, "", c); r.Code != http.StatusOK {
				t.Fatalf("end session: %d", r.Code)
			}
			id = x.ID
			break
		}
	}
	if id == "" {
		t.Fatal("no other session listed")
	}
	want("c")

	// ending all others
	e, f := login(), login()
	subscribe(e, "e")
	subscribe(f, "f")
	if r := doReq(mux, "DELETE", "/api/auth/sessions/others", "", e); r.Code != http.StatusOK {
		t.Fatalf("end others: %d", r.Code)
	}
	want("e")
}

func sessionList(t *testing.T, mux *http.ServeMux, c *http.Cookie) []sessionInfo {
	t.Helper()
	var out []sessionInfo
	rec := doReq(mux, "GET", "/api/auth/sessions", "", c)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A password change ends every other session and the idle/expiry sweep ends
// stale ones; the subscriptions made in them go too, the kept session's stays.
func TestPushSubscriptionEndsWithPasswordChangeAndSweep(t *testing.T) {
	dir := t.TempDir()
	if err := secret.Init(dir); err != nil {
		t.Fatal(err)
	}
	d := dbtest.OpenAt(t, filepath.Join(dir, "test.db"))
	p, err := push.New(d)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d, Push: p})
	d.Exec(`INSERT INTO users (id, email) VALUES (1, 'a@example.com')`)
	login := func(name string) string {
		t.Helper()
		rec := httptest.NewRecorder()
		if err := auth.CreateSession(d, rec, httptest.NewRequest("POST", "/", nil), 1, true); err != nil {
			t.Fatal(err)
		}
		tok := rec.Result().Cookies()[0].Value
		if err := p.Subscribe(1, "https://8.8.8.8/push/"+name, "k", "a", auth.TokenHash(tok)); err != nil {
			t.Fatal(err)
		}
		return tok
	}
	count := func() (n int) {
		d.QueryRow(`SELECT COUNT(*) FROM push_subscriptions`).Scan(&n)
		return
	}

	keep := login("keep")
	login("other")
	if err := auth.SetPassword(d, 1, "a-long-unique-passphrase-9371", keep); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatalf("after a password change %d subscriptions, want only the kept session's", count())
	}

	if _, err := d.Exec(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	s.expireAuthRows()
	if count() != 0 {
		t.Fatalf("after the sweep %d subscriptions, want none", count())
	}
}
