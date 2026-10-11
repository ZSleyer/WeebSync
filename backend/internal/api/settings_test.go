package api

import (
	"context"
	"encoding/json"
	"net/http"
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
	mux, s, adminC, _, _, _ := setupUsersTest(t)
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

	st.HaWebhookURL = "http://169.254.169.254/api/webhook/x"
	body, _ = json.Marshal(st)
	rec = doReq(mux, "PUT", "/api/settings", string(body), adminC)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "haWebhookUrl:") {
		t.Errorf("changed blocked URL: got %d %s, want 400 naming haWebhookUrl", rec.Code, rec.Body)
	}
}
