package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A stored outbound URL that fails the guard now (here a link-local literal,
// in practice a host that stopped resolving) must not block saving the rest of
// the form; it is reported on its field instead. A changed one still fails.
func TestSettingsPutSkipsUnchangedBrokenURL(t *testing.T) {
	mux, s, adminC, _, adminID, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	db.SetSetting(s.DB, "ai_search_url", "http://169.254.169.254")

	rec := doReq(mux, "GET", "/api/settings", "", adminC)
	var st settingsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("get: %d %s", rec.Code, rec.Body)
	}
	if st.FieldIssues["aiSearchUrl"] == "" {
		t.Errorf("fieldIssues: got %v, want aiSearchUrl flagged", st.FieldIssues)
	}

	st.ForceHTTPS = !st.ForceHTTPS // an unrelated edit on another page
	body, _ := json.Marshal(st)
	if rec := doReq(mux, "PUT", "/api/settings", string(body), adminC); rec.Code != http.StatusOK {
		t.Fatalf("unchanged broken URL blocked the save: %d %s", rec.Code, rec.Body)
	}
	// force-https now holds: a session made over plain HTTP since the
	// host-prefixed cookie came in is not carried over, so sign in again
	srec := httptest.NewRecorder()
	if err := auth.CreateSession(s.DB, srec, httptest.NewRequest("POST", "/api/auth/login", nil), adminID, true); err != nil {
		t.Fatal(err)
	}
	adminC = srec.Result().Cookies()[0]

	st.HaWebhookURL = "http://169.254.169.254/api/webhook/x"
	body, _ = json.Marshal(st)
	rec = doReq(mux, "PUT", "/api/settings", string(body), adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "haWebhookUrl:") {
		t.Errorf("changed blocked URL: got %d %s, want 400 naming haWebhookUrl", rec.Code, rec.Body)
	}
}

// A refused save writes nothing: before, every field written ahead of the
// failing check stayed saved.
func TestSettingsPutRefusedWritesNothing(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())

	rec := doReq(mux, "PUT", "/api/settings",
		`{"maxConcurrent":9,"baseUrl":"https://example.com","trustedNetworks":"nope!!"}`, adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "trustedNetworks:") {
		t.Fatalf("got %d %s, want 400 naming trustedNetworks", rec.Code, rec.Body)
	}
	if v := db.Setting(s.DB, "max_concurrent"); v != "" {
		t.Errorf("max_concurrent = %q after a refused save", v)
	}
	if v := db.Setting(s.DB, "base_url"); v != "" {
		t.Errorf("base_url = %q after a refused save", v)
	}
}

// A save carries only what its page changed: the rest keeps its value, and a
// stored value that would fail its check now does not block it.
func TestSettingsPutPartial(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	db.SetSetting(s.DB, "smtp_from", "Just A Name") // invalid, but stored before
	db.SetSetting(s.DB, "plex_url", "http://plex.example.com")

	if rec := doReq(mux, "PUT", "/api/settings", `{"maxConcurrent":5}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("partial save: %d %s", rec.Code, rec.Body)
	}
	if v := db.Setting(s.DB, "max_concurrent"); v != "5" {
		t.Errorf("max_concurrent = %q, want 5", v)
	}
	if v := db.Setting(s.DB, "plex_url"); v != "http://plex.example.com" {
		t.Errorf("plex_url = %q, an omitted field changed", v)
	}
	if v := db.Setting(s.DB, "smtp_from"); v != "Just A Name" {
		t.Errorf("smtp_from = %q, an omitted field changed", v)
	}
	rec := doReq(mux, "PUT", "/api/settings", `{"smtpPort":70000}`, adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "smtpPort:") {
		t.Errorf("smtp port 70000: got %d %s, want 400", rec.Code, rec.Body)
	}
}

// An OIDC allowlist names values of a claim: without the claim it filters
// nobody, and the admin who set it would rely on a gate that is not there.
func TestSettingsPutRefusesAllowlistWithoutClaim(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())

	rec := doReq(mux, "PUT", "/api/settings", `{"oidcUserValues":"family","oidcClaim":""}`, adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "oidcClaim:") {
		t.Fatalf("allowlist without claim: %d %s", rec.Code, rec.Body)
	}
	if v := db.Setting(s.DB, "oidc_user_values"); v != "" {
		t.Errorf("refused allowlist stored: %q", v)
	}
	if rec := doReq(mux, "PUT", "/api/settings", `{"oidcUserValues":"family","oidcClaim":"groups"}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("allowlist with claim: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/settings", `{"oidcClaim":" "}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("claim cleared under a stored allowlist: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/settings", `{"oidcUserValues":"","oidcClaim":""}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("both cleared: %d %s", rec.Code, rec.Body)
	}
}

// A stored plex_url with a trailing slash (typed, or written by the Plex link
// flow) that fails the guard now must not block an unrelated save, and the
// value is stored trimmed like the other URLs.
func TestSettingsPutTrailingSlashPlexURL(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	db.SetSetting(s.DB, "plex_url", "http://169.254.169.254:32400/")

	if rec := doReq(mux, "PUT", "/api/settings", `{"maxConcurrent":5}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("unrelated save blocked by the stored plex_url: %d %s", rec.Code, rec.Body)
	}
	if v := db.Setting(s.DB, "plex_url"); v != "http://169.254.169.254:32400" {
		t.Errorf("plex_url = %q, want the trimmed value", v)
	}
	rec := doReq(mux, "PUT", "/api/settings", `{"plexUrl":"http://169.254.169.254:32401/"}`, adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "plexUrl:") {
		t.Errorf("changed blocked plexUrl: got %d %s, want 400", rec.Code, rec.Body)
	}
}
