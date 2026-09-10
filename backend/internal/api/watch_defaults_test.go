package api

import (
	"context"
	"strings"
	"testing"
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
	for _, want := range []string{`"subfolderSource":"title"`, `"subfolderSeparator":"_"`, `"title":"Frieren"`, `"localPath":"Anime"`} {
		if !strings.Contains(got, want) {
			t.Errorf("get: missing %s in %s", want, got)
		}
	}
	// the bool stays coherent, and nothing was baked into the target
	if strings.Contains(got, `"localPath":"Anime/Frieren"`) || strings.Contains(got, `"subfolder":true`) {
		t.Errorf("defaults must not resolve the folder themselves: %s", got)
	}
}
