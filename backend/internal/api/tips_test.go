package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func dismissedTips(t *testing.T, rec interface{ Bytes() []byte }) []string {
	t.Helper()
	var out TipsResponse
	if err := json.Unmarshal(rec.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Dismissed
}

func TestTips(t *testing.T) {
	mux, s, adminC, userC, _, userID := setupUsersTest(t)

	rec := doReq(mux, "GET", "/api/auth/tips", "", userC)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d: %s", rec.Code, rec.Body)
	}
	// an empty list is [], not null: the frontend types it as string[]
	if got := strings.TrimSpace(rec.Body.String()); got != `{"dismissed":[]}` {
		t.Errorf("empty list: %s", got)
	}

	for _, bad := range []string{`{"key":""}`, `{"key":"Install-PWA"}`, `{"key":"a b"}`, `{"key":"../x"}`,
		`{"key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`} {
		if rec := doReq(mux, "POST", "/api/auth/tips/dismiss", bad, userC); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", bad, rec.Code)
		}
	}

	// dismissing twice is no error and keeps one row
	for range 2 {
		if rec := doReq(mux, "POST", "/api/auth/tips/dismiss", `{"key":"install-pwa"}`, userC); rec.Code != http.StatusOK {
			t.Fatalf("dismiss: got %d: %s", rec.Code, rec.Body)
		}
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM user_tips WHERE user_id = ?`, userID).Scan(&n)
	if n != 1 {
		t.Errorf("rows after a repeated dismiss: %d, want 1", n)
	}
	doReq(mux, "POST", "/api/auth/tips/dismiss", `{"key":"mobile-ui"}`, userC)

	if got := dismissedTips(t, doReq(mux, "GET", "/api/auth/tips", "", userC).Body); !slices.Equal(got, []string{"install-pwa", "mobile-ui"}) {
		t.Errorf("user's tips: %v", got)
	}
	// another account sees none of them
	if got := dismissedTips(t, doReq(mux, "GET", "/api/auth/tips", "", adminC).Body); len(got) != 0 {
		t.Errorf("admin sees the user's tips: %v", got)
	}
}

func TestTipsGuards(t *testing.T) {
	mux, _, _, userC, _, _ := setupUsersTest(t)
	if rec := doReq(mux, "GET", "/api/auth/tips", "", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("list without a session: got %d, want 401", rec.Code)
	}
	if rec := doReq(mux, "POST", "/api/auth/tips/dismiss", `{"key":"mobile-ui"}`, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("dismiss without a session: got %d, want 401", rec.Code)
	}
	// a cross-site form cannot send JSON; the content-type check stops it
	req := httptest.NewRequest("POST", "/api/auth/tips/dismiss", strings.NewReader(`key=mobile-ui`))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(userC)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form-encoded dismiss: got %d, want 415", rec.Code)
	}
}
