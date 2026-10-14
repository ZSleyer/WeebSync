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
