package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// pendingFixture is a watch with aired mapping whose season map knows episodes
// up to 1207, plus a download root on disk.
func pendingFixture(t *testing.T) (*Server, string) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	root := t.TempDir()
	s := &Server{DB: d, DownloadRoot: root}
	d.Exec(`INSERT INTO users (id, email, is_admin, locale) VALUES (1,'a@example.com',1,'de')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO watches (id, user_id, server_id, remote_path, local_path, template, aired_mapping)
		VALUES (1, 1, 1, '/ftp/Conan', 'Conan', 'Season_{season:02}/{title} - S{season:02}E{episode:02}', 1)`)
	// source "none" is what sourceTag yields without a provider client, so the
	// map counts as fresh and Resolve reads it instead of rebuilding it away
	d.Exec(`INSERT INTO season_maps_meta (server_id, folder, source, updated_at)
		VALUES (1,'/ftp/Conan','none',datetime('now'))`)
	d.Exec(`INSERT INTO season_maps (server_id, folder, token, season, episode) VALUES (1,'/ftp/Conan','1207',34,21)`)
	return s, root
}

// The folder name follows the interface language, because it is something the
// user sees on disk.
func TestUnsortedDirFollowsLocale(t *testing.T) {
	s, _ := pendingFixture(t)
	if got := s.unsortedDir(1); got != "_Unzugeordnet" {
		t.Errorf("german user got %q", got)
	}
	s.DB.Exec(`UPDATE users SET locale = 'en' WHERE id = 1`)
	if got := s.unsortedDir(1); got != "_Unsorted" {
		t.Errorf("english user got %q", got)
	}
}

// An episode the provider does not list yet must not be filed by its guess: it
// goes to the collecting folder and is reported back, while a number the
// provider knows is named and filed as always.
func TestWatchNameFnQuarantinesTheUnknown(t *testing.T) {
	s, _ := pendingFixture(t)
	var w Watch
	w.ID, w.UserID, w.ServerID = 1, 1, 1
	w.RemotePath, w.LocalPath = "/ftp/Conan", "Conan"
	w.Template = "Season_{season:02}/{title} - S{season:02}E{episode:02}"
	w.TitleOverride, w.AiredMapping, w.Mode = "Detektiv Conan", true, "template"

	fn, waiting := s.watchNameFnQuarantine(w, "_Unzugeordnet")
	if fn == nil {
		t.Fatal("no name function")
	}
	// 1207 is in the map: filed normally
	if got := fn("[Grp] Detective Conan - 1207 [1080p].mkv"); got != "Season_34/Detektiv Conan - S34E21.mkv" {
		t.Errorf("known episode -> %q", got)
	}
	// 1208 is not: guessed as S34E22 but collected, not filed
	got := fn("[Grp] Detective Conan - 1208 [1080p].mkv")
	want := "_Unzugeordnet/Detektiv Conan - S34E22.mkv"
	if got != want {
		t.Errorf("unknown episode -> %q, want %q", got, want)
	}
	p := waiting()
	if len(p) != 1 || p[0].Token != "1208" || p[0].Name != want {
		t.Fatalf("waiting list = %+v", p)
	}
}

// Without a collecting folder the behaviour is the old one, which is what the
// dry-run previews need.
func TestWatchNameFnWithoutQuarantine(t *testing.T) {
	s, _ := pendingFixture(t)
	var w Watch
	w.ID, w.UserID, w.ServerID = 1, 1, 1
	w.RemotePath, w.LocalPath = "/ftp/Conan", "Conan"
	w.Template = "Season_{season:02}/{title} - S{season:02}E{episode:02}"
	w.TitleOverride, w.AiredMapping, w.Mode = "Detektiv Conan", true, "template"

	fn := s.watchNameFn(w)
	if got := fn("[Grp] Detective Conan - 1208 [1080p].mkv"); got == "" ||
		filepath.Dir(got) == "_Unzugeordnet" {
		t.Errorf("preview must not quarantine, got %q", got)
	}
}

// Once the provider lists the number, the file moves into its season folder
// under the name it would have had all along, and stops being tracked.
func TestFilePendingEpisodeMovesAndForgets(t *testing.T) {
	s, root := pendingFixture(t)
	var w Watch
	w.ID, w.UserID, w.ServerID = 1, 1, 1
	w.RemotePath, w.LocalPath = "/ftp/Conan", "Conan"
	w.Template = "Season_{season:02}/{title} - S{season:02}E{episode:02}"
	w.TitleOverride, w.Mode = "Detektiv Conan", "template"

	dir := filepath.Join(root, "Conan", "_Unzugeordnet")
	os.MkdirAll(dir, 0o755)
	from := filepath.Join(dir, "Detektiv Conan - S34E22.mkv")
	os.WriteFile(from, []byte("x"), 0o644)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (7,1,1,'/ftp/Conan/1208.mkv',?, 'done')`, from)
	s.DB.Exec(`INSERT INTO pending_episodes (download_id, watch_id, token, local_path, remote_path)
		VALUES (7,1,'1208',?, '/ftp/Conan/1208.mkv')`, from)

	s.filePendingEpisode(7, w, from, 34, 22)

	dst := filepath.Join(root, "Conan", "Season_34", "Detektiv Conan - S34E22.mkv")
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("file not filed: %v", err)
	}
	if _, err := os.Stat(from); err == nil {
		t.Error("the collected copy should be gone")
	}
	if n := s.pendingCount(1); n != 0 {
		t.Errorf("still %d waiting", n)
	}
	// the history has to point at the file that exists
	var local string
	s.DB.QueryRow(`SELECT local_path FROM downloads WHERE id = 7`).Scan(&local)
	if local != dst {
		t.Errorf("download still points at %q", local)
	}
}

// The episode arrived some other way in the meantime: the collected copy is the
// duplicate, and a good file must not be overwritten.
func TestFilePendingEpisodeKeepsAnExistingTarget(t *testing.T) {
	s, root := pendingFixture(t)
	var w Watch
	w.ID, w.UserID, w.ServerID = 1, 1, 1
	w.RemotePath, w.LocalPath = "/ftp/Conan", "Conan"
	w.Template = "Season_{season:02}/{title} - S{season:02}E{episode:02}"
	w.TitleOverride, w.Mode = "Detektiv Conan", "template"

	dir := filepath.Join(root, "Conan", "_Unzugeordnet")
	os.MkdirAll(dir, 0o755)
	from := filepath.Join(dir, "Detektiv Conan - S34E22.mkv")
	os.WriteFile(from, []byte("collected"), 0o644)
	dst := filepath.Join(root, "Conan", "Season_34", "Detektiv Conan - S34E22.mkv")
	os.MkdirAll(filepath.Dir(dst), 0o755)
	os.WriteFile(dst, []byte("the real one"), 0o644)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (7,1,1,'/ftp/Conan/1208.mkv',?, 'done')`, from)
	s.DB.Exec(`INSERT INTO pending_episodes (download_id, watch_id, token, local_path, remote_path)
		VALUES (7,1,'1208',?, '/ftp/Conan/1208.mkv')`, from)

	s.filePendingEpisode(7, w, from, 34, 22)

	if b, _ := os.ReadFile(dst); string(b) != "the real one" {
		t.Error("an existing target was overwritten")
	}
	if n := s.pendingCount(1); n != 0 {
		t.Errorf("still %d waiting", n)
	}
}

// A file removed by hand must not keep an entry alive forever.
func TestProcessPendingDropsVanishedFiles(t *testing.T) {
	s, root := pendingFixture(t)
	gone := filepath.Join(root, "Conan", "_Unzugeordnet", "weg.mkv")
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (7,1,1,'/ftp/Conan/1208.mkv',?, 'done')`, gone)
	s.DB.Exec(`INSERT INTO pending_episodes (download_id, watch_id, token, local_path, remote_path, created_at)
		VALUES (7,1,'1208',?, '/ftp/Conan/1208.mkv', datetime('now','-2 hours'))`, gone)

	s.processPendingEpisodes(context.Background())

	if n := s.pendingCount(1); n != 0 {
		t.Errorf("a vanished file left %d entries behind", n)
	}
}

// The waiting file must not be fetched again: its target season folder is still
// empty, so nothing else would stop the next check.
func TestPendingRemotePathsFeedTheSkip(t *testing.T) {
	s, _ := pendingFixture(t)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (7,1,1,'/ftp/Conan/1208.mkv','/tmp/x.mkv','done')`)
	s.DB.Exec(`INSERT INTO pending_episodes (download_id, watch_id, token, local_path, remote_path)
		VALUES (7,1,'1208','/tmp/x.mkv','/ftp/Conan/1208.mkv')`)

	skip := s.pendingRemotePaths(1)
	if !skip["/ftp/Conan/1208.mkv"] {
		t.Fatal("the waiting file is not on the skip list")
	}
	take := andNotPending(nil, skip)
	if take("/ftp/Conan/1208.mkv") {
		t.Error("a waiting file must not be fetched again")
	}
	if !take("/ftp/Conan/1209.mkv") {
		t.Error("everything else still passes")
	}
}
