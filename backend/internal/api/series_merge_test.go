package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

func mergeTestServer(t *testing.T) *Server {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return &Server{DB: d, Anilist: anilist.New(d)}
}

func seedAnilistMedia(t *testing.T, s *Server, id int, title string, year int) {
	t.Helper()
	m := &anilist.Media{ID: id, SeasonYear: year, Status: "FINISHED"}
	m.Title.Romaji = title
	s.Anilist.CacheMedia(m)
}

// The Fribb mapping carries both halves: which show a work belongs to, and
// which season it is. A film that the dataset files under the show's id is not
// one of them.
func TestShowIdentity(t *testing.T) {
	s := mergeTestServer(t)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season) VALUES
		(20474, 262954, 2, 45790, 'tv', 2),
		(131942, 262954, 5, 45790, 'tv', 5),
		(505262, 305074, 0, 505262, 'movie', 0),
		(999001, 0, 0, 77777, 'tv', 3)`)

	for _, c := range []struct {
		anilist int
		want    showRef
		ok      bool
	}{
		{20474, showRef{"tvdb", 262954, 2}, true},
		{131942, showRef{"tvdb", 262954, 5}, true},
		{505262, showRef{}, false},                   // a film is an entry of its own
		{999001, showRef{"tmdb:tv", 77777, 3}, true}, // no tvdb id: tmdb tv carries the show
		{424242, showRef{}, false},                   // not in the dataset
	} {
		got, ok := s.showIdentity(c.anilist)
		if ok != c.ok || got != c.want {
			t.Errorf("showIdentity(%d) = %+v, %v; want %+v, %v", c.anilist, got, ok, c.want, c.ok)
		}
	}
}

// Every cour of JoJo was an entry of its own because they name themselves
// differently. They must end up as one show with named seasons.
func TestMergeShowSeriesFoldsCours(t *testing.T) {
	s := mergeTestServer(t)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season) VALUES
		(20474, 262954, 2, 45790, 'tv', 2),
		(21450, 262954, 3, 45790, 'tv', 3),
		(131942, 262954, 5, 45790, 'tv', 5)`)
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES
		(1,'jojo no kimyou na bouken stardust crusaders','JoJo no Kimyou na Bouken: Stardust Crusaders',2014),
		(2,'jojo no kimyou na bouken diamond wa kudakenai','JoJo no Kimyou na Bouken: Diamond wa Kudakenai',2016),
		(3,'jojo no kimyou na bouken stone ocean','JoJo no Kimyou na Bouken: Stone Ocean',2021)`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES
		('anilist',20474,1), ('anilist',21450,2), ('anilist',131942,3)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES
		(0,'/media/anime/JoJo/Season_03','tvdb:262954',3,2)`)

	// mergeShowSeries reads each work's title from the metadata cache; feed it
	// the same way the sweep would have.
	for _, c := range []struct {
		id    int
		title string
		year  int
	}{
		{20474, "JoJo no Kimyou na Bouken: Stardust Crusaders", 2014},
		{21450, "JoJo no Kimyou na Bouken: Diamond wa Kudakenai", 2016},
		{131942, "JoJo no Kimyou na Bouken: Stone Ocean", 2021},
	} {
		seedAnilistMedia(t, s, c.id, c.title, c.year)
	}

	s.mergeShowSeries(50)

	var shows int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series`).Scan(&shows)
	if shows != 1 {
		t.Fatalf("series = %d, want 1 show", shows)
	}
	var showID int64
	var title string
	s.DB.QueryRow(`SELECT id, title FROM series`).Scan(&showID, &title)
	if title != "JoJo no Kimyou na Bouken" {
		t.Errorf("show title = %q, want the shared name without a season", title)
	}

	// the works keep their names, one level down
	rows, _ := s.DB.Query(`SELECT season, title FROM series_seasons WHERE series_id = ? ORDER BY season`, showID)
	got := map[int]string{}
	for rows.Next() {
		var season int
		var t string
		rows.Scan(&season, &t)
		got[season] = t
	}
	rows.Close()
	if len(got) != 3 || got[3] != "JoJo no Kimyou na Bouken: Diamond wa Kudakenai" {
		t.Errorf("seasons = %v, want the three cours under their own names", got)
	}

	// the copy came along; a variant left pointing at a deleted series would
	// drop out of every grouping
	var variantSeries int64
	s.DB.QueryRow(`SELECT series_id FROM catalog_variants`).Scan(&variantSeries)
	if variantSeries != showID {
		t.Errorf("variant series_id = %d, want %d", variantSeries, showID)
	}

	// and it stays done: a second pass finds nothing left to fold
	s.mergeShowSeries(50)
	s.DB.QueryRow(`SELECT COUNT(*) FROM series`).Scan(&shows)
	if shows != 1 {
		t.Errorf("series = %d after a second pass, want 1", shows)
	}
}

func TestSharedTitlePrefix(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want string
	}{
		{[]string{"Sword Art Online", "Sword Art Online II", "Sword Art Online: Alicization"}, "Sword Art Online"},
		{[]string{"Boku no Hero Academia", "Boku no Hero Academia 3"}, "Boku no Hero Academia"},
		// the Monogatari seasons share an ending, not an opening
		{[]string{"Bakemonogatari", "Nisemonogatari"}, ""},
		// a prefix that would cut a word in half is not a prefix
		{[]string{"Naruto", "Narutaki"}, ""},
		{[]string{"Dr. STONE", "Dr. STONE: NEW WORLD"}, "Dr. STONE"},
	} {
		if got := sharedTitlePrefix(c.in); got != c.want {
			t.Errorf("sharedTitlePrefix(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
