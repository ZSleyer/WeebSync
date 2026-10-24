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
