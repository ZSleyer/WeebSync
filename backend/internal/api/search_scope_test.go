package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
)

// The folder scope of a search compares paths exactly: a sibling that differs
// only in case (/x/show beside /x/Show) is not below /x/Show. LIKE folded the
// case and reported its files too.
func TestSearchScopeIsCaseSensitive(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	mux := http.NewServeMux()
	s.Register(mux)
	if _, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`); err != nil {
		t.Fatal(err)
	}
	cookie := cookieForUser(t, d, 1)

	mod := time.Now().Add(-time.Hour)
	s.indexDir(1, "/x/Show", []remote.Entry{entry("/x/Show/Episode 01.mkv", false, 100, mod)})
	s.indexDir(1, "/x/show", []remote.Entry{entry("/x/show/Episode 02.mkv", false, 100, mod)})

	rec := doReq(mux, "GET", "/api/servers/1/search?q=episode&path=/x/Show", "", cookie)
	var out struct {
		Results []remote.Entry `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if len(out.Results) != 1 || out.Results[0].Path != "/x/Show/Episode 01.mkv" {
		t.Fatalf("scoped search: %s", rec.Body)
	}

	// the folder the user stands in is not a result of searching inside it
	s.indexDir(1, "/x", []remote.Entry{entry("/x/Show", true, 0, mod)})
	rec = doReq(mux, "GET", "/api/servers/1/search?q=show&path=/x/Show", "", cookie)
	out.Results = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if len(out.Results) != 0 {
		t.Errorf("searching inside /x/Show returned %s", rec.Body)
	}
}
