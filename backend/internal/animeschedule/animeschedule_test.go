package animeschedule

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestRouteAndTimetable(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer tok" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/anime", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("anilist-ids") != "189046" {
			w.Write([]byte(`{"page":1,"totalAmount":0,"anime":[]}`))
			return
		}
		w.Write([]byte(`{"page":1,"totalAmount":1,"anime":[{"id":"x","title":"Re:Zero 4","route":"re-zero-4th-season"}]}`))
	}))
	mux.HandleFunc("/timetables/dub", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("week") != "38" || r.URL.Query().Get("tz") != "UTC" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Write([]byte(`[{"title":"Re:Zero 4","route":"re-zero-4th-season","episodeDate":"2026-09-16T14:00:00Z","episodeNumber":15,"airType":"dub"}]`))
	}))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := New(d)
	c.BaseURL = srv.URL
	ctx := context.Background()

	if c.Enabled() {
		t.Fatal("no token, must read as disabled")
	}
	if _, err := c.Route(ctx, 189046); err == nil {
		t.Fatal("without a token the call must fail, not go out unauthenticated")
	}
	d.Exec(`INSERT INTO settings (key, value) VALUES ('animeschedule_token', 'tok')`)
	route, err := c.Route(ctx, 189046)
	if err != nil || route != "re-zero-4th-season" {
		t.Fatalf("route = %q, %v", route, err)
	}
	if route, _ := c.Route(ctx, 1); route != "" {
		t.Errorf("unknown title should give no route, got %q", route)
	}
	tt, err := c.DubTimetable(ctx, 2026, 38)
	if err != nil || len(tt) != 1 || tt[0].EpisodeNumber != 15 || tt[0].At() != 1789567200 {
		t.Fatalf("timetable = %+v, %v", tt, err)
	}
}
