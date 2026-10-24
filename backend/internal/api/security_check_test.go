package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// A badly set up instance shows what to fix, worst first; a non-admin sees
// nothing of it.
func TestSecurityCheck(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, adminC, userC, _, _ := setupUsersTest(t)
	if rec := doReq(mux, "GET", "/api/admin/security-check", "", userC); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin: %d", rec.Code)
	}
	db.SetSetting(s.DB, "base_url", "http://weebsync.example.com")
	db.SetSetting(s.DB, "registration_disabled", "false")
	db.SetSetting(s.DB, "trusted_networks", "0.0.0.0/0")
	db.SetSetting(s.DB, "smtp_host", "mail.example.com")
	db.SetSetting(s.DB, "smtp_security", "none")
	setSecretSetting(s.DB, "smtp_password", "hunter2hunter2")
	s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc) VALUES (1, 'old', 'ftp', 'ftp.example.com', 21, 'u', x'00')`)
	s.DB.Exec(`UPDATE users SET password_hash = 'x' WHERE is_admin = 1`)

	// reached over plain HTTP from the internet, through a proxy we do not trust
	req := httptest.NewRequest("GET", "/api/admin/security-check", nil)
	req.RemoteAddr = "203.0.113.5:4000"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	req.AddCookie(adminC)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var got []SecurityCheck
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	level := map[string]string{}
	for _, c := range got {
		level[c.ID] = c.Level
	}
	for id, want := range map[string]string{
		"https": "risk", "proxy_untrusted": "risk", "base_url": "risk", "trusted_networks_wide": "risk",
		"smtp_cleartext": "risk", "ftp_cleartext": "warn", "admin_single_factor": "warn", "registration_open": "info",
	} {
		if level[id] != want {
			t.Errorf("%s: got %q, want %q (all: %v)", id, level[id], want, level)
		}
	}
	if len(got) > 0 && got[0].Level != "risk" {
		t.Errorf("not worst first: %+v", got[0])
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Error("the review leaks a secret")
	}
}

func TestIsInternalURL(t *testing.T) {
	for raw, want := range map[string]bool{
		"http://homeassistant:8123/api/webhook/x": true,
		"http://a0d7b954-xyz:8123":                true,
		"http://192.168.178.5":                    true,
		"http://10.0.0.2:80":                      true,
		"http://172.30.32.1":                      true,
		"http://[fd0c:ac1e:2100::1]:8123":         true,
		"http://[fe80::1]":                        true,
		"http://100.100.1.1":                      true,
		"http://nas.local":                        true,
		"http://NAS.Local.":                       true,
		"http://ha.home.arpa":                     true,
		"http://x.lan":                            true,
		"http://x.internal":                       true,
		"http://x.localdomain":                    true,
		"http://localhost":                        true,
		"http://127.0.0.1":                        true,
		"http://[::1]":                            true,
		"http://example.com":                      false,
		"http://ha.example.org":                   false,
		"http://8.8.8.8":                          false,
		"http://100.128.0.1":                      false,
		"http://0.0.0.0":                          false,
		"http://[2001:db8::1]":                    false,
		"http://":                                 false,
	} {
		if got := isInternalURL(raw); got != want {
			t.Errorf("%s: got %v, want %v", raw, got, want)
		}
	}
}

// A service URL that stays inside the host's network is not a cleartext
// finding; one on a public name still is.
func TestSecurityCheckHAWebhookInternal(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	has := func(url string) bool {
		db.SetSetting(s.DB, "ha_webhook_url", url)
		rec := doReq(mux, "GET", "/api/admin/security-check", "", adminC)
		var got []SecurityCheck
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		for _, c := range got {
			if c.ID == "ha_webhook_http" {
				return true
			}
		}
		return false
	}
	if has("http://homeassistant:8123/api/webhook/x") {
		t.Error("service name flagged")
	}
	if !has("http://ha.example.com/api/webhook/x") {
		t.Error("public host not flagged")
	}
}

// The OIDC issuer is where the browser sends the user's own login, over any
// network it is on, so an internal name is no excuse there; Plex is a call of
// this server and fine on one.
func TestSecurityCheckOIDCStaysStrict(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OIDC_ISSUER", "http://auth.lan/application/o/weebsync/")
	t.Setenv("OIDC_CLIENT_SECRET", "s")
	t.Setenv("PLEX_URL", "http://plex:32400")
	t.Setenv("PLEX_TOKEN", "t")
	mux, _, adminC, _, _, _ := setupUsersTest(t)
	rec := doReq(mux, "GET", "/api/admin/security-check", "", adminC)
	var got []SecurityCheck
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	ids := map[string]bool{}
	for _, c := range got {
		ids[c.ID] = true
	}
	if !ids["oidc_http"] || ids["plex_http"] {
		t.Errorf("oidc_http %v (want true), plex_http %v (want false)", ids["oidc_http"], ids["plex_http"])
	}
}

// A count that cannot be read is an error, not a passed check: the admin
// must not see "ok" for something nobody looked at.
func TestSecurityCheckFailedCountIsNoPass(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.DB.Exec(`UPDATE users SET password_hash = 'x' WHERE is_admin = 1`)
	// only the count of admins without a second factor reads this table
	if _, err := s.DB.Exec(`DROP TABLE user_totp`); err != nil {
		t.Fatal(err)
	}
	rec := doReq(mux, "GET", "/api/admin/security-check", "", adminC)
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "admin_single_factor") {
		t.Fatalf("failed count: %d %s", rec.Code, rec.Body)
	}
}
