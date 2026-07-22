package api

import "testing"

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
	if p.LocalPath != "/media/plex/Show" || p.Template != "Season 03/{title} - S03E{episode:02}" {
		t.Fatalf("missing season (season sibling): %+v", p)
	}
	// flat library: sibling IS the show folder -> Season under it
	p = missingSyncPlan("/media/plex/Show", 2, false)
	if p.LocalPath != "/media/plex/Show" || p.Template != "Season 02/{title} - S02E{episode:02}" {
		t.Fatalf("missing season (flat): %+v", p)
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
