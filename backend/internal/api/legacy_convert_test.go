package api

import (
	"encoding/json"
	"testing"

	"github.com/ch4d1/weebsync/internal/rename"
)

func ptr[T any](v T) *T { return &v }

// The example straight from the old project's README: a regex with three
// groups and a renumber in the template.
func TestConvertSyncMapRenumber(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "Something test",
		OriginFolder:       "/anime/something/",
		FileRegex:          `.*? E([0-9]+)v?(.)? (.*)?\.extension`,
		FileRenameTemplate: "{{$syncName}} - {{renumber $1 13}} {{$3}}.extension",
		Rename:             ptr(true),
	})
	if w.Mode != "template" {
		t.Fatalf("mode = %q, want template", w.Mode)
	}
	if w.Template != "{title} - {episode-13:02}" {
		t.Errorf("template = %q", w.Template)
	}
	if w.TitleOverride != "Something test" || w.Offset != 13 {
		t.Errorf("titleOverride = %q, offset = %d", w.TitleOverride, w.Offset)
	}
	if w.RemotePath != "/anime/something" {
		t.Errorf("remotePath = %q", w.RemotePath)
	}
	// the dropped {{$3}} and the lost download filter must both be reported
	want := map[string]bool{"legacyWarnDroppedGroups": true, "legacyWarnFilterDropped": true}
	for _, g := range w.Warnings {
		delete(want, g)
	}
	if len(want) > 0 {
		t.Errorf("missing warnings %v, got %v", want, w.Warnings)
	}
}

// The converted template has to survive the actual rename engine - that is the
// whole point of mapping renumber onto {episode-N}.
func TestConvertedTemplateRenames(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "One Piece",
		FileRenameTemplate: "{{$syncName}} - S23E{{renumber $1 1155}}.mkv",
		Rename:             ptr(true),
	})
	got, err := rename.New("One Piece E1156 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", rename.Options{
		Mode: w.Mode, Template: w.Template, TitleOverride: w.TitleOverride,
	})
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got != "One Piece - S23E01.mkv" {
		t.Errorf("got %q", got)
	}
}

// Forks added block helpers the original never had. Their branch keywords must
// not survive as literals, and the leftovers of dropped capture groups must not
// either - a real config produced "S00S23E{episode-1155:02}_()[][][][][]".
func TestConvertSyncMapBlockHelper(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:        "One_Piece",
		FileRegex: `One Piece E([0-9]+(?:\.5)?) \[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]`,
		FileRenameTemplate: `One_Piece_-_{{#ifContains $1 ".5"}}S00{{renumber $1 1155.5}}{{else}}` +
			`S23E{{renumber $1 1155}}{{/ifContains}}_({{$1}})[{{$2}}][{{$3}}][{{$4}}][{{$5}}][{{$6}}].mkv`,
		Rename: ptr(true),
	})
	if w.Mode != "template" {
		t.Fatalf("mode = %q", w.Mode)
	}
	if w.Template != "One_Piece_-_S23E{episode-1155:02}" {
		t.Errorf("template = %q", w.Template)
	}
	if w.Offset != 1155 {
		t.Errorf("offset = %d", w.Offset)
	}
	want := map[string]bool{"legacyWarnConditional": true, "legacyWarnDroppedGroups": true}
	for _, g := range w.Warnings {
		delete(want, g)
	}
	if len(want) > 0 {
		t.Errorf("missing warnings %v, got %v", want, w.Warnings)
	}
}

// A deliberate "_-_" separator must survive the cleanup untouched.
func TestConvertSyncMapKeepsSeparators(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "Clevatess",
		FileRegex:          `([0-9]{2})`,
		FileRenameTemplate: `{{$syncName}}_-_S02E{{renumber $1 0}}.mkv`,
		Rename:             ptr(true),
	})
	if w.Template != "{title}_-_S02E{episode:02}" {
		t.Errorf("template = %q", w.Template)
	}
}

// The regex replacement IS the whole new name, so its extension has to stay.
func TestConvertSyncMapRegexKeepsExtension(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "Show",
		FileRegex:          `^(.*) - (\d+)\.mkv$`,
		FileRenameTemplate: `{{$syncName}} - {{$2}}.mkv`,
		Rename:             ptr(true),
	})
	if w.Mode != "regex" || w.Replacement != "Show - ${2}.mkv" {
		t.Errorf("mode %q replacement %q", w.Mode, w.Replacement)
	}
}

// End to end over the shapes a real config produced: convert, then run the
// result through the rename engine.
func TestConvertedTemplatesRenameRealShapes(t *testing.T) {
	cases := []struct {
		id, tmpl, file, want string
	}{
		{
			"Clevatess", `{{$syncName}}_-_S02E{{renumber $1 0}}.mkv`,
			"Clevatess E05 [GerJapDub].mkv", "Clevatess_-_S02E05.mkv",
		},
		{
			"Dr._Stone", `{{$syncName}}_-_S04E{{renumber $1 -25}}.mkv`,
			"[Grp] Dr. Stone - 26v2 [WebBD 1080p+ AAC].mkv", "Dr._Stone_-_S04E51.mkv",
		},
		{
			"One_Piece",
			`One_Piece_-_{{#ifContains $1 ".5"}}S00{{renumber $1 1155.5}}{{else}}` +
				`S23E{{renumber $1 1155}}{{/ifContains}}_({{$1}})[{{$2}}].mkv`,
			"One Piece E1156 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", "One_Piece_-_S23E01.mkv",
		},
	}
	for _, c := range cases {
		w := convertSyncMap(legacySyncMap{ID: c.id, FileRenameTemplate: c.tmpl, Rename: ptr(true)})
		got, err := rename.New(c.file, rename.Options{
			Mode: w.Mode, Template: w.Template, TitleOverride: w.TitleOverride,
		})
		if err != nil || got != c.want {
			t.Errorf("%s: template %q\n  got  %q (err %v)\n  want %q", c.id, w.Template, got, err, c.want)
		}
	}
}

func TestConvertSyncMapPadding(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		FileRenameTemplate: "E{{renumber $1 1155 3}}",
		Rename:             ptr(true),
	})
	if w.Template != "E{episode-1155:03}" {
		t.Errorf("template = %q", w.Template)
	}
	// a negative offset adds instead of subtracting
	w = convertSyncMap(legacySyncMap{FileRenameTemplate: "E{{renumber $1 -5}}", Rename: ptr(true)})
	if w.Template != "E{episode+5:02}" {
		t.Errorf("template = %q", w.Template)
	}
}

func TestConvertSyncMapRegexFallback(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "Conan",
		FileRegex:          `^.*? E(\d+) (.*)\.mkv$`,
		FileRenameTemplate: "{{$syncName}} - {{$1}} {{$2}}.mkv",
		Rename:             ptr(true),
	})
	if w.Mode != "regex" {
		t.Fatalf("mode = %q, want regex", w.Mode)
	}
	if w.Replacement != "Conan - ${1} ${2}.mkv" {
		t.Errorf("replacement = %q", w.Replacement)
	}
	if w.Pattern != `^.*? E(\d+) (.*)\.mkv$` || w.Error != "" {
		t.Errorf("pattern = %q, error = %q", w.Pattern, w.Error)
	}
}

// JS regexes may use lookarounds; RE2 cannot compile them.
func TestConvertSyncMapBadRegex(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		FileRegex:          `(?<=E)(\d+)`,
		FileRenameTemplate: "{{$1}}.mkv",
		Rename:             ptr(true),
	})
	if w.Error != "legacyErrBadRegex" {
		t.Errorf("error = %q", w.Error)
	}
}

// rename: false means "download untouched" - an empty template does that.
func TestConvertSyncMapNoRename(t *testing.T) {
	w := convertSyncMap(legacySyncMap{
		ID:                 "Plain",
		FileRegex:          `.*`,
		FileRenameTemplate: "{{$syncName}}.mkv",
		Rename:             ptr(false),
	})
	if w.Mode != "template" || w.Template != "" || w.Pattern != "" {
		t.Errorf("got mode %q template %q pattern %q", w.Mode, w.Template, w.Pattern)
	}
}

// Old files predate the `rename` flag; it was derived from the two fields.
func TestConvertSyncMapDerivedRenameFlag(t *testing.T) {
	if w := convertSyncMap(legacySyncMap{}); w.Mode != "template" || w.Template != "" {
		t.Errorf("empty map should not rename, got %+v", w)
	}
	w := convertSyncMap(legacySyncMap{FileRegex: `(\d+)`, FileRenameTemplate: "{{$1}}"})
	if w.Mode != "regex" {
		t.Errorf("mode = %q, want regex", w.Mode)
	}
}

func TestConvertLegacyPaths(t *testing.T) {
	cfg := legacyConfig{SyncMaps: []legacySyncMap{
		{ID: "One Piece", OriginFolder: "/a/op", DestinationFolder: `C:\anime\One Piece`},
		{ID: "Conan", OriginFolder: "/a/conan", DestinationFolder: `C:\anime\Conan\{{$syncName}}`},
	}}
	p := convertLegacy(cfg, "/media/anime")
	if got := p.Watches[0].LocalPath; got != "/media/anime/One Piece" {
		t.Errorf("localPath[0] = %q", got)
	}
	if got := p.Watches[1].LocalPath; got != "/media/anime/Conan/Conan" {
		t.Errorf("localPath[1] = %q", got)
	}
}

// A single syncMap has no siblings to share a prefix with; its own folder name
// must still survive the remap.
func TestConvertLegacySinglePath(t *testing.T) {
	p := convertLegacy(legacyConfig{SyncMaps: []legacySyncMap{
		{ID: "x", OriginFolder: "/a", DestinationFolder: "/mnt/data/anime/One Piece"},
	}}, "/media")
	if got := p.Watches[0].LocalPath; got != "/media/One Piece" {
		t.Errorf("localPath = %q", got)
	}
}

func TestConvertLegacyServerAndInterval(t *testing.T) {
	var cfg legacyConfig
	if err := json.Unmarshal([]byte(`{
		"syncOnStart": true,
		"autoSyncIntervalInMinutes": 1,
		"debugFileNames": false,
		"server": {"host": "example.com", "port": 21, "user": "u", "password": "p"},
		"syncMaps": []
	}`), &cfg); err != nil {
		t.Fatal(err)
	}
	p := convertLegacy(cfg, "")
	if p.Server.Protocol != "sftp" || p.Server.Port != 22 || p.Server.OldPort != 21 {
		t.Errorf("server = %+v", p.Server)
	}
	if !p.Server.HasPassword || p.Server.Name != "example.com" {
		t.Errorf("server = %+v", p.Server)
	}
	if p.IntervalMin != 5 { // clamped to the allowed minimum
		t.Errorf("intervalMin = %d", p.IntervalMin)
	}
	if len(p.Warnings) == 0 || p.Warnings[0] != "legacyWarnFtp" {
		t.Errorf("warnings = %v", p.Warnings)
	}
	if len(p.Dropped) != 2 || p.Dropped[0] != "syncOnStart" || p.Dropped[1] != "debugFileNames" {
		t.Errorf("dropped = %v", p.Dropped)
	}
	if got := convertLegacy(legacyConfig{AutoSyncIntervalInMinutes: ptr(99999)}, "").IntervalMin; got != 1440 {
		t.Errorf("intervalMin = %d", got)
	}
}
