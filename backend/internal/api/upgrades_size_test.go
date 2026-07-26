package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// sizeTestServer builds a server whose local root is a temp dir, with one
// remote server registered.
func sizeTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, DownloadRoot: root, LocalRoots: []string{root}, Anilist: anilist.New(d)}
	d.Exec(`INSERT INTO users (id, email, upgrade_dims) VALUES (1,'u@e.test','res,sub,dub')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'seedbox','sftp','h',22,'u',x'00')`)
	return s, root
}

// writeFiles creates dir/<name> files of the given byte sizes.
func writeFiles(t *testing.T, dir string, files map[string]int64) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, size := range files {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(size); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
}

// addRemoteFiles fills the crawler snapshot for one remote folder.
func addRemoteFiles(t *testing.T, s *Server, serverID int64, folder string, files map[string]int64) {
	t.Helper()
	s.DB.Exec(`INSERT OR REPLACE INTO remote_index (server_id, path, parent, name, is_dir, size)
		VALUES (?, ?, ?, ?, 1, 0)`, serverID, folder, filepath.Dir(folder), filepath.Base(folder))
	for name, size := range files {
		if _, err := s.DB.Exec(`INSERT OR REPLACE INTO remote_index (server_id, path, parent, name, is_dir, size)
			VALUES (?, ?, ?, ?, 0, ?)`, serverID, folder+"/"+name, folder, name, size); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAlreadyHave(t *testing.T) {
	set := func(ns ...int64) map[int64]bool {
		m := map[int64]bool{}
		for _, n := range ns {
			m[n] = true
		}
		return m
	}
	cases := []struct {
		name          string
		local, remote map[int64]bool
		want          bool
	}{
		{"same files, other names", set(10, 20), set(20, 10), true},
		{"remote is a subset", set(10, 20, 30), set(20), true},
		{"remote brings one more", set(10, 20), set(10, 20, 30), false},
		{"re-encode: every size differs", set(10, 20), set(11, 21), false},
		{"local unknown (mount missing)", set(), set(10), false},
		{"remote unknown (not crawled)", set(10), set(), false},
	}
	for _, c := range cases {
		if got := alreadyHave(c.local, c.remote); got != c.want {
			t.Errorf("%s: alreadyHave = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestCopySizesIgnoresNonVideo(t *testing.T) {
	s, root := sizeTestServer(t)
	dir := filepath.Join(root, "Show", "Season 01")
	writeFiles(t, dir, map[string]int64{"e01.mkv": 1000, "e02.mkv": 2000, "cover.jpg": 500, "empty.mkv": 0})
	got := s.copySizes(0, dir)
	want := map[int64]bool{1000: true, 2000: true}
	if len(got) != len(want) {
		t.Fatalf("copySizes = %v, want %v", got, want)
	}
	for size := range want {
		if !got[size] {
			t.Errorf("size %d missing from %v", size, got)
		}
	}

	addRemoteFiles(t, s, 1, "/rem/Show S01", map[string]int64{"e01.mkv": 1000, "e02.mkv": 2000, "nfo.txt": 12})
	rem := s.copySizes(1, "/rem/Show S01")
	if len(rem) != 2 || !rem[1000] || !rem[2000] {
		t.Errorf("remote copySizes = %v, want the two video sizes", rem)
	}

	// a folder the crawler has not reached carries no information
	if n := len(s.copySizes(1, "/rem/Never Listed")); n != 0 {
		t.Errorf("uncrawled folder returned %d sizes, want 0", n)
	}
}

// The reported bug: the same files under different names. The remote name
// promises language tracks the measured local copy does not report, so the
// language axis fires - and the byte sizes say it is the very same copy.
func TestBuildUpgradesSkipsSizeIdenticalCopy(t *testing.T) {
	s, root := sizeTestServer(t)
	local := filepath.Join(root, "Anime", "Some Show", "Season 01")
	writeFiles(t, local, map[string]int64{"Some Show - S01E01.mkv": 1500, "Some Show - S01E02.mkv": 1600})
	remote := "/seed/Some Show [GerEngSub][1080p]"
	addRemoteFiles(t, s, 1, remote, map[string]int64{
		"[Group] Some Show - 01 (1080p) [GerEngSub].mkv": 1500,
		"[Group] Some Show - 02 (1080p) [GerEngSub].mkv": 1600,
	})
	// Both sides guessed from their file names, so the language comparison is
	// on equal footing and fires: the size is the only thing that can tell
	// these two copies apart, which is exactly what this test is about.
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (0, ?, 1080, '', 'Ger', 'tvdb:1', 1, 0)`, local)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (1, ?, 1080, '', 'Eng,Ger', 'tvdb:1', 1, 0)`, remote)

	if got := s.buildUpgrades(1); len(got) != 0 {
		t.Fatalf("size-identical copy suggested as an upgrade: %+v", got[0])
	}

	// one genuinely different file (a re-encode is never the same size) and the
	// suggestion comes back
	s.DB.Exec(`INSERT OR REPLACE INTO remote_index (server_id, path, parent, name, is_dir, size)
		VALUES (1, ?, ?, '[Group] Some Show - 03 (1080p) [GerEngSub].mkv', 0, 4200)`,
		remote+"/[Group] Some Show - 03 (1080p) [GerEngSub].mkv", remote)
	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want 1 suggestion once the remote brings a file of its own, got %d", len(got))
	}
	if !got[0].ImprovesSub {
		t.Errorf("suggestion should still be the sub upgrade, got %+v", got[0])
	}
}

// A season the library holds under another season number is not incomplete: the
// files are on disk, whatever the mapping filed them as.
func TestAddMissingUnitsSkipsFilesAlreadyOnDisk(t *testing.T) {
	s, root := sizeTestServer(t)
	// the library holds the episodes, but the local copy is filed as season 1
	local := filepath.Join(root, "Anime", "Long Show", "Season 01")
	writeFiles(t, local, map[string]int64{"e01.mkv": 900, "e02.mkv": 950})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season)
		VALUES (0, ?, 1080, 'tvdb:7', 1)`, local)
	// the remote copy of the very same files is mapped to season 2
	remote := "/seed/Long Show S2"
	addRemoteFiles(t, s, 1, remote, map[string]int64{"ep01.mkv": 900, "ep02.mkv": 950})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season)
		VALUES (1, ?, 1080, 'tvdb:7', 2)`, remote)
	// a title, so the unit is not dropped for lack of one
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1, ?, 55, 1, 'tvdb')`, remote)

	acc := newAcc()
	s.addMissingUnits(acc)
	if got := acc.list(map[string]bool{}); len(got) != 0 {
		t.Fatalf("season already on disk reported as incomplete: %+v", got[0])
	}

	// a season that really is missing still surfaces
	other := "/seed/Long Show S3"
	addRemoteFiles(t, s, 1, other, map[string]int64{"ep01.mkv": 7000})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season)
		VALUES (1, ?, 1080, 'tvdb:7', 3)`, other)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1, ?, 55, 1, 'tvdb')`, other)
	acc = newAcc()
	s.addMissingUnits(acc)
	got := acc.list(map[string]bool{})
	if len(got) != 1 || got[0].Season != 3 {
		t.Fatalf("want the genuinely missing season 3, got %+v", got)
	}
}
