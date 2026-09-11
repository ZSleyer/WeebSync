package api

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func TestWatchDefaultsRoundTripAndValidation(t *testing.T) {
	mux, _, c := setupAiTest(t, nil)
	rec := doReq(mux, "GET", "/api/auth/watch-defaults", "", c)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"kinds":{}`) {
		t.Fatalf("empty defaults: %d %s", rec.Code, rec.Body)
	}
	body := `{"kinds":{"anime-series":{"localPath":"Anime","subfolder":true,"template":"{title} - S{season:02}E{episode:02}"},"movie":{"localPath":"","template":""}},"common":{"renameProvider":"tvdb","wantDub":"Ger","airedMapping":true}}`
	if rec = doReq(mux, "PUT", "/api/auth/watch-defaults", body, c); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/auth/watch-defaults?serverId=1&path=/anime/Frieren", "", c)
	got := rec.Body.String()
	for _, want := range []string{`"anime-series":{"localPath":"Anime"`, `"renameProvider":"tvdb"`, `"kind":"anime-series"`, `"fields":{`, `"wantDub":"Ger"`, `"airedMapping":true`,
		// stored without the three-way choice: read back as the remote folder
		`"subfolderSource":"remote"`, `"title":"Frieren"`} {
		if !strings.Contains(got, want) {
			t.Errorf("get: missing %s in %s", want, got)
		}
	}
	if strings.Contains(got, `"movie":`) {
		t.Errorf("an empty kind is not stored: %s", got)
	}
	for _, bad := range []string{
		`{"kinds":{"anime":{"localPath":"x"}}}`,
		`{"kinds":{"movie":{"localPath":"../x"}}}`,
		`{"common":{"renameProvider":"imdb"}}`,
		`{"common":{"renameOrdering":"random"}}`,
		`{"kinds":{"movie":{"localPath":"x","subfolderSource":"bogus"}}}`,
		`{"kinds":{"movie":{"localPath":"x","subfolderSource":"title","subfolderSeparator":"/"}}}`,
	} {
		if rec = doReq(mux, "PUT", "/api/auth/watch-defaults", bad, c); rec.Code != 400 {
			t.Errorf("%s: want 400, got %d %s", bad, rec.Code, rec.Body)
		}
	}
}

func TestAiProposeCarriesTheUsersDefaults(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	p, reason := s.aiPropose(context.Background(), 1, "watch", s.aiRefFor(1, 1, "/anime/Frieren"), "Frieren", "", "")
	if reason != "" || p.Fields.LocalPath != s.DownloadRoot || !p.Fields.Subfolder {
		t.Fatalf("without defaults the download root is the target: %+v %q", p.Fields, reason)
	}
	body := `{"kinds":{"anime-series":{"localPath":"Anime","subfolder":false,"template":"{title}/{title} - {episode:02}","separator":" "}},"common":{"renameTitleLang":"de-DE","plexSubLang":"Ger:forced"}}`
	if rec := doReq(mux, "PUT", "/api/auth/watch-defaults", body, c); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	p, reason = s.aiPropose(context.Background(), 1, "watch", s.aiRefFor(1, 1, "/anime/Frieren"), "Frieren", "", "")
	if reason != "" {
		t.Fatal(reason)
	}
	f := p.Fields
	if f.LocalPath != "Anime" || f.Subfolder || f.Template != "{title}/{title} - {episode:02}" || f.RenameTitleLang != "de-DE" || f.PlexSubLang != "Ger:forced" {
		t.Errorf("defaults not applied: %+v", f)
	}
	if f.TitleOverride != "Frieren" || f.RemotePath != "/anime/Frieren" {
		t.Errorf("proposal fields lost: %+v", f)
	}
}

// A title subfolder is a choice, not a path: the defaults carry the mode and
// the separator, and the dialog that knows the series builds the folder.
func TestWatchDefaultsTitleSubfolderIsPassedOn(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	body := `{"kinds":{"anime-series":{"localPath":"Anime","subfolderSource":"title","subfolderSeparator":"_"}},"common":{}}`
	if rec := doReq(mux, "PUT", "/api/auth/watch-defaults", body, c); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	// the assistant's proposals inherit the choice the same way a dialog does
	if p, reason := s.aiPropose(context.Background(), 1, "watch", s.aiRefFor(1, 1, "/anime/Frieren"), "Frieren", "", ""); reason != "" ||
		p.Fields.SubfolderSource != "title" || p.Fields.SubfolderSeparator != "_" || p.Fields.LocalPath != "Anime" {
		t.Errorf("proposal did not carry the choice: %+v %q", p.Fields, reason)
	}
	rec := doReq(mux, "GET", "/api/auth/watch-defaults?serverId=1&path=/anime/Frieren", "", c)
	got := rec.Body.String()
	// the season folder travels with the choice, for the dialog to append
	for _, want := range []string{`"subfolderSource":"title"`, `"subfolderSeparator":"_"`, `"title":"Frieren"`, `"localPath":"Anime"`, `"seasonFolder":"Season 01"`} {
		if !strings.Contains(got, want) {
			t.Errorf("get: missing %s in %s", want, got)
		}
	}
	// the bool stays coherent, and nothing was baked into the target
	if strings.Contains(got, `"localPath":"Anime/Frieren"`) || strings.Contains(got, `"subfolder":true`) {
		t.Errorf("defaults must not resolve the folder themselves: %s", got)
	}
}

// The library already holds a season of the show: the target is a new season
// folder beside it, spelled like the sibling, the title is the show's, and the
// template carries the season the file names may not.
func TestFolderTargetFindsTheLibrary(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	m := &anilist.Media{ID: 42, Format: "TV", Schema: anilist.MediaSchema}
	m.Title.Romaji = "Sousou no Frieren 2nd Season"
	s.Anilist.CacheMedia(m)
	folder := "/anime/Frieren 2nd Season"
	s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, ?, '/anime', 'Frieren 2nd Season', 1)`, folder)
	s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, ?, ?, 'e01.mkv', 0)`, folder+"/e01.mkv", folder)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (1, ?, 42, 1, 'anilist')`, folder)
	showKey, season, _ := s.folderUnit(1, folder)
	if season != 2 || showKey == "" {
		t.Fatalf("unit = %q %d", showKey, season)
	}
	// without a library copy the season folder is Plex's spelling
	got := s.folderTarget(1, folder)
	if got.LibraryDir != "" || got.SeasonFolder != "Season 02" || got.Title != "Sousou no Frieren" || got.Season != 2 {
		t.Fatalf("unowned: %+v", got)
	}
	// the library holds season 1, unpadded - and Plex knows a better copy of
	// it under a key that names no folder
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie)
		VALUES (0, 'plex:7:s1', 2160, '', '', '', ?, 1, 0)`, showKey)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie)
		VALUES (0, '/lib/Frieren/Season 1', 1080, '', '', '', ?, 1, 0)`, showKey)
	got = s.folderTarget(1, folder)
	if got.LibraryDir != "/lib/Frieren" || got.SeasonFolder != "Season 2" {
		t.Fatalf("owned: %+v", got)
	}
	body := `{"kinds":{"anime-series":{"localPath":"Anime","subfolderSource":"title","template":"{title} - S{season:02}E{episode:02}"}},"common":{}}`
	if rec := doReq(mux, "PUT", "/api/auth/watch-defaults", body, c); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	rec := doReq(mux, "GET", "/api/auth/watch-defaults?serverId=1&path="+url.QueryEscape(folder), "", c)
	out := rec.Body.String()
	for _, want := range []string{`"libraryDir":"/lib/Frieren"`, `"seasonFolder":"Season 2"`, `"season":2`, `"title":"Sousou no Frieren"`,
		// the library wins over the kind's folder, and the choice is settled
		`"localPath":"/lib/Frieren/Season 2"`, `"subfolderSource":"none"`, `"template":"{title} - S02E{episode:02}"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
	// the library holds this very season: the sync goes into it
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie)
		VALUES (0, '/lib/Frieren/Season 2', 1080, '', '', '', ?, 2, 0)`, showKey)
	if got = s.folderTarget(1, folder); got.LibraryDir != "/lib/Frieren" || got.SeasonFolder != "Season 2" {
		t.Fatalf("same season: %+v", got)
	}
}

// A folder that is the whole show - season folders inside - gets no season
// segment: the seasons are its own, and the target is the show root.
func TestFolderTargetShowRootHasNoSeason(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	for _, sub := range []string{"Season 1", "Season 2"} {
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, ?, '/anime/Frieren', ?, 1)`, "/anime/Frieren/"+sub, sub)
	}
	got := s.folderTarget(1, "/anime/Frieren")
	if got.Season != 0 || got.SeasonFolder != "" || got.Title != "Frieren" || got.Kind != "anime-series" {
		t.Fatalf("show root: %+v", got)
	}
	// an unmatched single-season folder is season 1 of its show
	if got = s.folderTarget(1, "/anime/Other"); got.Season != 1 || got.SeasonFolder != "Season 01" {
		t.Fatalf("unmatched: %+v", got)
	}
}

// A template that lays out folders itself - aired order, Season NN in the
// template - keeps them: the target is the show root, the template untouched.
func TestApplyKeepsFoldersToTheTemplate(t *testing.T) {
	d := WatchDefaults{
		Kinds:  map[string]KindDefaults{"anime-series": {LocalPath: "Anime", Template: "Season_{season:02}/{title} - S{season:02}E{episode:02}"}},
		Common: CommonDefaults{AiredMapping: true},
	}
	f := &aiWatchFields{}
	d.apply(folderTarget{Kind: "anime-series", Season: 1, SeasonFolder: "Season_01", LibraryDir: "/lib/Conan"}, f)
	if f.LocalPath != "/lib/Conan" || f.SeasonFolder != "" || f.Template != "Season_{season:02}/{title} - S{season:02}E{episode:02}" {
		t.Fatalf("aired: %+v", f)
	}
	// no aired mapping, but the template still carries the folder
	d.Common.AiredMapping = false
	f = &aiWatchFields{}
	d.apply(folderTarget{Kind: "anime-series", Season: 3, SeasonFolder: "Season 03"}, f)
	if f.LocalPath != "Anime" || f.SeasonFolder != "" || strings.Contains(f.Template, "S03") {
		t.Fatalf("folder template: %+v", f)
	}
	// a flat template: the season goes into the path and the template
	d.Kinds["anime-series"] = KindDefaults{LocalPath: "Anime", SubfolderSource: "title", Template: "{title} - S{season:02}E{episode:02}"}
	f = &aiWatchFields{}
	d.apply(folderTarget{Kind: "anime-series", Season: 3, SeasonFolder: "Season 03"}, f)
	if f.LocalPath != "Anime" || f.SeasonFolder != "Season 03" || f.Template != "{title} - S03E{episode:02}" || f.SubfolderSource != "title" {
		t.Fatalf("flat template: %+v", f)
	}
	// the template is filled even when the library names the folder
	f = &aiWatchFields{}
	d.apply(folderTarget{Kind: "anime-series", Season: 3, SeasonFolder: "Season 03", LibraryDir: "/lib/Show"}, f)
	if f.LocalPath != "/lib/Show/Season 03" || f.Template != "{title} - S03E{episode:02}" || f.SubfolderSource != "none" {
		t.Fatalf("library: %+v", f)
	}
}

func TestPinSeason(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"{title} - S{season:02}E{episode:02}", "{title} - S03E{episode:02}"},
		{"{title} {season}x{episode:02}", "{title} 3x{episode:02}"},
		{"{title} - {episode:02}", "{title} - {episode:02}"},
		{"", ""},
	} {
		if got := pinSeason(tc.in, 3); got != tc.want {
			t.Errorf("pinSeason(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
