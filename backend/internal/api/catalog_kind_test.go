package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestFolderKind(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`); err != nil {
		t.Fatal(err)
	}
	seed := func(parent, name string, dir int) {
		d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,?)`,
			parent+"/"+name, parent, name, dir)
	}
	// a film: one video, no subfolders
	seed("/Movie27", "Conan Movie 27.mkv", 0)
	// a series: many episodes
	for _, n := range []string{"ep01.mkv", "ep02.mkv", "ep03.mkv"} {
		seed("/Conan", n, 0)
	}
	// a series by structure: season subfolders, no direct videos
	seed("/Show", "Season 01", 1)

	s := &Server{DB: d}
	cases := []struct{ folder, name, want string }{
		{"/Movie27", "Gyakuten Saiban", "movie"}, // neutral name → count path (1 video)
		{"/Conan", "Detektiv Conan", "series"},
		{"/Show", "Some Show", "series"},
		{"/NotIndexed", "Some Movie", "movie"}, // name fallback
		{"/NotIndexed2", "Some Show", ""},      // nothing conclusive
	}
	for _, c := range cases {
		if got := s.folderKind(1, c.folder, c.name); got != c.want {
			t.Errorf("folderKind(%q,%q) = %q, want %q", c.folder, c.name, got, c.want)
		}
	}
}
