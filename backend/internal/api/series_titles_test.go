package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

func TestSeriesLocalTitle(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1, 'k1', 'raw'), (2, 'k2', 'raw2'), (3, 'k3', 'raw3')`)

	// locale chain: de beats en beats x-jat
	s.storeSeriesTitle(1, "anilist", "x-jat", "Meitantei Conan")
	s.storeSeriesTitle(1, "anilist", "en", "Case Closed")
	s.storeSeriesTitle(1, "tvdb", "de", "Detektiv Conan")
	if got := s.seriesLocalTitle(1); got != "Detektiv Conan" {
		t.Errorf("chain: got %q", got)
	}
	// same locale: curated provider (tvdb) beats anilist
	s.storeSeriesTitle(2, "anilist", "en", "A Title")
	s.storeSeriesTitle(2, "tvdb", "en", "The Title")
	if got := s.seriesLocalTitle(2); got != "The Title" {
		t.Errorf("source rank: got %q", got)
	}
	// upsert replaces
	s.storeSeriesTitle(2, "tvdb", "en", "The Better Title")
	if got := s.seriesLocalTitle(2); got != "The Better Title" {
		t.Errorf("upsert: got %q", got)
	}
	// empty locale/title rows are dropped; nothing stored -> ""
	s.storeSeriesTitle(3, "tvdb", "", "x")
	s.storeSeriesTitle(3, "tvdb", "de", " ")
	if got := s.seriesLocalTitle(3); got != "" {
		t.Errorf("empty: got %q", got)
	}
	if got := s.seriesLocalTitle(0); got != "" {
		t.Errorf("id 0: got %q", got)
	}
	// FK: unknown series must not be stored
	s.storeSeriesTitle(999, "tvdb", "de", "Ghost")
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_titles WHERE series_id = 999`).Scan(&n)
	if n != 0 {
		t.Errorf("orphan title stored despite FK")
	}
}

// TestRefreshSeriesTitlesManual runs the real title job against a copy of a
// populated DB with live API keys. Skipped unless WEEBSYNC_TITLES_DB points at
// the database file (never in CI).
func TestRefreshSeriesTitlesManual(t *testing.T) {
	path := os.Getenv("WEEBSYNC_TITLES_DB")
	if path == "" {
		t.Skip("set WEEBSYNC_TITLES_DB to run")
	}
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Anilist: anilist.New(d), Tmdb: tmdb.New(d), Tvdb: tvdb.New(d)}
	s.refreshSeriesTitles(context.Background(), 25)
	var series, titles int
	d.QueryRow(`SELECT COUNT(DISTINCT series_id), COUNT(*) FROM series_titles`).Scan(&series, &titles)
	t.Logf("series=%d titles=%d", series, titles)
	rows, _ := d.Query(`SELECT series_id, source, locale, title FROM series_titles LIMIT 12`)
	defer rows.Close()
	for rows.Next() {
		var id int64
		var src, loc, title string
		rows.Scan(&id, &src, &loc, &title)
		t.Logf("  %d %s %s %q", id, src, loc, title)
	}
	if series == 0 {
		t.Error("no titles fetched")
	}
}
