package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// A provider's format describes the work, not the folder. A MOVIE hit landing
// on a folder full of episodes is a mismatch: believing it files the show under
// season 0 with is_movie, where no local season can meet it, and the suggestion
// list shows a 24-episode series under "Filme".
func TestFolderUnitMovieFormatNeedsAMovieFolder(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Anilist: anilist.New(d)}
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	// AniList says MOVIE - the only signal folderUnit used to have
	m := &anilist.Media{ID: 42, Format: "MOVIE"}
	m.Title.Romaji = "Golden Time"
	s.Anilist.CacheMedia(m)

	for _, tc := range []struct {
		name       string
		folder     string
		files      []string
		wantMovie  bool
		wantSeason int
	}{
		{"one video is a film", "/lib/Golden Time Movie", []string{"movie.mkv"}, true, 0},
		{"episodes are a series", "/lib/Golden Time S02", []string{"e01.mkv", "e02.mkv", "e03.mkv"}, false, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
				VALUES (1, ?, 42, 1, 'anilist')`, tc.folder)
			for _, f := range tc.files {
				d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir)
					VALUES (1, ?, ?, ?, 0)`, tc.folder+"/"+f, tc.folder, f)
			}
			_, season, isMovie := s.folderUnit(1, tc.folder)
			if isMovie != tc.wantMovie {
				t.Errorf("isMovie = %v, want %v", isMovie, tc.wantMovie)
			}
			if season != tc.wantSeason {
				t.Errorf("season = %d, want %d", season, tc.wantSeason)
			}
		})
	}
}
