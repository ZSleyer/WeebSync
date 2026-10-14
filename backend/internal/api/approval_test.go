package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// A self-registered account waits for an admin, open registration or not:
// no session at registration, none at sign-in, none from a session that
// somehow exists, until an admin approves it.
func TestSelfRegisteredAccountWaitsForApproval(t *testing.T) {
	mux, s, adminC, userC, _, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "registration_disabled", "false")

	rec := doReq(mux, "POST", "/api/auth/register", `{"email":"neu@example.com","password":"a long new passphrase"}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"needsApproval":true`) || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("register: %d %s cookies=%d", rec.Code, rec.Body, len(rec.Result().Cookies()))
	}
	login := `{"email":"neu@example.com","password":"a long new passphrase"}`
	if rec := doReq(mux, "POST", "/api/auth/login", login, nil); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "awaits approval") {
		t.Fatalf("login before approval: %d %s", rec.Code, rec.Body)
	}
	var id int64
	s.DB.QueryRow(`SELECT id FROM users WHERE email = 'neu@example.com'`).Scan(&id)
	// a session row for it (from before a revocation, say) is no way in
	r := httptest.NewRecorder()
	if err := auth.CreateSession(s.DB, r, httptest.NewRequest("GET", "/", nil), id, false); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "GET", "/api/auth/me", "", r.Result().Cookies()[0]); rec.Code != http.StatusUnauthorized {
		t.Errorf("session of an unapproved account: %d", rec.Code)
	}

	list := doReq(mux, "GET", "/api/users", "", adminC).Body.String()
	if !strings.Contains(list, `"email":"neu@example.com"`) || !strings.Contains(list, `"approved":false`) {
		t.Errorf("admin list does not show the pending account: %s", list)
	}
	approve := "/api/users/" + strconv.FormatInt(id, 10) + "/approve"
	if rec := doReq(mux, "POST", approve, "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin approved an account: %d", rec.Code)
	}
	if rec := doReq(mux, "POST", approve, "", adminC); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/auth/login", login, nil); rec.Code != http.StatusOK {
		t.Errorf("login after approval: %d %s", rec.Code, rec.Body)
	}

	// an account an admin creates needs no approval
	if rec := doReq(mux, "POST", "/api/users", `{"email":"made@example.com","password":"an admin made this one"}`, adminC); rec.Code != http.StatusCreated {
		t.Fatalf("admin create: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"made@example.com","password":"an admin made this one"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("admin-made account: %d %s", rec.Code, rec.Body)
	}
}
