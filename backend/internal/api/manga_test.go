package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/match"
)

func TestMangaScope(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`); err != nil {
		t.Fatal(err)
	}
	seed := func(parent, name string) {
		d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,0)`,
			parent+"/"+name, parent, name)
	}
	seed("/Books/M/Monster", "Monster 01.cbz")
	seed("/Books/M/Monster", "Monster 02.cbr")
	seed("/Anime/Monster", "Monster - 01.mkv")
	d.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/Books', 'manga')`)
	s := &Server{DB: d}

	// the letter shelf takes the mark of the folder above it, a title does not
	if got := s.scopeFor(1, "/Books/M"); got != "manga" {
		t.Errorf("shelf scope = %q, want manga", got)
	}
	if got := s.scopeFor(1, "/Books/M/Monster"); got != "" {
		t.Errorf("title scope = %q, want none", got)
	}
	if !s.holdsBooks(1, "/Books/M/Monster") || s.holdsBooks(1, "/Anime/Monster") {
		t.Error("holdsBooks must tell volumes from episodes")
	}
	// not indexed yet: the path decides
	if !s.holdsBooks(1, "/Manga & LN/X/Title") || s.holdsBooks(1, "/Anime/Title") {
		t.Error("holdsBooks path fallback")
	}
	if _, scope := s.watchMatchQuery(1, "/Books/M/Monster", ""); scope != "manga" {
		t.Errorf("watch scope = %q, want manga", scope)
	}
	// the migration accepts the source; a match on it never bundles a series
	s.persistMatch(1, "/Books/M/Monster", 30001, false, mangaSource)
	var src string
	if err := d.QueryRow(`SELECT source FROM catalog_matches WHERE folder = '/Books/M/Monster'`).Scan(&src); err != nil || src != mangaSource {
		t.Fatalf("stored source = %q, %v", src, err)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider`).Scan(&n)
	if n != 0 {
		t.Errorf("manga joined %d series", n)
	}
	// an anime template left on a manga watch does not rename its volumes
	w := Watch{ServerID: 1, RemotePath: "/Books/M/Monster", Mode: "template", Template: "{title} - S{season:02}E{episode:02}"}
	if fn := s.watchNameFn(w); fn != nil {
		t.Errorf("manga watch renamed to %q", fn("Monster 01.cbz"))
	}
}

func TestMangaNames(t *testing.T) {
	for _, n := range []string{"A", "z", "0-9", "#"} {
		if !isShelf(n) {
			t.Errorf("isShelf(%q) = false", n)
		}
	}
	for _, n := range []string{"AB", "One Piece", "Season 1"} {
		if isShelf(n) {
			t.Errorf("isShelf(%q) = true", n)
		}
	}
	if got := match.GuessTitle("One Piece [Deutsch]"); got != "One Piece" {
		t.Errorf("GuessTitle = %q", got)
	}
	if got := watchCategory(mangaSource, &anilist.Media{Format: "NOVEL"}); got != "manga" {
		t.Errorf("watchCategory = %q", got)
	}
}
