package api

import "testing"

func TestResTier(t *testing.T) {
	cases := []struct{ h, want int }{
		{0, 0}, {480, 480}, {576, 480}, {720, 720}, {816, 720},
		{1080, 1080}, {1088, 1080}, {1072, 1080}, // mod-16 padding stays 1080p
		{1440, 1440}, {2160, 2160}, {2144, 2160}, {4320, 4320},
	}
	for _, c := range cases {
		if got := resTier(c.h); got != c.want {
			t.Errorf("resTier(%d) = %d, want %d", c.h, got, c.want)
		}
	}
	// the case that used to fire: a padded local 1080p against a round remote one
	if resTier(1080) > resTier(1088) {
		t.Error("1080 must not beat a measured 1088")
	}
}

func TestImprovements(t *testing.T) {
	all := UpgradeDims{Res: true, Sub: true, Dub: true}
	measured := func(res int, dub, sub []string) UpgradeVariant {
		return UpgradeVariant{ResRank: res, Dub: dub, Sub: sub, Probed: true}
	}
	guessed := func(res int, dub, sub []string) UpgradeVariant {
		return UpgradeVariant{ResRank: res, Dub: dub, Sub: sub}
	}
	cases := []struct {
		name             string
		cur, top         UpgradeVariant
		dims             UpgradeDims
		wRes, wSub, wDub bool
	}{
		{
			name: "guessed name beats a measured container: not provable",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  guessed(1080, []string{"Ger", "Jap"}, []string{"Eng", "Ger"}),
			dims: all,
		},
		{
			name: "both guessed: the language sets mean the same thing",
			cur:  guessed(1080, nil, []string{"Ger"}),
			top:  guessed(1080, nil, []string{"Eng", "Ger"}),
			dims: all, wSub: true,
		},
		{
			name: "padded 1088 against a round 1080 is no step",
			cur:  measured(1088, nil, nil),
			top:  guessed(1080, nil, nil),
			dims: all,
		},
		{
			name: "a real step still counts, whatever the sources",
			cur:  measured(1088, nil, []string{"Ger"}),
			top:  guessed(2160, nil, []string{"Eng", "Ger"}),
			dims: all, wRes: true,
		},
		{
			name: "the axis the user switched off never fires",
			cur:  measured(1080, nil, nil),
			top:  measured(2160, nil, nil),
			dims: UpgradeDims{Sub: true, Dub: true},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, sub, dub := improvements(c.dims, c.cur, c.top, "tvdb:1", 1)
			if res != c.wRes || sub != c.wSub || dub != c.wDub {
				t.Errorf("improvements = res:%v sub:%v dub:%v, want res:%v sub:%v dub:%v",
					res, sub, dub, c.wRes, c.wSub, c.wDub)
			}
		})
	}
}

// A measured local copy against a remote one whose quality is read off its file
// names: the language difference is an artefact of the two methods, so nothing
// is suggested until the resolution really steps up.
func TestBuildUpgradesIgnoresGuessedLanguageGain(t *testing.T) {
	s, _ := sizeTestServer(t)
	// ffprobe read the container: 1088 lines, one audio track without a
	// language tag (dropped as "und"), German subtitles
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1088, '', 'Ger', 'tvdb:9', 1, 1)`)
	// the remote name promises more of everything
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [1080p][GerEngSub][GerJapDub]', 1080, 'Ger,Jap', 'Eng,Ger', 'tvdb:9', 1, 0)`)

	if got := s.buildUpgrades(1); len(got) != 0 {
		t.Fatalf("guessed language gain suggested as an upgrade: %+v", got[0])
	}

	// a real resolution step is still reported - and only on that axis
	s.DB.Exec(`UPDATE catalog_variants SET res_rank = 2160 WHERE server_id = 1`)
	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want 1 suggestion for the 4K copy, got %d", len(got))
	}
	if !got[0].ImprovesRes {
		t.Error("the resolution step should be reported")
	}
	if got[0].ImprovesSub || got[0].ImprovesDub {
		t.Errorf("language axes must stay off: sub=%v dub=%v", got[0].ImprovesSub, got[0].ImprovesDub)
	}
	if !got[0].From.Probed || got[0].To.Probed {
		t.Errorf("the card must carry how each side was established: from=%v to=%v",
			got[0].From.Probed, got[0].To.Probed)
	}
}

// storeVariant is the single writer, and it uses INSERT OR REPLACE: a column it
// forgets does not keep its value, it drops back to the default. Guard the one
// that decides whether a language difference is evidence.
func TestStoreVariantRoundTripsProbed(t *testing.T) {
	s, _ := sizeTestServer(t)
	q := FolderQuality{ResRank: 1080, Dub: []string{"Ger"}, Sub: []string{"Ger"}, Probed: true}
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0)
	s.storeVariant(1, "/seed/Show", FolderQuality{ResRank: 1080}, "tvdb:3", 1, false, 0)

	u := s.loadUnits().byKey[unitKey("tvdb:3", 1)]
	if u == nil || len(u.locals) != 1 || len(u.remotes) != 1 {
		t.Fatalf("unit not loaded: %+v", u)
	}
	if !u.locals[0].Probed {
		t.Error("a measured local copy came back as guessed")
	}
	if u.remotes[0].Probed {
		t.Error("a remote copy can never be measured")
	}

	// rewriting the row must not silently lose it either
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0)
	if !s.loadUnits().byKey[unitKey("tvdb:3", 1)].locals[0].Probed {
		t.Error("probed reset on the second write")
	}
}
