package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestFolderKind(t *testing.T) {
	d := dbtest.Open(t)
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

// The local library has no remote index; its walk tells the same apart.
func TestItemKindLocalSingleEpisode(t *testing.T) {
	s, root := sizeTestServer(t)
	writeFiles(t, root+"/New Show", map[string]int64{"New Show E01 [1080p].mkv": 10})
	writeFiles(t, root+"/A Film", map[string]int64{"A.Film.2.(2024).1080p.mkv": 10})
	if got := s.itemKind(localServerID, "/New Show", "New Show"); got != "series" {
		t.Errorf("one episode locally: %q, want series", got)
	}
	if got := s.itemKind(localServerID, "/A Film", "A Film"); got != "movie" {
		t.Errorf("one film locally: %q, want movie", got)
	}
}

// A show that has only just started holds one file, and that is no film when
// the file names its episode. Film names with numbers in them stay films.
func TestFolderKindSingleEpisode(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	for file, want := range map[string]string{
		"Choujun! Choujou Senpai E01 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv": "series",
		"Kill Ao - 01 [1080p].mkv":                                         "series",
		"[Group] Some Show - 03v2 [1080p].mkv":                             "series",
		"Some.Show.S02E01.German.DL.1080p.WEB.mkv":                         "series",
		"Nobody.2.(2025).(Bluray-1080p).(x265).(AC3.5.1)-(FuN).mkv":        "movie",
		"Planes.2.-.Immer.im.Einsatz.(2014).(Bluray-1080p).(x264).mkv":     "movie",
		"10 Cloverfield Lane (2016).mkv":                                   "movie",
		"Slayers.Great.1997.German.DL.AC3.1080p.BDRip.10bit.x264.mkv":      "movie",
		"Psycho Pass - The Movie [1080p+][AAC][GerDub][Web-DL].mkv":        "movie",
		"[Fag] ReZero - Memory Snow (v2) [BD 1080p Ma10 AAC].mkv":          "movie",
		"Chainsaw.Man.-.The.Movie.Reze.Arc.(2025).(WEBDL-1080p).mkv":       "movie",
		"[.hell] Tokyo Godfathers [Blu-ray][Hi10P][E-AC-3][AAC].mkv":       "movie",
		"Assassination Classroom Movie - 365 Days Time [BD 1080p].mkv":     "movie",
		"Sailor Moon - S00E02 [Sailor.Moon.Film.1.540p.German].mkv":        "movie",
		"91 Days - 13 (OVA) [720p][OPUS][JapDub][GerSub][BD].mkv":          "series",
		"Typhoon Noruda [1080p][AAC][JapGerDub][GerSub][Web-DL].mkv":       "movie",
		"One Piece Abenteuer auf der Spiralinsel (2001) (WEBDL-1080p).mkv": "movie",
	} {
		folder := "/x/" + file
		d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,0)`,
			folder+"/"+file, folder, file)
		if got := s.folderKind(1, folder, "Neutral"); got != want {
			t.Errorf("one file %q: %q, want %q", file, got, want)
		}
	}
}
