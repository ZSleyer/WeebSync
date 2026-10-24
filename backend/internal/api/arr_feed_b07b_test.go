package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A database error is not "no results": the app would take the indexer for
// healthy. The feed answers with a Newznab error and a 500 instead.
func TestNewznabFeedDatabaseError(t *testing.T) {
	s, _ := sizeTestServer(t)
	setArrKey(s, "k")
	if _, err := s.DB.Exec(`DROP TABLE remote_index`); err != nil {
		t.Fatal(err)
	}
	h := s.arrGate(s.handleNewznab)
	for _, q := range []string{"t=tvsearch&tvdbid=1", "t=search&q=frieren", "t=tvsearch"} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodGet, "/api/arr/newznab/api?apikey=k&"+q, nil))
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), `<error code="900"`) {
			t.Errorf("%s: status %d, body %q", q, w.Code, w.Body.String())
		}
	}
}
