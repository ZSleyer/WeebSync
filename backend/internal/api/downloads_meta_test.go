package api

import (
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// The renamed target name is the better source for season/episode: it is what
// the watch's template produced, so it already carries the aired-order
// correction the remote name never had.
func TestEpisodeNumbers(t *testing.T) {
	for _, tc := range []struct {
		name        string
		local       string
		remote      string
		wantSeason  int
		wantEpisode int
	}{
		{"renamed target", "Show - S03E05.mkv", "[Grp] Show - 05 (1080p).mkv", 3, 5},
		{"aired mapping only in the target", "Show - S34E01.mkv", "[Grp] Show - 1187 (1080p).mkv", 34, 1},
		{"no rename rule, absolute number", "[Grp] Show - 1187 (1080p).mkv", "[Grp] Show - 1187 (1080p).mkv", 0, 1187},
		{"fractional recap has no integer episode", "Show - 1165.5.mkv", "Show - 1165.5.mkv", 0, 0},
		{"not an episode at all", "cover.jpg", "cover.jpg", 0, 0},
		{"empty target falls back to the remote name", "", "Show - S02E07.mkv", 2, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			se, ep := episodeNumbers(tc.local, tc.remote)
			if se != tc.wantSeason || ep != tc.wantEpisode {
				t.Errorf("episodeNumbers(%q, %q) = (%d, %d), want (%d, %d)",
					tc.local, tc.remote, se, ep, tc.wantSeason, tc.wantEpisode)
			}
		})
	}
}

// metaTestServer gives a Server with a real schema, one user and one server.
func metaTestServer(t *testing.T) *Server {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`)
	d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (2, 'b@example.com', '')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1, 1, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`)
	return &Server{DB: d, Anilist: anilist.New(d)}
}

func addDownload(t *testing.T, s *Server, userID int64, remote, local string) int64 {
	t.Helper()
	res, err := s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status)
		VALUES (?, 1, ?, ?, 'done')`, userID, remote, local)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

// One folder is looked up once no matter how many of its files are queued, and
// a folder without a catalog match still yields an item - the frontend reads a
// missing item as "the metadata is stale" and would refetch forever otherwise.
func TestDownloadsMetaGroupsPerFolder(t *testing.T) {
	s := metaTestServer(t)
	m := &anilist.Media{ID: 42, Description: "A <br>show<i> about things</i>"}
	m.Title.Romaji = "Some Show"
	m.CoverImage.Large = "https://example.com/cover.jpg"
	s.Anilist.CacheMedia(m)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1, '/lib/Some Show', 42, 1, 'anilist')`)

	for _, n := range []string{"E01", "E02", "E03"} {
		addDownload(t, s, 1, "/lib/Some Show/"+n+".mkv", "/dl/Some Show/Some Show - S01"+n+".mkv")
	}
	unmatched := addDownload(t, s, 1, "/lib/Unknown/file.mkv", "/dl/Unknown/file.mkv")

	resp, err := s.downloadsMeta(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Groups) != 2 {
		t.Fatalf("groups = %d, want 2 (one matched folder, one unmatched)", len(resp.Groups))
	}
	if len(resp.Items) != 4 {
		t.Fatalf("items = %d, want one per download", len(resp.Items))
	}
	g := resp.Groups["1|/lib/Some Show"]
	if g.Title != "Some Show" || g.Cover != "https://example.com/cover.jpg" {
		t.Errorf("group = %+v, want the cached media's title and cover", g)
	}
	if g.Overview != "A show about things" {
		t.Errorf("overview = %q, want the description with its tags stripped", g.Overview)
	}
	if g.Links.Anilist != "https://anilist.co/anime/42" {
		t.Errorf("anilist link = %q", g.Links.Anilist)
	}
	if it := resp.Items["1"]; it.Group != "1|/lib/Some Show" || it.Season != 1 || it.Episode != 1 {
		t.Errorf("first item = %+v, want group + S01E01", it)
	}
	if it, ok := resp.Items[strconv.FormatInt(unmatched, 10)]; !ok || resp.Groups[it.Group].Title != "" {
		t.Errorf("unmatched download must still get an item with a title-less group, got %+v", it)
	}
}

// The match usually sits on the show folder while the files live in a season
// subfolder; both seasons must still land in one group.
func TestDownloadsMetaSeasonSubfolder(t *testing.T) {
	s := metaTestServer(t)
	m := &anilist.Media{ID: 7}
	m.Title.Romaji = "Long Runner"
	s.Anilist.CacheMedia(m)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1, '/lib/Long Runner', 7, 1, 'anilist')`)

	addDownload(t, s, 1, "/lib/Long Runner/Season 01/e1.mkv", "/dl/Long Runner/Season 01/Long Runner - S01E01.mkv")
	addDownload(t, s, 1, "/lib/Long Runner/Season 02/e1.mkv", "/dl/Long Runner/Season 02/Long Runner - S02E01.mkv")

	resp, err := s.downloadsMeta(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Groups) != 1 {
		t.Fatalf("groups = %d, want 1: both season folders share the show", len(resp.Groups))
	}
	if g := resp.Groups["1|/lib/Long Runner"]; g.Title != "Long Runner" {
		t.Errorf("group = %+v, want the parent folder's match", g)
	}
}

// Same guard as handleDownloadsList: another user's downloads stay invisible.
func TestDownloadsMetaUserScoped(t *testing.T) {
	s := metaTestServer(t)
	addDownload(t, s, 2, "/lib/Other/e1.mkv", "/dl/Other/e1.mkv")

	resp, err := s.downloadsMeta(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 0 {
		t.Errorf("items = %d, want 0", len(resp.Items))
	}
}
