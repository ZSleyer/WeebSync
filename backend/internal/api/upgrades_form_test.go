package api

import (
	"path/filepath"
	"testing"
)

// The reported bug: a film offered as the better copy of a season. TMDB keeps
// films and series in separate id spaces and show_key spells both "tmdb:N", and
// season 0 is where a film, a specials season and a season-less tv folder all
// land - so the two met in one unit and were compared as copies of each other.
func TestUpgradeNeverPairsAFilmWithASeason(t *testing.T) {
	s, root := sizeTestServer(t)
	local := filepath.Join(root, "Serien", "Some Show", "Specials")
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (0, ?, 720, 'tmdb:550', 0, 0)`, local)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (1, '/seed/Some Film (1999) [2160p]', 2160, 'tmdb:550', 0, 1)`)

	if got := s.buildUpgrades(1); len(got) != 0 {
		t.Fatalf("a film was offered as an upgrade of a season: %+v", got[0])
	}

	// the same remote copy in the SAME form is a real upgrade, so the gate
	// scopes rather than blocks
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (2, '/seed/Some Show Specials [2160p]', 2160, 'tmdb:550', 0, 0)`)
	s.DB.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (2,1,'other','sftp','h',22,'u',x'00')`)
	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want the same-form upgrade, got %d", len(got))
	}
	if got[0].IsMovie || !got[0].ImprovesRes {
		t.Errorf("wrong suggestion: %+v", got[0])
	}
}

// A film and a series that collide on one show_key must not share a dismiss key
// either - it is also the React key and the radio group name of the card.
func TestUnitKeySeparatesFilmFromSeason(t *testing.T) {
	if unitKey("tmdb:550", 0, false) == unitKey("tmdb:550", 0, true) {
		t.Fatal("a film and a season-0 series share one key")
	}
	if got := unitKey("tvdb:3", 1, false); got != "unit:tvdb:3:1" {
		t.Errorf("the season key changed shape to %q, which orphans every stored dismissal", got)
	}
}

// "Incomplete" means a gap in something you own, and ownership is per form:
// owning the series tmdb:550 says nothing about the unrelated film tmdb:550.
func TestAddMissingUnitsNeedsALocalCopyOfTheSameForm(t *testing.T) {
	s, root := sizeTestServer(t)
	local := filepath.Join(root, "Serien", "Some Show", "Season 01")
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (0, ?, 1080, 'tvdb:550', 1, 0)`, local)
	// a film on the same key, which is a different work entirely
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (1, '/seed/Some Film (1999)', 1080, 'tvdb:550', 0, 1)`)

	acc := newAcc()
	s.addMissingUnits(acc)
	if got := acc.list(map[string]bool{}); len(got) != 0 {
		t.Fatalf("a film reported as a missing part of a series: %+v", got[0])
	}

	// a missing SEASON of the show still surfaces - the gate is about the form,
	// not about suppressing the bucket
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (1, '/seed/Some Show S02', 1080, 'tvdb:550', 2, 0)`)

	acc = newAcc()
	s.addMissingUnits(acc)
	got := acc.list(map[string]bool{})
	if len(got) != 1 {
		t.Fatalf("want the missing season, got %d items", len(got))
	}
	if got[0].Season != 2 || got[0].IsMovie {
		t.Errorf("wrong item: %+v", got[0])
	}
}

// The library's kind stands in while the sweep has not decided the series' own,
// so an anime library's cards land in the anime block instead of next to the
// live-action ones. Fallback only: it never suppresses anything.
func TestLibKindFallsBackIntoCategory(t *testing.T) {
	s, root := sizeTestServer(t)
	local := filepath.Join(root, "Anime", "Some Show", "Season 01")
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie, lib_kind)
		VALUES (0, ?, 720, 'tvdb:9', 1, 0, ?)`, local, kindAnime)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, is_movie)
		VALUES (1, '/seed/Some Show S01 [2160p]', 2160, 'tvdb:9', 1, 0)`)

	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want 1 upgrade, got %d", len(got))
	}
	if got[0].Category != "anime-tv" {
		t.Errorf("category = %q, want anime-tv from the library the copy lives in", got[0].Category)
	}
}
