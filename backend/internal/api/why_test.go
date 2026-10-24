package api

import "testing"

func TestEpRanges(t *testing.T) {
	for in, want := range map[string]string{"4,6,7,8,12": "4, 6-8, 12", "1,2": "1, 2", "5": "5", "": ""} {
		var nums []int
		if in != "" {
			for _, p := range splitCSV(in) {
				var n int
				for _, c := range p {
					n = n*10 + int(c-'0')
				}
				nums = append(nums, n)
			}
		}
		if got := epRanges(nums); got != want {
			t.Errorf("epRanges(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestWhyUpgrade(t *testing.T) {
	from := UpgradeVariant{ResRank: 720, Dub: []string{"Ger", "Jap"}, Sub: []string{"Ger"}, Soft: []string{"Ger"}}
	to := UpgradeVariant{ServerName: "Anime-Server", ResRank: 1080, Dub: []string{"Ger", "Jap"}, Sub: []string{"Eng", "Ger"}, Soft: []string{"Eng", "Ger"}}
	if got := whyUpgrade("de", from, to); got != "Anime-Server bietet 1080p statt 720p, Untertitel Eng, wählbare Untertitel Eng." {
		t.Errorf("why = %q", got)
	}
	if got := whyUpgrade("en", from, from); got != "" {
		t.Errorf("no gain should give no line, got %q", got)
	}
}

// A card kept with replace=false must say what the remote copy gives up, not
// only what it adds: 720p with German subtitles against a local 1080p copy
// with English subtitles loses on two axes, and the line has to say so.
func TestWhyUpgradeNamesLosses(t *testing.T) {
	from := UpgradeVariant{ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Eng"}}
	to := UpgradeVariant{ServerName: "Anime-Server", ResRank: 720, Dub: []string{"Jap"}, Sub: []string{"Ger"}}
	if !loses(from, to) {
		t.Fatal("precondition: the remote copy loses")
	}
	want := "Anime-Server bietet Untertitel Ger. Dafür nur 720p statt 1080p, keine Untertitel Eng, die lokale Kopie bleibt."
	if got := whyUpgrade("de", from, to); got != want {
		t.Errorf("de why = %q, want %q", got, want)
	}
	from = UpgradeVariant{ResRank: 1080, Dub: []string{"Ger", "Jap"}}
	to = UpgradeVariant{ServerName: "S", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Ger"}}
	want = "S has subtitles Ger. But it has no dub Ger, so the local copy is kept."
	if got := whyUpgrade("en", from, to); got != want {
		t.Errorf("en why = %q, want %q", got, want)
	}
}

func TestRemoteShowRootSkipsWholeShowFolders(t *testing.T) {
	s, _ := sizeTestServer(t)
	addRemoteFiles(t, s, 1, "/x/Game of Thrones (2011)", map[string]int64{"Game.of.Thrones.S01E01.mkv": 1, "Game.of.Thrones.S02E01.mkv": 1})
	if !s.remoteShowRoot(1, "/x/Game of Thrones (2011)") {
		t.Error("files of two seasons: a show folder")
	}
	addRemoteFiles(t, s, 1, "/x/Specials", map[string]int64{"Show.S00E01.mkv": 1, "Show.S00E02.mkv": 1})
	if s.remoteShowRoot(1, "/x/Specials") {
		t.Error("one season only: not a show folder")
	}
	s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, size) VALUES (1, '/x/Show/Season 01', '/x/Show', 'Season 01', 1, 0)`)
	if !s.remoteShowRoot(1, "/x/Show") {
		t.Error("a season folder inside: a show folder")
	}
	// a sibling that shares the name's prefix is not inside the folder
	addRemoteFiles(t, s, 1, "/x/Specials (Extra)", map[string]int64{"Show.S01E01.mkv": 1, "Show.S02E01.mkv": 1})
	if s.remoteShowRoot(1, "/x/Specials") {
		t.Error("a sibling's files counted as the folder's own")
	}
}
