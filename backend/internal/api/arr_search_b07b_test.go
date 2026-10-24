package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// SQLite's LIKE folds case for ASCII only
// (https://www.sqlite.org/lang_expr.html#like), so a lowercased query for a
// title that starts with a capital outside ASCII must still find its folder.
func TestNewznabTitleSearchNonASCIICase(t *testing.T) {
	s, _ := sizeTestServer(t)
	setArrKey(s, "k")
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season) VALUES (1, '/seed/Ōoku', 'tvdb:1', 1)`)
	addRemoteFiles(t, s, 1, "/seed/Ōoku", map[string]int64{"Ōoku - 01 [1080p].mkv": 100})
	h := s.arrGate(s.handleNewznab)
	for _, q := range []string{"Ōoku", "ōoku", "ŌOKU"} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodGet, "/api/arr/newznab/api?apikey=k&t=tvsearch&q="+url.QueryEscape(q), nil))
		if !strings.Contains(w.Body.String(), "<item>") {
			t.Errorf("q=%q found nothing: %s", q, w.Body.String())
		}
	}
}
