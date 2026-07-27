package api

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func identityDB(t *testing.T) (*sql.DB, *Server) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	// two entries for what Plex holds as one show: the AniList season that was
	// bundled first, and a tvdb match that arrived on its own
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'clevatess','Clevatess'), (2,'clevatess ii','Clevatess II')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',1,1), ('tvdb',451793,2)`)
	return d, &Server{DB: d}
}

func seriesOf(t *testing.T, d *sql.DB, source string, id int) int64 {
	t.Helper()
	var got int64
	d.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`, source, id).Scan(&got)
	return got
}

// The folder Plex scanned is the strongest statement about which show this is,
// so an id claimed by another entry means the two are the same show.
func TestAttachPlexIdentityUnitesOnAnExactBinding(t *testing.T) {
	d, s := identityDB(t)
	s.attachPlexIdentity(1, plexGuid{TVDB: 451793, IMDB: 32991344, RatingKey: "67107"}, true)

	if got := seriesOf(t, d, "tvdb", 451793); got != 1 {
		t.Errorf("tvdb row sits on series %d, want 1 - the two entries were not united", got)
	}
	if got := seriesOf(t, d, "plex", 67107); got != 1 {
		t.Errorf("plex row sits on series %d, want 1", got)
	}
	var left int
	d.QueryRow(`SELECT COUNT(*) FROM series WHERE id = 2`).Scan(&left)
	if left != 0 {
		t.Error("the merged-away series is still there")
	}
}

// A folded title is not proof: it once bound a series to an unrelated film. A
// conflicting id is left where it is rather than merged on that evidence.
func TestAttachPlexIdentityLeavesAClaimedIDAloneWhenGuessed(t *testing.T) {
	d, s := identityDB(t)
	s.attachPlexIdentity(1, plexGuid{TVDB: 451793, RatingKey: "67107"}, false)

	if got := seriesOf(t, d, "tvdb", 451793); got != 2 {
		t.Errorf("tvdb row moved to series %d; a guessed match must not merge", got)
	}
	// the ids nobody claimed still attach - that is the whole point of the pass
	if got := seriesOf(t, d, "plex", 67107); got != 1 {
		t.Errorf("plex row sits on series %d, want 1", got)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series`).Scan(&n)
	if n != 2 {
		t.Errorf("series count = %d, want both left standing", n)
	}
}

// The reconcile fallback: the folder title folds to nothing, but the series
// carries an id Plex publishes for the same show.
func TestGuidForShowKey(t *testing.T) {
	idx := map[string]plexGuid{
		"dasbandderunterwelt": {TVDB: 452711, RatingKey: "71812"},
		"onepiece":            {TVDB: 81797, TMDB: 37854, RatingKey: "10011"},
	}
	for _, tc := range []struct {
		key  string
		want string
	}{
		{"tvdb:452711", "71812"},
		{"tmdb:37854", "10011"},
		{"tvdb:999999", ""},
		{"fold:yominotsugai", ""},
		{"", ""},
	} {
		g, ok := guidForShowKey(idx, tc.key)
		if (tc.want == "") == ok || g.RatingKey != tc.want {
			t.Errorf("guidForShowKey(%q) = %q, %v; want %q", tc.key, g.RatingKey, ok, tc.want)
		}
	}
}
