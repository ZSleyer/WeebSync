package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A mail server login without encryption is refused when it is saved, not
// with a cryptic error at the first send; a relay on this machine may.
func TestSmtpLoginNeedsEncryption(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	rec := doReq(mux, "PUT", "/api/settings", `{"smtpHost":"mail.example.com","smtpUsername":"me","smtpSecurity":"none"}`, adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "STARTTLS or TLS") {
		t.Errorf("login without TLS to a remote relay: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/settings", `{"smtpHost":"localhost","smtpUsername":"me","smtpSecurity":"none"}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("local relay: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/settings", `{"smtpHost":"mail.example.com","smtpUsername":"me","smtpSecurity":"starttls"}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("STARTTLS: %d %s", rec.Code, rec.Body)
	}
}
