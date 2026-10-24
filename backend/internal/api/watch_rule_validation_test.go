package api

import (
	"errors"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A rule the sync cannot follow used to be stored without a word: a regex
// that does not compile fell back to the remote names on every check, an
// unknown provider bound the series ID to TVDB, and a negative number ended
// as "watch already exists" from the database's CHECK. Create and update now
// refuse each of them with a 400 that names the field.
func TestWatchRuleIsValidated(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	// a create that slips through starts a check; it must find no server
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s.Transfers = transfer.NewManager(s.DB, offline, s.DownloadRoot)
	if _, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/anime/Frieren', '')`); err != nil {
		t.Fatal(err)
	}
	bad := []struct{ fields, field string }{
		{`"mode":"regex","pattern":"(unclosed","replacement":"x"`, "pattern"},
		{`"mode":"regex","pattern":"[a-","replacement":"x"`, "pattern"},
		{`"fromEpisode":-1`, "fromEpisode"},
		{`"renameSeriesId":-5`, "renameSeriesId"},
		{`"renameProvider":"foo"`, "renameProvider"},
		{`"renameOrdering":"random"`, "renameOrdering"},
	}
	for _, b := range bad {
		rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/anime/Other","localPath":"",`+b.fields+`}`, c)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), b.field) {
			t.Errorf("create with %s: %d %s, want 400 naming %s", b.fields, rec.Code, rec.Body, b.field)
		}
		rec = doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/anime/Frieren","localPath":"",`+b.fields+`}`, c)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), b.field) {
			t.Errorf("update with %s: %d %s, want 400 naming %s", b.fields, rec.Code, rec.Body, b.field)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM watches`).Scan(&n); err != nil || n != 1 {
		t.Errorf("watches after refused creates: %d (%v), want 1", n, err)
	}
	// a valid regex and a known provider still pass the update
	ok := `{"remotePath":"/anime/Frieren","localPath":"","mode":"regex","pattern":"(?P<n>\\d+)","replacement":"E$n","renameProvider":"tvdb","renameOrdering":"official","fromEpisode":3,"renameSeriesId":42}`
	if rec := doReq(mux, "PUT", "/api/watches/1", ok, c); rec.Code != 200 {
		t.Errorf("valid update: %d %s", rec.Code, rec.Body)
	}
}
