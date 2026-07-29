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
	all := UpgradeDims{Res: true, Sub: true, Dub: true, Soft: true}
	variant := func(p probeState, res int, dub, sub, soft []string) UpgradeVariant {
		return UpgradeVariant{ResRank: res, Dub: dub, Sub: sub, Soft: soft, Probed: p}
	}
	measured := func(res int, dub, sub []string) UpgradeVariant {
		return variant(probeMeasured, res, dub, sub, sub)
	}
	// a remote copy nobody has opened yet: its languages are whatever its file
	// names advertise
	claimed := func(res int, dub, sub []string) UpgradeVariant {
		return variant(probeNone, res, dub, sub, nil)
	}
	// opened, and the container would not answer - the names are the best
	// evidence there will ever be for this copy
	unreadable := func(res int, dub, sub []string) UpgradeVariant {
		return variant(probeFailed, res, dub, sub, nil)
	}
	cases := []struct {
		name                            string
		cur, top                        UpgradeVariant
		dims                            UpgradeDims
		wRes, wSub, wDub, wSoft, wUnver bool
	}{
		{
			// the gate: a name promising more than a measured copy holds is not
			// a finding yet, it is a question for the probe loop
			name: "an unmeasured remote name against a measured container: held back",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  claimed(1080, []string{"Ger", "Jap"}, []string{"Eng", "Ger"}),
			dims: all,
		},
		{
			// and once the probe has failed for good, the name is all there is,
			// so the finding comes back - marked
			name: "a container that will not answer: reported, unverified",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  unreadable(1080, []string{"Ger", "Jap"}, []string{"Eng", "Ger"}),
			dims: all, wSub: true, wDub: true, wUnver: true,
		},
		{
			name: "both measured: a language gain is evidence, not a claim",
			cur:  measured(1080, []string{"Jap"}, nil),
			top:  measured(1080, []string{"Ger", "Jap"}, nil),
			dims: all, wDub: true,
		},
		{
			// the burned-in case: both copies show German text, only one can
			// turn it off
			name: "same language, but selectable: the soft axis",
			cur:  variant(probeMeasured, 1080, nil, []string{"Ger"}, nil),
			top:  variant(probeMeasured, 1080, nil, []string{"Ger"}, []string{"Ger"}),
			dims: all, wSoft: true,
		},
		{
			name: "the soft axis cannot be won by a copy nobody measured",
			cur:  variant(probeMeasured, 1080, nil, []string{"Ger"}, nil),
			top:  claimed(1080, nil, []string{"Ger"}),
			dims: all,
		},
		{
			name: "resolution needs no measurement: a name and a container mean the same height",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  claimed(2160, nil, []string{"Ger"}),
			dims: all, wRes: true,
		},
		{
			name: "padded 1088 against a round 1080 is no step",
			cur:  measured(1088, nil, nil),
			top:  claimed(1080, nil, nil),
			dims: all,
		},
		{
			name: "the axis the user switched off never fires",
			cur:  measured(1080, nil, nil),
			top:  measured(2160, nil, nil),
			dims: UpgradeDims{Sub: true, Dub: true, Soft: true},
		},
		{
			// the mark follows the axes the user actually asked for: with the
			// language axes off there is no finding left to qualify
			name: "language axes off: nothing to mark",
			cur:  measured(1080, nil, []string{"Ger"}),
			top:  unreadable(1080, nil, []string{"Eng", "Ger"}),
			dims: UpgradeDims{Res: true},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, sub, dub, soft, unver, _ := improvements(c.dims, c.cur, c.top, "tvdb:1", 1)
			if res != c.wRes || sub != c.wSub || dub != c.wDub || soft != c.wSoft || unver != c.wUnver {
				t.Errorf("improvements = res:%v sub:%v dub:%v soft:%v unverified:%v, want res:%v sub:%v dub:%v soft:%v unverified:%v",
					res, sub, dub, soft, unver, c.wRes, c.wSub, c.wDub, c.wSoft, c.wUnver)
			}
		})
	}
}

// A remote copy whose container could not be read at all: its file names are
// the best evidence there will ever be, so the dub the server has and the
// library appears to lack is still reported - and marked as something the two
// sides cannot settle between them.
func TestBuildUpgradesMarksUnverifiableLanguageGain(t *testing.T) {
	s, _ := sizeTestServer(t)
	// ffprobe read the container: 1088 lines, one audio track without a
	// language tag (recorded as the hole "Und"), German subtitles
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1088, '', 'Ger', 'Ger', 'tvdb:9', 1, 1)`)
	// the remote name promises more of everything, and the probe loop already
	// tried and failed to open it (probed = 2)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [1080p][GerEngSub][GerJapDub]', 1080, 'Ger,Jap', 'Eng,Ger', '', 'tvdb:9', 1, 2)`)

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
	if got[0].From.Probed != probeMeasured || got[0].To.Probed != probeFailed {
		t.Errorf("the card must carry how each side was established: from=%v to=%v",
			got[0].From.Probed, got[0].To.Probed)
	}
}

// Same shape, but both containers were read: the language gain is evidence and
// carries no mark.
func TestBuildUpgradesLeavesASettledLanguageGainUnmarked(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1080, 'Jap', 'Ger', 'Ger', 'tvdb:11', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [GerJapDub]', 1080, 'Ger,Jap', 'Ger', 'Ger', 'tvdb:11', 1, 1)`)

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
	q := FolderQuality{ResRank: 1080, Dub: []string{"Ger"}, Sub: []string{"Ger"}, Probed: probeMeasured}
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0, kindAnime)
	s.storeVariant(1, "/seed/Show", FolderQuality{ResRank: 1080}, "tvdb:3", 1, false, 0, "")

	u := s.loadUnits().byKey[unitKey("tvdb:3", 1, false)]
	if u == nil || len(u.locals) != 1 || len(u.remotes) != 1 {
		t.Fatalf("unit not loaded: %+v", u)
	}
	if u.locals[0].Probed != probeMeasured {
		t.Error("a measured local copy came back as guessed")
	}
	if u.remotes[0].Probed != probeNone {
		t.Error("a remote copy can never be measured")
	}
	if u.libKind != kindAnime {
		t.Errorf("library kind lost: %q", u.libKind)
	}

	// rewriting the row must not silently lose it either
	s.storeVariant(0, "/lib/Show/Season 01", q, "tvdb:3", 1, false, 0, kindAnime)
	again := s.loadUnits().byKey[unitKey("tvdb:3", 1, false)]
	if again.locals[0].Probed != probeMeasured {
		t.Error("probed reset on the second write")
	}
	if again.libKind != kindAnime {
		t.Error("lib_kind reset on the second write")
	}
}

// The gate itself: a remote copy nobody has opened yet produces no language
// card at all. Its name may well be telling the truth, but until LangProbeLoop
// has read the container that is a question, not a finding.
func TestBuildUpgradesHoldsBackAnUnmeasuredLanguageGain(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1080, '', 'Ger', 'Ger', 'tvdb:21', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [GerEngSub][GerJapDub]', 1080, 'Ger,Jap', 'Eng,Ger', '', 'tvdb:21', 1, 0)`)

	if got := s.buildUpgrades(1); len(got) != 0 {
		t.Fatalf("an unmeasured name produced a card: %+v", got[0])
	}

	// the same row once the probe has run: the container really does carry the
	// tracks, and now it is a finding
	s.DB.Exec(`UPDATE catalog_variants SET probed = 1, soft_codes = 'Eng,Ger' WHERE server_id = 1`)
	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want the measured language suggestion, got %d", len(got))
	}
	if !got[0].ImprovesSub || !got[0].ImprovesDub || got[0].LanguageUnverified {
		t.Errorf("want a confirmed sub+dub gain, got sub=%v dub=%v unverified=%v",
			got[0].ImprovesSub, got[0].ImprovesDub, got[0].LanguageUnverified)
	}
}

// Both copies advertise German subtitles and both were measured, so no language
// is gained - but only one of them can hand the subtitles over as a track. That
// is the burned-in case, and it is an axis of its own.
func TestBuildUpgradesOffersSoftsubOverBurnedIn(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 1080, 'Jap', 'Ger', '', 'tvdb:22', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, probed)
		VALUES (1, '/seed/Show [GerSub]', 1080, 'Jap', 'Ger', 'Ger', 'tvdb:22', 1, 1)`)

	got := s.buildUpgrades(1)
	if len(got) != 1 {
		t.Fatalf("want the softsub suggestion, got %d", len(got))
	}
	if !got[0].ImprovesSoft {
		t.Error("a selectable German track over a burned-in one is a soft gain")
	}
	if got[0].ImprovesSub || got[0].ImprovesRes || got[0].ImprovesDub {
		t.Errorf("no other axis is won here: %+v", got[0])
	}
}
