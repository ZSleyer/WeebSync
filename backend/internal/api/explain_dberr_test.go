package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A database failure while explaining is the server's fault (500, no driver
// text); 502 stays reserved for the upstream search.
func TestCatalogExplainDBErrorIs500(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	if _, err := d.Exec(`DROP TABLE catalog_matches`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/?folder=/x/Show", nil)
	r.SetPathValue("id", strconv.FormatInt(localServerID, 10))
	w := httptest.NewRecorder()
	s.handleCatalogExplain(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "catalog_matches") {
		t.Errorf("driver text leaked: %s", w.Body.String())
	}
}
