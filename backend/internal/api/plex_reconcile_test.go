package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// The bridge used to skip any series that already carried a tvdb id, so a show
// whose id came from Fribb never learned the one Plex knows - and the two ran as
// separate shows. Both ids are real: Fribb maps the 2012 JoJo season onto 83950,
// Plex calls the show 262954.
func TestReconcileReachesSeriesThatAlreadyHaveAnID(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'a@example.com')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO series (id, key, title, year) VALUES (1,'jojo no kimyou na bouken','JoJo no Kimyou na Bouken',2012)`)
	// the id Fribb contributed, plus the anilist match it came from
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',20474,1), ('tvdb',83950,1)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1,'/ftp/JoJo no Kimyou na Bouken',20474,0,'anilist')`)

	// the candidate query is what regressed; run it directly
	var folder string
	var seriesID int64
	err = d.QueryRow(`SELECT DISTINCT cm.folder, sp.series_id
		FROM catalog_matches cm
		JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
		WHERE cm.media_id != 0
		  AND NOT EXISTS (SELECT 1 FROM plex_reconciled r WHERE r.folder = cm.folder)
		LIMIT 1`).Scan(&folder, &seriesID)
	if err != nil {
		t.Fatalf("a series with an id of its own must still be a candidate: %v", err)
	}
	if seriesID != 1 {
		t.Errorf("series = %d, want 1", seriesID)
	}

	// once looked at, it stops coming back - otherwise every sweep would redo
	// the title lookup for every folder forever
	d.Exec(`INSERT OR REPLACE INTO plex_reconciled (folder, checked_at) VALUES (?, datetime('now'))`, folder)
	if err := d.QueryRow(`SELECT cm.folder FROM catalog_matches cm
		JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
		WHERE cm.media_id != 0
		  AND NOT EXISTS (SELECT 1 FROM plex_reconciled r WHERE r.folder = cm.folder)
		LIMIT 1`).Scan(&folder); err == nil {
		t.Error("an already reconciled folder came back as a candidate")
	}

	// a second tvdb row on the same series is the point, not a conflict
	if _, err := d.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES ('tvdb',262954,1)`); err != nil {
		t.Fatalf("a series must be allowed to carry two tvdb ids: %v", err)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id=1 AND source='tvdb'`).Scan(&n)
	if n != 2 {
		t.Errorf("tvdb rows = %d, want 2", n)
	}
}

// imdb was written but rejected by the CHECK, and the error was never looked
// at - so the counter rose while nothing was stored.
func TestSeriesProviderAcceptsPlexAndImdb(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'k','T')`)
	for _, src := range []string{"anilist", "tmdb:tv", "tmdb:movie", "tvdb", "imdb", "plex"} {
		if _, err := d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES (?, 42, 1)`, src); err != nil {
			t.Errorf("source %q rejected: %v", src, err)
		}
		d.Exec(`DELETE FROM series_provider WHERE source = ?`, src)
	}
	if _, err := d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('erfunden', 1, 1)`); err == nil {
		t.Error("an unknown source should still be rejected")
	}
}
