package api

import (
	"reflect"
	"strings"
	"testing"
)

func TestSeasonFolderName(t *testing.T) {
	cases := []struct {
		sibling string
		season  int
		want    string
	}{
		{"Season 01", 3, "Season 03"}, // zero-padded sibling -> pad
		{"Season 1", 3, "Season 3"},   // unpadded sibling -> no pad
		{"Specials", 3, "Season 03"},  // non-season sibling -> default pad
	}
	for _, c := range cases {
		if got := seasonFolderName(c.sibling, c.season); got != c.want {
			t.Errorf("seasonFolderName(%q,%d)=%q want %q", c.sibling, c.season, got, c.want)
		}
	}
}

func TestExistingSyncPlan(t *testing.T) {
	// series: into the existing season dir, template carries the fixed season
	p := existingSyncPlan("/media/plex/Show/Season 03", 3, false)
	if p.LocalPath != "/media/plex/Show/Season 03" || p.Template != "{title} - S03E{episode:02}" {
		t.Fatalf("series existing: %+v", p)
	}
	// movie: into its own existing folder
	p = existingSyncPlan("/media/plex/Movies/Film (2020)", 0, true)
	if p.LocalPath != "/media/plex/Movies/Film (2020)" || p.Template != "{title}" {
		t.Fatalf("movie existing: %+v", p)
	}
	// unresolved (plex: fallback key) -> empty plan, UI hides the button
	if p := existingSyncPlan("plex:123:s3", 3, false); p.LocalPath != "" {
		t.Fatalf("fallback should be empty: %+v", p)
	}
}

func TestMissingSyncPlan(t *testing.T) {
	// missing series season: sibling is a Season folder -> new Season under show root
	p := missingSyncPlan("/media/plex/Show/Season 01", 3, false)
	if p.LocalPath != "/media/plex/Show/Season 03" || p.Template != "{title} - S03E{episode:02}" {
		t.Fatalf("missing season (season sibling): %+v", p)
	}
	// flat library: sibling IS the show folder -> Season under it
	p = missingSyncPlan("/media/plex/Show", 2, false)
	if p.LocalPath != "/media/plex/Show/Season 02" || p.Template != "{title} - S02E{episode:02}" {
		t.Fatalf("missing season (flat): %+v", p)
	}
	// unpadded sibling: the new folder mirrors it, in the path
	if p := missingSyncPlan("/media/plex/Show/Season 1", 3, false); p.LocalPath != "/media/plex/Show/Season 3" {
		t.Fatalf("missing season (unpadded sibling): %+v", p)
	}
	// the season must never sit in the template again: there it only applied
	// when renaming was on, and a plain sync landed in the show root
	if strings.Contains(p.Template, "/") {
		t.Fatalf("series template carries a folder: %q", p.Template)
	}
	// missing movie: OWN subfolder under the movie library root, never a sibling's folder
	p = missingSyncPlan("/media/plex/Movies/Other Film (2019)", 0, true)
	if p.LocalPath != "/media/plex/Movies" || p.Template != "{title}/{title}" {
		t.Fatalf("missing movie: %+v", p)
	}
}

func TestParsePlexRootsAndMap(t *testing.T) {
	roots, maps := parsePlexRoots("/mnt/extra\n/media/anime => /mnt/disk1/anime\n/media/serien=>/mnt/disk2/serien/")
	// bare root + both mapping destinations become roots
	for _, want := range []string{"/mnt/extra", "/mnt/disk1/anime", "/mnt/disk2/serien"} {
		found := false
		for _, r := range roots {
			if r == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("root %q missing in %v", want, roots)
		}
	}
	// mapping applied to a file path (longest prefix, trailing slash trimmed)
	if got := applyPathMap("/media/anime/Show/Season 01/e01.mkv", maps); got != "/mnt/disk1/anime/Show/Season 01/e01.mkv" {
		t.Fatalf("map anime: %q", got)
	}
	if got := applyPathMap("/media/serien/GoT/e01.mkv", maps); got != "/mnt/disk2/serien/GoT/e01.mkv" {
		t.Fatalf("map serien: %q", got)
	}
	// unmapped path stays as-is (shared-mount case)
	if got := applyPathMap("/media/movies/x.mkv", maps); got != "/media/movies/x.mkv" {
		t.Fatalf("unmapped changed: %q", got)
	}
}

func TestLocalSeasonsByShow(t *testing.T) {
	units := catUnits{
		byKey: map[string]*catUnit{
			"show:1": {showKey: "tvdb:1", season: 1, locals: []UpgradeVariant{
				{Folder: "/media/Show/Season 01", ResRank: 720},
				{Folder: "/media/Show/Season 01 alt", ResRank: 1080}, // bestCopy wins
			}},
			"show:2": {showKey: "tvdb:1", season: 2, remotes: []UpgradeVariant{{Folder: "/ftp/S02"}}}, // not owned
			"show:3": {showKey: "tvdb:1", season: 3, locals: []UpgradeVariant{{Folder: "/media/Show/Season 03", ResRank: 1080}}},
			"other":  {showKey: "tvdb:9", season: 1, locals: []UpgradeVariant{{Folder: "/media/Other", ResRank: 480}}},
		},
		order: []string{"show:1", "show:2", "show:3", "other"},
	}
	got := localSeasonsByShow(units)
	want := []LocalSeason{
		{Season: 1, Folder: "/media/Show/Season 01 alt", ResRank: 1080},
		{Season: 3, Folder: "/media/Show/Season 03", ResRank: 1080},
	}
	if !reflect.DeepEqual(got["tvdb:1"], want) {
		t.Errorf("tvdb:1 = %+v, want %+v", got["tvdb:1"], want)
	}
	if len(got["tvdb:9"]) != 1 {
		t.Errorf("tvdb:9 = %+v, want one season", got["tvdb:9"])
	}
}

// A local row with no resolution and no languages says nothing about the copy
// it stands for, and every remote copy "improves" it: 1080 beats 0, and any
// language set is a superset of none. Reporting that as an upgrade is how a
// complete 1080p series ends up on the list.
func TestComparable(t *testing.T) {
	for _, tc := range []struct {
		name string
		v    UpgradeVariant
		want bool
	}{
		{"knows its resolution", UpgradeVariant{ResRank: 1080}, true},
		{"knows only its dub", UpgradeVariant{Dub: []string{"Ger"}}, true},
		{"knows only its sub", UpgradeVariant{Sub: []string{"Ger"}}, true},
		{"knows nothing", UpgradeVariant{Folder: "/media/Show"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := comparable(tc.v); got != tc.want {
				t.Errorf("comparable = %v, want %v", got, tc.want)
			}
		})
	}
}
