package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A row that cannot be scanned must fail the list, not vanish from it (the
// user could never restore it).
func TestDismissedListScanErrorIs500(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	// pre-migration leftovers: nullable columns
	for _, q := range []string{
		`DROP TABLE suggestion_dismissals`,
		`CREATE TABLE suggestion_dismissals (user_id INTEGER, kind TEXT, ref_key TEXT, label TEXT, dismissed_at TEXT, cover TEXT, section TEXT)`,
		`INSERT INTO suggestion_dismissals (user_id, kind, ref_key, label, dismissed_at) VALUES (1, 'suggestion', 'k', NULL, 'x')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	d.Exec(`INSERT INTO users (id, email, approved) VALUES (1, 'u@e.test', 1)`)
	login := httptest.NewRecorder()
	if err := auth.CreateSession(d, login, httptest.NewRequest(http.MethodGet, "/", nil), 1, false); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range login.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	auth.Middleware(d, true)(http.HandlerFunc(s.handleDismissedList)).ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 (body %s)", w.Code, w.Body.String())
	}
}
