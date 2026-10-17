package api

import (
	"errors"
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A failed ownership lookup used to read as "owned == 0" and answer 404, so a
// broken database looked like a missing server or watch.
func TestOwnershipLookupFailureIs500(t *testing.T) {
	d := dbtest.Open(t)
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{
		DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, t.TempDir()),
	}
	drainJobsAtCleanup(t, s)
	mux := http.NewServeMux()
	s.Register(mux)
	if _, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	cookie := cookieForUser(t, d, 1)

	if _, err := d.Exec(`DROP TABLE servers`); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "GET", "/api/servers/1/rename-profile", "", cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("rename-profile: got %d, want 500: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("create: got %d, want 500: %s", rec.Code, rec.Body)
	}

	if _, err := d.Exec(`DROP TABLE watches`); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "POST", "/api/watches/1/check", "", cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("check: got %d, want 500: %s", rec.Code, rec.Body)
	}
}

// A settings write that fails must reach the caller: the connect handlers
// answer 500 instead of "connected" with a server half stored.
func TestSaveSettingsStopsOnFailure(t *testing.T) {
	d := dbtest.Open(t)
	if err := saveSettings(d, "k1", "v1", "k2", "v2"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`DROP TABLE settings`); err != nil {
		t.Fatal(err)
	}
	if err := saveSettings(d, "k1", "v1", "k2", "v2"); err == nil {
		t.Fatal("want the write error")
	}
}
