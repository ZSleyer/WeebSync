package api

import "testing"

func TestLangCode(t *testing.T) {
	cases := map[string]string{
		"ger": "Ger", "deu": "Ger", "de": "Ger",
		"eng": "Eng", "jpn": "Jap", "ja": "Jap",
		"und": "", "": "",
		"xyz": "Xyz", // unknown -> title-cased three letters
	}
	for in, want := range cases {
		if got := langCode(in); got != want {
			t.Errorf("langCode(%q)=%q want %q", in, got, want)
		}
	}
}

// The false-positive engine this sentinel exists for: a German dub the muxer
// left untagged used to drop out of the local set, so the copy read as "no
// German" and every remote release whose NAME claims German looked like a gain.
func TestStreamsQualityKeepsUnreadableTracksAsAHole(t *testing.T) {
	q := streamsQuality([]probeStream{
		{CodecType: "video", Height: 1080},
		{CodecType: "audio", Lang: "jpn"},
		{CodecType: "audio", Lang: ""},       // untagged German dub
		{CodecType: "subtitle", Lang: "und"}, // untagged subtitle track
	})
	if q.ResRank != 1080 {
		t.Errorf("resolution = %d, want 1080", q.ResRank)
	}
	if !has(q.Dub, "Jap") || !has(q.Dub, undLang) || len(q.Dub) != 2 {
		t.Errorf("dub = %v, want Jap plus the recorded hole", q.Dub)
	}
	if !has(q.Sub, undLang) || len(q.Sub) != 1 {
		t.Errorf("sub = %v, want only the recorded hole", q.Sub)
	}
	// the hole is not a language, so it must not make the copy look richer or
	// look like it says anything about itself
	if realLangs(q.Sub) != 0 {
		t.Errorf("realLangs(%v) = %d, want 0", q.Sub, realLangs(q.Sub))
	}
	if comparable(UpgradeVariant{Sub: q.Sub}) {
		t.Error("a copy that only recorded a hole must not count as saying something about itself")
	}
}

// A local set holding a hole can never be a strict subset of a remote set read
// off file names, so the language gain is refused until something reads the
// track - and stays available once the remote side was measured the same way.
func TestUnreadableTrackBlocksOnlyTheGuessedGain(t *testing.T) {
	local := []string{"Jap", undLang}
	if strictSuperset([]string{"Ger", "Jap"}, local) {
		t.Error("a name-derived remote set must not beat a local copy with an unread track")
	}
	if !strictSuperset([]string{"Ger", "Jap", undLang}, local) {
		t.Error("a remote copy measured the same way must still win a real gain")
	}
}

func has(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// The naming convention for a subtitle file next to a video is a dot-separated
// suffix chain. Only a segment the language table knows counts - langCode would
// happily turn the last three letters of a title into a language.
func TestSidecarLang(t *testing.T) {
	cases := []struct {
		name   string
		code   string
		forced bool
	}{
		{"Show - 01.ger.ass", "Ger", false},
		{"Show - 01.de.srt", "Ger", false},
		{"Show - 01.eng.forced.ass", "Eng", true},
		{"Show - 01.Ger.Forced.sub", "Ger", true},
		{"Show - 01.ass", "", false},      // this app's own rename produces these
		{"Dr. Stone - 01.srt", "", false}, // a dot in the title names no language
		{"Show - 01.1080p.jpn.vtt", "Jap", false},
		{"Show - 01.ger.non-forced.srt", "Ger", false},
	}
	for _, c := range cases {
		code, forced := sidecarLang(c.name)
		if code != c.code || forced != c.forced {
			t.Errorf("sidecarLang(%q) = (%q, %v), want (%q, %v)", c.name, code, forced, c.code, c.forced)
		}
	}
}

// A sidecar is a selectable subtitle; a forced one is signs, not a translation;
// an unlabelled one names no language but still proves the copy is not
// hardsubbed, which is the difference between "no subtitles" and "burned in".
func TestSidecarSubs(t *testing.T) {
	langs, any := sidecarSubs([]string{"Show - 01.mkv", "Show - 01.ger.ass", "Show - 01.eng.srt"})
	if !any || !langs["Ger"] || !langs["Eng"] || len(langs) != 2 {
		t.Errorf("sidecarSubs = (%v, %v), want Ger and Eng", langs, any)
	}
	langs, any = sidecarSubs([]string{"Show - 01.mkv", "Show - 01.ass"})
	if !any || len(langs) != 0 {
		t.Errorf("an unlabelled sidecar = (%v, %v), want no language but proof it exists", langs, any)
	}
	langs, any = sidecarSubs([]string{"Show - 01.mkv", "Show - 01.ger.forced.ass"})
	if any || len(langs) != 0 {
		t.Errorf("a forced sidecar = (%v, %v), want it to count for nothing", langs, any)
	}
	if _, any = sidecarSubs([]string{"Show - 01.mkv", "cover.jpg", "Show - 01.idx"}); any {
		t.Error("a .idx is only the index half of a VobSub pair and must not count on its own")
	}
}

// The burned-in signature: the name advertises German subtitles, the container
// carries none and nothing lies beside the video. The language stays in Sub -
// the release really does show German text - but it is absent from Soft, which
// is what makes a copy with a real track an upgrade over it.
func TestHardsubShowsUpAsAMissingSoftTrack(t *testing.T) {
	hard := withSidecars(FolderQuality{}, map[string]bool{}, false)
	hard.Sub = keysSorted(unionSets(toSet(hard.Sub), map[string]bool{"Ger": true}))
	if !has(hard.Sub, "Ger") {
		t.Fatalf("sub = %v, want the advertised language kept", hard.Sub)
	}
	if len(hard.Soft) != 0 {
		t.Errorf("soft = %v, want nothing selectable", hard.Soft)
	}
	// a copy that offers the same language as a real sidecar beats it
	soft := withSidecars(FolderQuality{}, map[string]bool{"Ger": true}, true)
	if !strictSuperset(soft.Soft, hard.Soft) {
		t.Errorf("soft %v must beat hardsub %v", soft.Soft, hard.Soft)
	}
	// and an equally hardsubbed copy does not
	if strictSuperset(hard.Soft, hard.Soft) {
		t.Error("two burned-in copies are not an upgrade over each other")
	}
}
