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
}
