package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// A provider that did not answer, or was not switched on yet, says nothing
// about the titles it has. Stamping such a series as fetched kept it from
// TMDB/TVDB titles for a month; it has to come due again soon. A fetch the
// shutdown cut short is not stamped at all.
func TestSeriesTitlesRetrySoonWhenAProviderDidNotAnswer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var cutShort atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cutShort.Load() {
			cancel()
		}
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	d := dbtest.Open(t)
	db.SetSetting(d, "tmdb_api_key", "test.jwt.token")
	tm := tmdb.New(d)
	tm.BaseURL = srv.URL
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d), Tmdb: tm, Tvdb: tvdb.New(d)}) // no TVDB key
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'a','A'), (2,'b','B'), (3,'c','C'), (4,'d','D')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES
		('tmdb:tv', 10, 1), ('tvdb', 20, 2), ('anilist', 30, 3), ('tmdb:tv', 40, 4)`)
	// series 4 is fetched in a later pass, the one the shutdown cuts short
	d.Exec(`UPDATE series SET titles_fetched_at = ? WHERE id = 4`, time.Now().UTC().Format(time.RFC3339))

	dueIn := func(id int64) time.Duration {
		t.Helper()
		var at string
		d.QueryRow(`SELECT titles_fetched_at FROM series WHERE id = ?`, id).Scan(&at)
		ts, err := time.Parse(time.RFC3339, at)
		if err != nil {
			t.Fatalf("series %d: stamp %q", id, at)
		}
		return time.Until(ts.Add(titlesRefresh))
	}

	s.refreshSeriesTitles(ctx, 3)
	if got := dueIn(1); got > 2*time.Hour {
		t.Errorf("TMDB failed: due again in %v, want within the hour", got.Round(time.Hour))
	}
	if got := dueIn(2); got > 2*24*time.Hour {
		t.Errorf("TVDB switched off: due again in %v, want within a day", got.Round(time.Hour))
	}
	if got := dueIn(3); got < titlesRefresh-time.Hour {
		t.Errorf("every provider answered: due again in %v, want the full refresh", got.Round(time.Hour))
	}

	// the shutdown cancels mid-call: the failure is not the provider's
	d.Exec(`UPDATE series SET titles_fetched_at = '' WHERE id = 4`)
	d.Exec(`UPDATE series SET titles_fetched_at = ? WHERE id IN (1,2,3)`, time.Now().UTC().Format(time.RFC3339))
	cutShort.Store(true)
	s.refreshSeriesTitles(ctx, 3)
	var at string
	d.QueryRow(`SELECT titles_fetched_at FROM series WHERE id = 4`).Scan(&at)
	if at != "" {
		t.Errorf("a fetch cut short by the shutdown was stamped %q", at)
	}
}
