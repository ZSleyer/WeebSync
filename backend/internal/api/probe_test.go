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
