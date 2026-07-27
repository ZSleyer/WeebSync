package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

func TestPickStream(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 1}, // video, never picked
		{ID: 2, Type: 2, LangCode: "deu", Language: "German"},   // Ger dub
		{ID: 3, Type: 2, LangCode: "jpn", Language: "Japanese"}, // Jap dub
		{ID: 4, Type: 3, LangCode: "", Language: "German"},      // Ger sub, code missing
		{ID: 5, Type: 3, LangCode: "eng"},                       // Eng sub
	}
	cases := []struct {
		typ  int
		want string
		id   int64
	}{
		{2, "Jap", 3},
		{2, "Ger", 2},
		{2, "ger", 2}, // case-insensitive app code
		{3, "Ger", 4}, // falls back to Language when languageCode is empty
		{3, "Eng", 5},
		{2, "Fre", 0}, // language not in the file
		{2, "", 0},    // no preference
		{3, "Jap", 0}, // wrong type must not match the Jap dub
	}
	for _, c := range cases {
		if got := pickStream(streams, c.typ, c.want); got != c.id {
			t.Errorf("pickStream(type %d, %q) = %d, want %d", c.typ, c.want, got, c.id)
		}
	}
}

// The reported bug: the audio went to Japanese but the subtitles landed on
// "German forced" instead of the full German track. Both are German, and the
// forced one is written first, which is the order a muxer conventionally uses.
func TestPickStreamPrefersTheFullTrackOverForced(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 1},
		{ID: 2, Type: 2, LangCode: "jpn"},
		{ID: 3, Type: 3, LangCode: "deu", Forced: true, Title: "Forced"},
		{ID: 4, Type: 3, LangCode: "deu", Title: "Vollständig"},
	}
	if got := pickStream(streams, 3, "Ger"); got != 4 {
		t.Errorf("subtitle = %d, want the full German track (4)", got)
	}
	if got := pickStream(streams, 2, "Jap"); got != 2 {
		t.Errorf("audio = %d, want 2", got)
	}
}

// The container flag decides, whatever the track is called: a forced track
// named plainly "Deutsch" must still lose to the full one.
func TestPickStreamTrustsTheFlagOverTheTitle(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 3, LangCode: "deu", Forced: true, Title: "Deutsch"},
		{ID: 2, Type: 3, LangCode: "deu", Title: "Deutsch"},
	}
	if got := pickStream(streams, 3, "Ger"); got != 2 {
		t.Errorf("subtitle = %d, want the track whose forced flag is unset (2)", got)
	}
}

// A muxer that names a track "Forced" often leaves the container flag unset,
// and Plex passes the flag through rather than inferring it.
func TestPickStreamReadsForcedFromTheTitle(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 3, LangCode: "deu", Title: "German (Forced)"},
		{ID: 2, Type: 3, LangCode: "deu", Title: "German"},
	}
	if got := pickStream(streams, 3, "Ger"); got != 2 {
		t.Errorf("subtitle = %d, want the track without the forced marker (2)", got)
	}
}

// A full track is often labelled by what it is NOT, right next to the forced
// one. Reading that as forced demotes the track the label exists to identify.
func TestPickStreamIgnoresANegatedForcedTitle(t *testing.T) {
	for _, name := range []string{"German (Non-Forced)", "Deutsch nicht forced", "German, not forced"} {
		streams := []plex.EpisodeStream{
			{ID: 1, Type: 3, LangCode: "deu", Title: "German (Forced)"},
			{ID: 2, Type: 3, LangCode: "deu", Title: name},
		}
		if got := pickStream(streams, 3, "Ger"); got != 2 {
			t.Errorf("%q: subtitle = %d, want the full track (2)", name, got)
		}
	}
}

// Ranking decides between tracks, it does not veto them: the preference is
// worth nothing if a file that only has a forced track keeps Plex's own default.
func TestPickStreamFallsBackToTheOnlyTrackThereIs(t *testing.T) {
	only := []plex.EpisodeStream{{ID: 7, Type: 3, LangCode: "deu", Forced: true}}
	if got := pickStream(only, 3, "Ger"); got != 7 {
		t.Errorf("subtitle = %d, want the forced track as a last resort (7)", got)
	}
	sdh := []plex.EpisodeStream{
		{ID: 8, Type: 3, LangCode: "deu", Forced: true},
		{ID: 9, Type: 3, LangCode: "deu", HearingImpaired: true},
	}
	if got := pickStream(sdh, 3, "Ger"); got != 9 {
		t.Errorf("subtitle = %d, want SDH over forced (9): it is a full translation", got)
	}
}

// Same trap one type over: a commentary or an audio-description track sits
// under the same language as the real one.
func TestPickStreamSkipsCommentaryAndDescription(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 2, LangCode: "deu", VisualImpaired: true, Title: "Audiodeskription"},
		{ID: 2, Type: 2, LangCode: "deu", Title: "Regie-Kommentar"},
		{ID: 3, Type: 2, LangCode: "deu", Title: "Stereo"},
	}
	if got := pickStream(streams, 2, "Ger"); got != 3 {
		t.Errorf("audio = %d, want the plain German track (3)", got)
	}
}
