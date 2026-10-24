package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// A remote copy that wins one axis can still lose another. The card may stand
// - the gain is real - but the sync it carries must not replace the better
// local copy: 1080p with a Japanese dub traded for 720p with German
// subtitles, or for a copy that drops the dub, is a loss the trash hides.
func TestBuildUpgradesKeepsTheLocalCopyWhenTheRemoteLosesSomething(t *testing.T) {
	cases := []struct {
		name        string
		localRes    int
		localSub    string
		res         int
		dub, sub    string
		wantReplace bool
	}{
		{"subtitles at a lower resolution", 1080, "", 720, "Jap", "Ger", false},
		{"subtitles without the dub", 1080, "", 1080, "", "Ger", false},
		{"resolution without the subtitles", 720, "Eng", 1080, "Jap", "Ger", false},
		{"only gains", 1080, "Eng", 1080, "Jap", "Eng,Ger", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := sizeTestServer(t)
			s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
				VALUES (0, '/lib/Show/Season 01', ?, 'Jap', ?, 'tvdb:11', 1, 1)`, tc.localRes, tc.localSub)
			s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
				VALUES (1, '/seed/Show', ?, ?, ?, 'tvdb:11', 1, 1)`, tc.res, tc.dub, tc.sub)

			got := s.buildUpgrades(1)
			if len(got) != 1 {
				t.Fatalf("want the card (one axis gains), got %d", len(got))
			}
			if got[0].Sync.Replace != tc.wantReplace {
				t.Errorf("Sync.Replace = %v, want %v (from %+v to %+v)", got[0].Sync.Replace, tc.wantReplace, got[0].From, got[0].To)
			}
			// the card reads a missing field as "replace", so false has to be sent
			b, _ := json.Marshal(got[0].Sync)
			if !strings.Contains(string(b), `"replace":`) {
				t.Errorf("sync plan %s leaves out replace, which the card defaults to true", b)
			}
		})
	}
}
