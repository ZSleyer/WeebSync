package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestTr(t *testing.T) {
	if got := tr("de", "push.downloadDone"); got != "Download fertig" {
		t.Errorf("de: got %q", got)
	}
	if got := tr("en", "push.downloadDone"); got != "Download finished" {
		t.Errorf("en: got %q", got)
	}
	if got := tr("fr", "push.downloadDone"); got != "Download finished" {
		t.Errorf("fallback: got %q", got)
	}
	if got := tr("en", "email.downloadDoneMany", 3); got != "3 downloads finished" {
		t.Errorf("args: got %q", got)
	}
	if got := tr("en", "no.such.key"); got != "no.such.key" {
		t.Errorf("missing key: got %q", got)
	}
}

func TestLocalePut(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)

	if rec := doReq(mux, "PUT", "/api/auth/locale", `{"locale":"de"}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("put locale: got %d: %s", rec.Code, rec.Body.String())
	}
	if got := s.userLocale(userID); got != "de" {
		t.Errorf("stored locale: got %q, want de", got)
	}
	if rec := doReq(mux, "PUT", "/api/auth/locale", `{"locale":"xx"}`, userC); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid locale: got %d, want 400", rec.Code)
	}
	// unknown/empty stays english
	if got := s.userLocale(99999); got != "en" {
		t.Errorf("missing user: got %q, want en", got)
	}
	if rec := doReq(mux, "PUT", "/api/auth/locale", `{"locale":"de"}`, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("unauth: got %d, want 401", rec.Code)
	}
}

func TestRegisterStoresLocale(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)

	rec := doReq(mux, "POST", "/api/auth/register", `{"email":"neu@example.com","password":"longpassword12","locale":"de"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: got %d: %s", rec.Code, rec.Body.String())
	}
	var id int64
	if err := s.DB.QueryRow(`SELECT id FROM users WHERE email = 'neu@example.com'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if got := s.userLocale(id); got != "de" {
		t.Errorf("register locale: got %q, want de", got)
	}
	// invalid locale is dropped, not rejected
	rec = doReq(mux, "POST", "/api/auth/register", `{"email":"neu2@example.com","password":"longpassword12","locale":"xx"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register invalid locale: got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "neu2@example.com") {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}
