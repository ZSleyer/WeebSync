package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func logoutReq(mux *http.ServeMux, c *http.Cookie, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/auth/logout", strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(c)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}

func pushRows(t *testing.T, s *Server) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM push_subscriptions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A subscription from before the session column (an empty session_hash) is not
// removed by the session trigger, and the client's own DELETE may land after
// the session ended. So logout takes the endpoint along and drops that
// user's row itself.
func TestLogoutDropsLegacyPushSubscriptionByEndpoint(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	add := func(endpoint string, user int64) {
		if _, err := s.DB.Exec(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash) VALUES (?, ?, 'k', 'a', '')`, endpoint, user); err != nil {
			t.Fatal(err)
		}
	}
	add("https://push.example/mine", userID)
	add("https://push.example/other", userID)
	add("https://push.example/foreign", 1)

	if out := logoutReq(mux, userC, `{"endpoint":"https://push.example/mine"}`); out.Code != http.StatusOK {
		t.Fatalf("logout = %d %s", out.Code, out.Body)
	}
	var left []string
	rows, _ := s.DB.Query(`SELECT endpoint FROM push_subscriptions ORDER BY endpoint`)
	defer rows.Close()
	for rows.Next() {
		var e string
		rows.Scan(&e)
		left = append(left, e)
	}
	if strings.Join(left, ",") != "https://push.example/foreign,https://push.example/other" {
		t.Errorf("rows left = %v, want only the other and the foreign one", left)
	}
}

func TestLogoutWithoutBodyStillWorks(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash) VALUES ('https://push.example/x', ?, 'k', 'a', '')`, userID)
	if out := logoutReq(mux, userC, ""); out.Code != http.StatusOK {
		t.Fatalf("logout without body = %d %s", out.Code, out.Body)
	}
	if n := pushRows(t, s); n != 1 {
		t.Errorf("rows = %d, want the untouched 1", n)
	}
	if out := logoutReq(mux, userC, `{"endpoint":`); out.Code != http.StatusOK {
		t.Errorf("logout with a broken body = %d, want 200", out.Code)
	}
}
