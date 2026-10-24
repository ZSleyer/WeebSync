package api

import (
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/push"
)

func setupPushTest(t *testing.T) (*http.ServeMux, *Server, *http.Cookie) {
	t.Helper()
	mux, s, c := setupAiTest(t, nil)
	s.Push = &push.Service{DB: s.DB}
	return mux, s, c
}

// A subscription whose keys cannot be encrypted for would answer 201 and then
// never receive a push; it is refused up front.
func TestPushSubscribeValidatesKeys(t *testing.T) {
	mux, s, c := setupPushTest(t)
	const (
		p256dh = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
		auth   = "BTBZMqHH6r4Tts7J_aSIgg"
	)
	body := func(p, a string) string {
		return `{"endpoint":"https://1.1.1.1/sub","keys":{"p256dh":"` + p + `","auth":"` + a + `"}}`
	}
	for _, bad := range [][2]string{{"garbage", auth}, {p256dh, "short"}} {
		if rec := doReq(mux, "POST", "/api/push/subscribe", body(bad[0], bad[1]), c); rec.Code != http.StatusBadRequest {
			t.Errorf("keys %q accepted: %d %s", bad, rec.Code, rec.Body)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM push_subscriptions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("unusable subscription stored: %d rows, %v", n, err)
	}
	if rec := doReq(mux, "POST", "/api/push/subscribe", body(p256dh, auth), c); rec.Code != http.StatusCreated {
		t.Fatalf("valid keys refused: %d %s", rec.Code, rec.Body)
	}
}

// An unsubscribe that did not reach the database must not answer "ok": the
// browser has already dropped its subscription, and the server would keep
// sending to the dead endpoint while the user sees push as off.
func TestPushUnsubscribeReportsDBError(t *testing.T) {
	mux, s, c := setupPushTest(t)
	const endpoint = "https://push.example.net/sub/1"
	if err := s.Push.Subscribe(1, endpoint, "k", "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`CREATE TRIGGER no_unsub BEFORE DELETE ON push_subscriptions
		BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	rec := doReq(mux, "DELETE", "/api/push/subscribe", `{"endpoint":"`+endpoint+`","keys":{"p256dh":"k","auth":"a"}}`, c)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unsubscribe with a failing delete: %d %s, want 500", rec.Code, rec.Body)
	}
}
