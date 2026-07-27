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
		name                     string
		cur, top                 UpgradeVariant
		dims                     UpgradeDims
		wRes, wSub, wDub, wUnver bool
	}{
		{
			// the case this app's watch rules live on: a dub arriving late on
			// the server. It is reported, and marked as unconfirmed.
			name: "guessed name against a measured container: reported, unverified",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  guessed(1080, []string{"Ger", "Jap"}, []string{"Eng", "Ger"}),
			dims: all, wSub: true, wDub: true, wUnver: true,
		},
		{
			name: "both guessed: the language sets mean the same thing",
			cur:  guessed(1080, nil, []string{"Ger"}),
			top:  guessed(1080, nil, []string{"Eng", "Ger"}),
			dims: all, wSub: true,
		},
		{
			name: "both measured: a language gain is evidence, not a claim",
			cur:  measured(1080, []string{"Jap"}, nil),
			top:  measured(1080, []string{"Ger", "Jap"}, nil),
			dims: all, wDub: true,
		},
		{
			name: "no language gain: mixed sources alone mark nothing",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  guessed(2160, nil, []string{"Ger"}),
			dims: all, wRes: true,
		},
		{
			name: "padded 1088 against a round 1080 is no step",
			cur:  measured(1088, nil, nil),
			top:  guessed(1080, nil, nil),
			dims: all,
		},
		{
			name: "a real step still counts, whatever the sources",
			cur:  measured(1088, nil, nil),
			top:  guessed(2160, nil, nil),
			dims: all, wRes: true,
		},
		{
			name: "the axis the user switched off never fires",
			cur:  measured(1080, nil, nil),
			top:  measured(2160, nil, nil),
			dims: UpgradeDims{Sub: true, Dub: true},
		},
		{
			// the mark follows the axes the user actually asked for: with the
			// language axes off there is no finding left to qualify
			name: "language axes off: nothing to mark",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  guessed(1080, nil, []string{"Eng", "Ger"}),
			dims: UpgradeDims{Res: true},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, sub, dub, unver := improvements(c.dims, c.cur, c.top, "tvdb:1", 1)
			if res != c.wRes || sub != c.wSub || dub != c.wDub || unver != c.wUnver {
				t.Errorf("improvements = res:%v sub:%v dub:%v unverified:%v, want res:%v sub:%v dub:%v unverified:%v",
					res, sub, dub, unver, c.wRes, c.wSub, c.wDub, c.wUnver)
			}
		})
	}
}

// A measured local copy against a remote one whose quality is read off its file
// names. The dub the server has and the library appears to lack is exactly what
// this app's watch rules are built around, so it is reported - and marked as
// something the two sides cannot confirm between them.
func TestBuildUpgradesMarksUnverifiableLanguageGain(t *testing.T) {
	s, _ := sizeTestServer(t)
	// ffprobe read the container: 1088 lines, one audio track without a
	// language tag (dropped as "und"), German subtitles
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1088, '', 'Ger', 'tvdb:9', 1, 1)`)
	// the remote name promises more of everything
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [1080p][GerEngSub][GerJapDub]', 1080, 'Ger,Jap', 'Eng,Ger', 'tvdb:9', 1, 0)`)

	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want the language suggestion, got %d", len(got))
	}
	if !got[0].ImprovesSub || !got[0].ImprovesDub {
		t.Errorf("both language axes should be reported: sub=%v dub=%v", got[0].ImprovesSub, got[0].ImprovesDub)
	}
	if got[0].ImprovesRes {
		t.Error("a padded 1088 is not beaten by a round 1080")
	}
	if !got[0].LanguageUnverified {
		t.Error("a measured local copy against a name-derived remote one is not confirmable")
	}
	if !got[0].From.Probed || got[0].To.Probed {
		t.Errorf("the card must carry how each side was established: from=%v to=%v",
			got[0].From.Probed, got[0].To.Probed)
	}
}

// Same shape, but both sides established the same way: the language gain is
// evidence and carries no mark.
func TestBuildUpgradesLeavesASettledLanguageGainUnmarked(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1080, 'Jap', 'Ger', 'tvdb:11', 1, 0)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [GerJapDub]', 1080, 'Ger,Jap', 'Ger', 'tvdb:11', 1, 0)`)

	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want the dub suggestion, got %d", len(got))
	}
	if !got[0].ImprovesDub {
		t.Error("the added dub language should be reported")
	}
	if got[0].LanguageUnverified {
		t.Error("both sides were established the same way, so nothing is unconfirmed")
	}
}

// storeVariant is the single writer, and it uses INSERT OR REPLACE: a column it
// forgets does not keep its value, it drops back to the default. Guard the one
// that decides whether a language difference is evidence, and the one that says
// which library the copy came from.
func TestStoreVariantRoundTripsProbed(t *testing.T) {
	s, _ := sizeTestServer(t)
	q := FolderQuality{ResRank: 1080, Dub: []string{"Ger"}, Sub: []string{"Ger"}, Probed: true}
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0, kindAnime)
	s.storeVariant(1, "/seed/Show", FolderQuality{ResRank: 1080}, "tvdb:3", 1, false, 0, "")

	u := s.loadUnits().byKey[unitKey("tvdb:3", 1, false)]
	if u == nil || len(u.locals) != 1 || len(u.remotes) != 1 {
		t.Fatalf("unit not loaded: %+v", u)
	}
	if !u.locals[0].Probed {
		t.Error("a measured local copy came back as guessed")
	}
	if u.remotes[0].Probed {
		t.Error("a remote copy can never be measured")
	}
	if u.libKind != kindAnime {
		t.Errorf("library kind lost: %q", u.libKind)
	}

	// rewriting the row must not silently lose it either
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0, kindAnime)
	again := s.loadUnits().byKey[unitKey("tvdb:3", 1, false)]
	if !again.locals[0].Probed {
		t.Error("probed reset on the second write")
	}
	if again.libKind != kindAnime {
		t.Error("lib_kind reset on the second write")
	}
}
