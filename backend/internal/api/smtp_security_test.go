package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// An unknown security value used to mean a send without encryption.
func TestSmtpUnknownSecurityRefused(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	for _, v := range []string{"plain", "ssl", "STARTTLS"} {
		body := `{"smtpHost":"mail.example.com","smtpSecurity":"` + v + `"}`
		if rec := doReq(mux, "PUT", "/api/settings", body, adminC); rec.Code != http.StatusBadRequest {
			t.Errorf("smtpSecurity %q: %d %s, want 400", v, rec.Code, rec.Body)
		}
	}
}
