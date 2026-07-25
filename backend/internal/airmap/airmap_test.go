package airmap

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestResolveCache(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// seed a fresh cache so Resolve skips the (client-less) rebuild; the source
	// tag must match the series' effective provider+ordering
	d.Exec(`INSERT INTO season_maps_meta (server_id, folder, source, updated_at) VALUES (1,'Conan','tvdb:official:0',datetime('now'))`)
	d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (1,'Conan','1187',34,1)`)
	d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (1,'Conan','1186.5',0,12)`)

	r := &Resolver{DB: d}
	s := Series{ServerID: 1, Folder: "Conan", Provider: "tvdb", Ordering: "official"}
	if season, ep, ok := r.Resolve(context.Background(), s, "1187"); !ok || season != 34 || ep != 1 {
		t.Errorf("1187 -> S%dE%d ok=%v, want S34E01", season, ep, ok)
	}
	if season, ep, ok := r.Resolve(context.Background(), s, "1186.5"); !ok || season != 0 || ep != 12 {
		t.Errorf("special 1186.5 -> S%dE%d ok=%v, want S00E12", season, ep, ok)
	}
	if _, _, ok := r.Resolve(context.Background(), s, "9999"); ok {
		t.Error("unknown token should not resolve")
	}
	if _, _, ok := r.Resolve(context.Background(), s, ""); ok {
		t.Error("empty token should not resolve")
	}
}

// An episode that aired after the map was built is exactly the case aired
// mapping exists for, and it must not wait out the TTL: renaming from a list
// that cannot contain the number is what filed Detective Conan 1208 as S01E1208.
// The miss triggers a rebuild, and the rebuild is rate-limited so specials -
// whose ".5" tokens no provider lists - cannot turn every file into a round trip.
func TestResolveRebuildsOnMiss(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.Exec(`INSERT INTO season_maps_meta (server_id, folder, source, updated_at) VALUES (1,'Conan','tvdb:official:0',datetime('now'))`)
	d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (1,'Conan','1207',34,21)`)

	rebuilds := 0
	r := &Resolver{DB: d, onRebuild: func() {
		rebuilds++
		// the provider learned the new episode in the meantime
		d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (1,'Conan','1208',34,22)`)
	}}
	s := Series{ServerID: 1, Folder: "Conan", Provider: "tvdb", Ordering: "official"}

	// known token: answered from the map, no rebuild
	if season, ep, ok := r.Resolve(context.Background(), s, "1207"); !ok || season != 34 || ep != 21 {
		t.Fatalf("1207 -> S%dE%d ok=%v", season, ep, ok)
	}
	if rebuilds != 0 {
		t.Fatalf("a known token rebuilt %d times", rebuilds)
	}
	// unknown token: rebuild now, then resolve
	if season, ep, ok := r.Resolve(context.Background(), s, "1208"); !ok || season != 34 || ep != 22 {
		t.Fatalf("1208 -> S%dE%d ok=%v, want S34E22", season, ep, ok)
	}
	if rebuilds != 1 {
		t.Fatalf("rebuilds = %d, want exactly 1", rebuilds)
	}
	// a second miss inside the backoff must not hit the provider again
	if _, _, ok := r.Resolve(context.Background(), s, "9999"); ok {
		t.Error("9999 should not resolve")
	}
	if rebuilds != 1 {
		t.Errorf("rebuilds = %d, want the backoff to hold at 1", rebuilds)
	}
}

// The provider is typically a few hours behind a fresh episode. Counting on
// from the newest one it knows gives the file a name worth showing, while the
// caller keeps it quarantined until the provider confirms it.
func TestGuess(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES
		(1,'Conan','1206',34,20), (1,'Conan','1207',34,21),
		(1,'Conan','1207.5',0,14)`) // a special must not pass as the newest episode
	r := &Resolver{DB: d}
	s := Series{ServerID: 1, Folder: "Conan"}

	if se, ep, ok := r.Guess(s, "1208"); !ok || se != 34 || ep != 22 {
		t.Errorf("1208 -> S%dE%d ok=%v, want S34E22", se, ep, ok)
	}
	if se, ep, ok := r.Guess(s, "1210"); !ok || se != 34 || ep != 24 {
		t.Errorf("1210 -> S%dE%d ok=%v, want S34E24", se, ep, ok)
	}
	// too far ahead: a season boundary lies somewhere in there
	if _, _, ok := r.Guess(s, "1260"); ok {
		t.Error("1260 is beyond the guess span and should not resolve")
	}
	// already known, or below the range: nothing to extrapolate
	if _, _, ok := r.Guess(s, "1207"); ok {
		t.Error("a known number should not be guessed")
	}
	if _, _, ok := r.Guess(s, "900"); ok {
		t.Error("a number below the range should not be guessed")
	}
	// specials have no run to count on
	if _, _, ok := r.Guess(s, "1208.5"); ok {
		t.Error("a special should not be guessed")
	}
	// nothing known at all
	if _, _, ok := r.Guess(Series{ServerID: 9, Folder: "Leer"}, "5"); ok {
		t.Error("without a map there is nothing to count from")
	}
}
