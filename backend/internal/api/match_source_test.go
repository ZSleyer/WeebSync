package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

func sourceTestServer(t *testing.T) *Server {
	t.Helper()
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	db.SetSetting(d, "jobs_paused", "m") // decide only, search nothing
	return &Server{DB: d, Anilist: anilist.New(d), Tmdb: tmdb.New(d), Tvdb: tvdb.New(d)}
}

// Saving the edit dialog sends the folder's match back unchanged; that is no
// decision and must not freeze the matcher's guess as manual.
func TestLinkMediaKeepsAnAutomaticMatch(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/Ted', 'anilist', 177406)`)
	s.linkMedia(1, "/x/Ted", 177406, "anilist")
	var manual int
	var source string
	s.DB.QueryRow(`SELECT manual FROM catalog_matches WHERE folder = '/x/Ted'`).Scan(&manual)
	if manual != 0 {
		t.Fatal("re-saving the same match made it manual")
	}
	// a real pick of another provider is one, and TVDB stays TVDB
	s.linkMedia(1, "/x/Ted", 404604, "tvdb")
	s.DB.QueryRow(`SELECT manual, source FROM catalog_matches WHERE folder = '/x/Ted'`).Scan(&manual, &source)
	if manual != 1 || source != "tvdb" {
		t.Fatalf("picked tvdb: manual %d source %q", manual, source)
	}
}

// A watch folder follows its library's source: an AniList match in a TVDB
// library is searched again, a manual one only when a source change overrules.
func TestMatchWatchFollowsTheLibrarySource(t *testing.T) {
	s := sourceTestServer(t)
	db.SetSetting(s.DB, "plex_lib_scopes", "/media/tv\ttvdb")
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/Silo', 'anilist', 5)`)
	if !s.ensureWatchMatch(1, "/x/Silo", "/media/tv/Silo") {
		t.Fatal("an automatic AniList match in a TVDB library should be searched again")
	}
	s.DB.Exec(`UPDATE catalog_matches SET manual = 1`)
	if s.ensureWatchMatch(1, "/x/Silo", "/media/tv/Silo") {
		t.Fatal("a manual match must stay outside a source change")
	}
	if !s.matchWatch(1, "/x/Silo", "/media/tv/Silo", true) {
		t.Fatal("a source change should overrule the manual AniList match")
	}
	s.DB.Exec(`UPDATE catalog_matches SET source = 'tvdb', manual = 0`)
	if s.matchWatch(1, "/x/Silo", "/media/tv/Silo", true) {
		t.Fatal("a match from the library's own source must stay")
	}
	// a manga under an anime mark the books check has not seen yet
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/x', 'anime')`)
	s.DB.Exec(`UPDATE catalog_matches SET source = 'anilist:manga'`)
	if s.matchWatch(1, "/x/Silo", "/elsewhere/Silo", true) {
		t.Fatal("a manga match must not be searched again as anime")
	}
	s.DB.Exec(`DELETE FROM catalog_scopes`)
	// no mark and no library: nothing says the stored source is wrong
	s.DB.Exec(`UPDATE catalog_matches SET source = 'tmdb:tv'`)
	if s.ensureWatchMatch(1, "/x/Silo", "/elsewhere/Silo") {
		t.Fatal("a folder outside every library keeps its source")
	}
}

func TestChangedRoots(t *testing.T) {
	got := changedRoots("/a\tanime\n/b\tanime", []string{"/a\tanime", "/b\ttvdb", "/c\ttv"})
	if len(got) != 2 || got[0] != "/b" || got[1] != "/c" {
		t.Fatalf("changed roots: %v", got)
	}
}

// Plex hung the show's TVDB id on the series of a wrong AniList guess. When the
// folder's match moves to that TVDB id, the AniList entry leaves the series,
// and with it the anime kind and the AniList name.
func TestReplacedMatchLeavesTheSeries(t *testing.T) {
	s := sourceTestServer(t)
	cacheMedia(t, s, "tvdb:media:371572", 371572, "House of the Dragon", "")
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (1, 'dragon ie wo kau', 'Dragon, Ie wo Kau.', 'anime')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 112376, 1), ('tvdb', 371572, 1), ('plex', 9, 1)`)
	s.DB.Exec(`INSERT INTO series_titles (series_id, source, locale, title) VALUES (1, 'anilist', 'x-jat', 'Dragon, Ie wo Kau.')`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id, manual) VALUES (1, '/x/House of the Dragon (2022)', 'anilist', 112376, 1)`)

	if err := s.persistMatch(1, "/x/House of the Dragon (2022)", 371572, false, "tvdb"); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'anilist'`).Scan(&n)
	if n != 0 {
		t.Fatal("the AniList entry no folder matches stayed on the series")
	}
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_titles WHERE source = 'anilist'`).Scan(&n)
	if n != 0 {
		t.Fatal("the AniList titles stayed")
	}
	var title, kind string
	s.DB.QueryRow(`SELECT title, kind FROM series WHERE id = 1`).Scan(&title, &kind)
	if title != "House of the Dragon" || kind != "" {
		t.Fatalf("series: title %q kind %q, want the TVDB name and the kind decided again", title, kind)
	}
}

// An entry another folder still matches, or one put on the series by hand,
// stays where it is.
func TestDetachProviderKeepsWhatIsStillUsed(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (1, 'a', 'A', 'anime')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 1, 1), ('tvdb', 2, 1)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/other', 'anilist', 1)`)
	if s.detachProvider("anilist", 1) != 0 {
		t.Fatal("detached an entry another folder still matches")
	}
	s.DB.Exec(`DELETE FROM catalog_matches`)
	s.DB.Exec(`UPDATE series_provider SET manual = 1 WHERE source = 'anilist'`)
	if s.detachProvider("anilist", 1) != 0 {
		t.Fatal("detached an entry put on the series by hand")
	}
	// a provider leaving one behind reports the series it left
	if s.detachProvider("tvdb", 2) != 1 {
		t.Fatal("the series keeps its AniList entry and must stay")
	}
	// the last provider gone takes the series with it
	s.DB.Exec(`UPDATE series_provider SET manual = 0`)
	s.detachProvider("anilist", 1)
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series`).Scan(&n)
	if n != 0 {
		t.Fatal("a series without providers stayed")
	}
}
