package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// The settings page marks a refused field by the "field: " prefix of the
// error. An unknown media server came back without one, so the form showed
// a bare error instead of marking the field.
func TestSettingsMediaServerErrorNamesTheField(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	rec := doReq(mux, "PUT", "/api/settings", `{"mediaServer":"kodi"}`, adminC)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown media server: %d %s", rec.Code, rec.Body)
	}
	var e ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Error != "mediaServer: must be plex or jellyfin" {
		t.Errorf("error = %q, want it prefixed with the field", e.Error)
	}
}
