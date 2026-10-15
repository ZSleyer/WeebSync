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

// An anime library ordered by TVDB holds AniList matches on purpose: when the
// anime mapping and Plex name the same show, a source change leaves them be.
// A name-alike guess maps elsewhere and is searched again.
func TestMatchWatchKeepsAnAnimeThePlexShowConfirms(t *testing.T) {
	s := sourceTestServer(t)
	db.SetSetting(s.DB, "plex_lib_scopes", "/media/anime\ttvdb\n/media/tv\ttvdb")
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season) VALUES (235, 72454, 1), (112376, 398083, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season) VALUES
		(0, '/media/anime/Conan/Season 33', 'tvdb:72454', 33),
		(0, '/media/tv/House of the Dragon/Season 01', 'tvdb:371572', 1)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id, manual) VALUES
		(1, '/x/Conan', 'anilist', 235, 1), (1, '/x/HotD', 'anilist', 112376, 1)`)
	if s.matchWatch(1, "/x/Conan", "/media/anime/Conan/Season 33", true) {
		t.Fatal("Conan: Plex and the anime mapping agree, the AniList match must stay")
	}
	if s.matchWatch(1, "/x/Conan", "/media/anime/Conan", true) {
		t.Fatal("Conan: a watch on the show folder sees its seasons")
	}
	if !s.matchWatch(1, "/x/HotD", "/media/tv/House of the Dragon", true) {
		t.Fatal("HotD: the AniList guess maps to another show, it must be searched again")
	}
}

// TVDB holds anime and live action: the anime mapping decides the shelf.
func TestWatchCategoryOfTvdb(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season) VALUES (235, 72454, 1)`)
	if got := watchCategory("tvdb", nil, s.tvdbAnime("tvdb", 72454)); got != "anime-series" {
		t.Errorf("Conan on TVDB: %q", got)
	}
	if got := watchCategory("tvdb", nil, s.tvdbAnime("tvdb", 404604)); got != "series" {
		t.Errorf("Ted on TVDB: %q", got)
	}
}

// A new mark matches its folders at once: the unmatched and those on another
// source (a manual pick included), never one already on the mark's source or
// a helper folder.
func TestQueueScopeChildren(t *testing.T) {
	s := sourceTestServer(t)
	for _, n := range []string{"Silo (2023)", "Ted (2024)", "Severance (2022)", "Plex Versions"} {
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, name, parent, is_dir) VALUES (1, ?, ?, '/plex/Serien', 1)`,
			"/plex/Serien/"+n, n)
	}
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id, manual) VALUES
		(1, '/plex/Serien/Ted (2024)', 'anilist', 177406, 1), (1, '/plex/Serien/Severance (2022)', 'tvdb', 371980, 0)`)
	if n := s.queueScopeChildren(1, "/plex/Serien", "tvdb"); n != 2 {
		t.Fatalf("queued %d, want Silo and Ted", n)
	}
}

// The catalogue's correction and the auto-sync search the same source.
func TestFolderSource(t *testing.T) {
	s := sourceTestServer(t)
	db.SetSetting(s.DB, "plex_lib_scopes", "/media/tv\ttvdb\n/media/anime\ttvdb")
	s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES
		(1, 1, '/x/Ted (2024)', '/media/tv/Ted'), (1, 1, '/x/Conan', '/media/anime/Conan/Season 33')`)
	if got := s.folderSource(1, "/x/Ted (2024)"); got != "tvdb" {
		t.Errorf("Ted: %q, want the library's tvdb", got)
	}
	// Conan stays on the AniList entry Plex confirms
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season) VALUES (235, 72454, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season) VALUES (0, '/media/anime/Conan/Season 33', 'tvdb:72454', 33)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id, manual) VALUES (1, '/x/Conan', 'anilist', 235, 1)`)
	if got := s.folderSource(1, "/x/Conan"); got != "anilist" {
		t.Errorf("Conan: %q, want anilist", got)
	}
	// a mark on the parent decides over everything
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/x', 'tv')`)
	if got := s.folderSource(1, "/x/Ted (2024)"); got != "tmdb:tv" {
		t.Errorf("marked: %q, want tmdb:tv", got)
	}
	if got := s.folderSource(1, "/y/Unwatched"); got != "anilist" {
		t.Errorf("nothing known: %q", got)
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
	if title != "House of the Dragon" || kind != kindLive {
		t.Fatalf("series: title %q kind %q, want the TVDB name and live action", title, kind)
	}
}

// The AniList guess left in an earlier step and took no name with it: a TVDB
// match on a series without AniList names it and decides its kind, at once
// and in the one-time pass over what is stored.
func TestTvdbMatchNamesItsSeries(t *testing.T) {
	s := sourceTestServer(t)
	cacheMedia(t, s, "tvdb:media:404604", 404604, "Ted", "")
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (1, 'gif ni ted', 'Gif ni Ted', '')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 404604, 1), ('plex', 9, 1)`)
	if err := s.persistMatch(1, "/x/Ted (2024)", 404604, true, "tvdb"); err != nil {
		t.Fatal(err)
	}
	var title, kind string
	s.DB.QueryRow(`SELECT title, kind FROM series WHERE id = 1`).Scan(&title, &kind)
	if title != "Ted" || kind != kindLive {
		t.Fatalf("after the match: title %q kind %q", title, kind)
	}
	s.DB.Exec(`UPDATE series SET title = 'Gif ni Ted', kind = ''`)
	s.SettleMatchedSeries()
	s.DB.QueryRow(`SELECT title, kind FROM series WHERE id = 1`).Scan(&title, &kind)
	if title != "Ted" || kind != kindLive {
		t.Fatalf("after the pass: title %q kind %q", title, kind)
	}
	// an anime series keeps its AniList name whatever else matches it
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 5, 1)`)
	s.DB.Exec(`UPDATE series SET title = 'Anime Name'`)
	s.settleSeries("tvdb", 404604)
	s.DB.QueryRow(`SELECT title FROM series WHERE id = 1`).Scan(&title)
	if title != "Anime Name" {
		t.Fatalf("anime renamed to %q", title)
	}
}

// Conan taken back from TVDB to AniList keeps the TVDB id its AniList entry is
// filed under: it is the series' identity and Plex's bridge.
func TestBackToAnilistKeepsTheMappedShow(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season) VALUES (235, 72454, 1)`)
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (1, 'meitantei conan', 'Meitantei Conan', 'anime')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 235, 1), ('tvdb', 72454, 1)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/Conan', 'tvdb', 72454)`)
	if err := s.persistMatch(1, "/x/Conan", 235, true, "anilist"); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'tvdb' AND media_id = 72454 AND series_id = 1`).Scan(&n)
	if n != 1 {
		t.Fatal("the TVDB id the anime mapping files Conan under left the series")
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
