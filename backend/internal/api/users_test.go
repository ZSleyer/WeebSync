package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

func setupUsersTest(t *testing.T) (*http.ServeMux, *Server, *http.Cookie, *http.Cookie, int64, int64) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	res, _ := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('admin@example.com', 1)`)
	adminID, _ := res.LastInsertId()
	res, _ = d.Exec(`INSERT INTO users (email, is_admin) VALUES ('user@example.com', 0)`)
	userID, _ := res.LastInsertId()

	cookieFor := func(id int64) *http.Cookie {
		rec := httptest.NewRecorder()
		if err := auth.CreateSession(d, rec, httptest.NewRequest("GET", "/", nil), id); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0]
	}

	s := &Server{DB: d}
	mux := http.NewServeMux()
	s.Register(mux)
	return mux, s, cookieFor(adminID), cookieFor(userID), adminID, userID
}

func doReq(mux *http.ServeMux, method, path, body string, c *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestUserGuards(t *testing.T) {
	mux, _, adminC, userC, adminID, userID := setupUsersTest(t)

	// non-admin gets 403
	if rec := doReq(mux, "GET", "/api/users", "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin list: got %d, want 403", rec.Code)
	}
	// self-delete blocked
	if rec := doReq(mux, "DELETE", fmt.Sprintf("/api/users/%d", adminID), "", adminC); rec.Code != http.StatusConflict {
		t.Errorf("self-delete: got %d, want 409", rec.Code)
	}
	// demoting the last admin blocked
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/users/%d", adminID), `{"isAdmin":false}`, adminC); rec.Code != http.StatusConflict {
		t.Errorf("demote last admin: got %d, want 409", rec.Code)
	}
	// promote works
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/users/%d", userID), `{"isAdmin":true}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("promote: got %d, want 200: %s", rec.Code, rec.Body)
	}
	// with a second admin, demoting the first is allowed
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/users/%d", adminID), `{"isAdmin":false}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("demote with second admin: got %d, want 200: %s", rec.Code, rec.Body)
	}
	// demote takes effect immediately: former admin now gets 403
	if rec := doReq(mux, "GET", "/api/users", "", adminC); rec.Code != http.StatusForbidden {
		t.Errorf("demoted admin list: got %d, want 403", rec.Code)
	}
	// deleting the now-last admin blocked (userC is admin now)
	if rec := doReq(mux, "DELETE", fmt.Sprintf("/api/users/%d", userID), "", userC); rec.Code != http.StatusConflict {
		t.Errorf("delete last admin: got %d, want 409", rec.Code)
	}
	// deleting a normal user works
	if rec := doReq(mux, "DELETE", fmt.Sprintf("/api/users/%d", adminID), "", userC); rec.Code != http.StatusOK {
		t.Errorf("delete normal user: got %d, want 200: %s", rec.Code, rec.Body)
	}
}

func TestUserUpdateOIDCManaged(t *testing.T) {
	mux, s, adminC, _, _, userID := setupUsersTest(t)

	// OIDC group mapping active → local role changes rejected
	if err := db.SetSetting(s.DB, "oidc_admin_values", "weebsync-admins"); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/users/%d", userID), `{"isAdmin":true}`, adminC); rec.Code != http.StatusConflict {
		t.Errorf("oidc-managed promote: got %d, want 409: %s", rec.Code, rec.Body)
	}
	// cleared → toggle works again
	if err := db.SetSetting(s.DB, "oidc_admin_values", ""); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/users/%d", userID), `{"isAdmin":true}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("promote after clear: got %d, want 200: %s", rec.Code, rec.Body)
	}
}

func TestUserCreate(t *testing.T) {
	mux, _, adminC, _, _, _ := setupUsersTest(t)

	if rec := doReq(mux, "POST", "/api/users", `{"email":"new@example.com","password":"longenough123"}`, adminC); rec.Code != http.StatusCreated {
		t.Errorf("create: got %d, want 201: %s", rec.Code, rec.Body)
	}
	// duplicate email
	if rec := doReq(mux, "POST", "/api/users", `{"email":"new@example.com","password":"longenough123"}`, adminC); rec.Code != http.StatusConflict {
		t.Errorf("duplicate: got %d, want 409", rec.Code)
	}
	// weak password
	if rec := doReq(mux, "POST", "/api/users", `{"email":"weak@example.com","password":"short"}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("weak password: got %d, want 400", rec.Code)
	}
}
