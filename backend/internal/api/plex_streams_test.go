package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

// pickID drops the exactness flag where a test only cares which track won.
func pickID(streams []plex.EpisodeStream, typ int, want string, wantForced bool) int64 {
	id, _ := pickStream(streams, typ, want, wantForced)
	return id
}

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
		if got := pickID(streams, c.typ, c.want, false); got != c.id {
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
	if got := pickID(streams, 3, "Ger", false); got != 4 {
		t.Errorf("subtitle = %d, want the full German track (4)", got)
	}
	if got := pickID(streams, 2, "Jap", false); got != 2 {
		t.Errorf("audio = %d, want 2", got)
	}
}

// The other direction, which is a choice and not a derivation: someone watching
// the German dub asks for the forced track and must get it, out of the same file.
func TestPickStreamPicksForcedWhenAskedFor(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 3, LangCode: "deu", Title: "Vollständig"},
		{ID: 2, Type: 3, LangCode: "deu", Forced: true},
	}
	id, exact := pickStream(streams, 3, "Ger", true)
	if id != 2 || !exact {
		t.Errorf("subtitle = %d (exact %v), want the forced German track (2)", id, exact)
	}
}

// The container flag decides, whatever the track is called: a forced track
// named plainly "Deutsch" must still lose to the full one.
func TestPickStreamTrustsTheFlagOverTheTitle(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 3, LangCode: "deu", Forced: true, Title: "Deutsch"},
		{ID: 2, Type: 3, LangCode: "deu", Title: "Deutsch"},
	}
	if got := pickID(streams, 3, "Ger", false); got != 2 {
		t.Errorf("subtitle = %d, want the track whose forced flag is unset (2)", got)
	}
}

// A muxer that names a track "Forced" often leaves the container flag unset,
// and Plex passes the flag through rather than inferring it.
func TestPickStreamReadsForcedFromTheTitle(t *testing.T) {
	for _, name := range []string{"German (Forced)", "Deutsch (Erzwungen)", "Deutsch forciert"} {
		streams := []plex.EpisodeStream{
			{ID: 1, Type: 3, LangCode: "deu", Title: name},
			{ID: 2, Type: 3, LangCode: "deu", Title: "German"},
		}
		if got := pickID(streams, 3, "Ger", false); got != 2 {
			t.Errorf("%q: subtitle = %d, want the track without the forced marker (2)", name, got)
		}
		if got := pickID(streams, 3, "Ger", true); got != 1 {
			t.Errorf("%q: forced subtitle = %d, want the marked track (1)", name, got)
		}
	}
}

// A full track is often labelled by what it is NOT, right next to the forced
// one. Reading that as forced demotes the track the label exists to identify.
func TestPickStreamIgnoresANegatedForcedTitle(t *testing.T) {
	for _, name := range []string{"German (Non-Forced)", "Deutsch nicht forced", "German, not forced", "Deutsch nicht erzwungen"} {
		streams := []plex.EpisodeStream{
			{ID: 1, Type: 3, LangCode: "deu", Title: "German (Forced)"},
			{ID: 2, Type: 3, LangCode: "deu", Title: name},
		}
		if got := pickID(streams, 3, "Ger", false); got != 2 {
			t.Errorf("%q: subtitle = %d, want the full track (2)", name, got)
		}
	}
}

// "Signs" is the dominant name for an unflagged signs-only track, but also a
// plausible name for a full one - so it counts only when forced is the goal,
// where a false positive costs nothing. Pins both halves of that asymmetry,
// including the ceiling: asking for the FULL track, an unflagged "Signs" track
// is indistinguishable from a real one and file order decides. Flagging the
// track forced in the container is what resolves it, and that is on the muxer.
func TestPickStreamReadsSignsOnlyWhenForcedIsWanted(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 3, LangCode: "deu", Title: "Signs & Songs"},
		{ID: 2, Type: 3, LangCode: "deu", Title: "Deutsch"},
	}
	if got := pickID(streams, 3, "Ger", true); got != 1 {
		t.Errorf("forced subtitle = %d, want the signs track (1)", got)
	}
	if got := pickID(streams, 3, "Ger", false); got != 1 {
		t.Errorf("full subtitle = %d: an unflagged signs track is not detectable here, "+
			"so the first German track wins (1). Change this only together with the ceiling above", got)
	}
	// with the flag set, the same file resolves cleanly in both directions
	streams[0].Forced = true
	if got := pickID(streams, 3, "Ger", false); got != 2 {
		t.Errorf("full subtitle = %d, want the plain track (2) once the flag is set", got)
	}
}

// Ranking decides between tracks, it does not veto them: the preference is
// worth nothing if a file that only has a forced track keeps Plex's own default.
// The substitution is reported through exact, not by refusing to select.
func TestPickStreamFallsBackToTheOnlyTrackThereIs(t *testing.T) {
	only := []plex.EpisodeStream{{ID: 7, Type: 3, LangCode: "deu", Forced: true}}
	id, exact := pickStream(only, 3, "Ger", false)
	if id != 7 {
		t.Errorf("subtitle = %d, want the forced track as a last resort (7)", id)
	}
	if exact {
		t.Error("a forced track standing in for a full one is not what was asked for")
	}
	sdh := []plex.EpisodeStream{
		{ID: 8, Type: 3, LangCode: "deu", Forced: true},
		{ID: 9, Type: 3, LangCode: "deu", HearingImpaired: true},
	}
	if got := pickID(sdh, 3, "Ger", false); got != 9 {
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
	if got := pickID(streams, 2, "Ger", false); got != 3 {
		t.Errorf("audio = %d, want the plain German track (3)", got)
	}
}

func TestSubChoice(t *testing.T) {
	cases := []struct {
		pref   string
		code   string
		forced bool
		off    bool
	}{
		{"", "", false, false},
		{"off", "", false, true},
		{"Ger", "Ger", false, false},
		{"Ger:forced", "Ger", true, false},
	}
	for _, c := range cases {
		code, forced, off := subChoice(c.pref)
		if code != c.code || forced != c.forced || off != c.off {
			t.Errorf("subChoice(%q) = (%q, %v, %v), want (%q, %v, %v)", c.pref, code, forced, off, c.code, c.forced, c.off)
		}
	}
}

// The four combinations the preference has to be able to express, plus what it
// says about a file that cannot deliver them. StreamLeave means the dimension
// is left exactly as Plex had it, which is not the same as turning it off.
func TestPlanStreams(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 2, LangCode: "jpn"},
		{ID: 2, Type: 2, LangCode: "deu"},
		{ID: 3, Type: 3, LangCode: "deu", Forced: true},
		{ID: 4, Type: 3, LangCode: "deu"},
	}
	cases := []struct {
		name         string
		audio, sub   string
		wantA, wantS int64
		miss         string
	}{
		{"japanese with full german subs", "Jap", "Ger", 1, 4, ""},
		{"japanese without any subtitles", "Jap", "off", 1, 0, ""},
		{"german dub with forced subs", "Ger", "Ger:forced", 2, 3, ""},
		{"german dub with full subs", "Ger", "Ger", 2, 4, ""},
		{"subtitles only, audio untouched", "", "Ger", plex.StreamLeave, 4, ""},
		{"audio only, subtitles untouched", "Jap", "", 1, plex.StreamLeave, ""},
		{"a language the file does not have", "Fre", "Ita", plex.StreamLeave, plex.StreamLeave, "audio,sub"},
	}
	for _, c := range cases {
		a, sb, miss := planStreams(streams, c.audio, c.sub)
		if a != c.wantA || sb != c.wantS || miss != c.miss {
			t.Errorf("%s: planStreams = (%d, %d, %q), want (%d, %d, %q)",
				c.name, a, sb, miss, c.wantA, c.wantS, c.miss)
		}
	}
}

// A file that has the language but only in the wrong variant is a substitution,
// not a failure: the track is selected AND the miss is reported, so the retry
// keeps looking and the watch says what is off.
func TestPlanStreamsReportsAWrongVariantAsMissing(t *testing.T) {
	onlyFull := []plex.EpisodeStream{{ID: 1, Type: 3, LangCode: "deu"}}
	_, subID, miss := planStreams(onlyFull, "", "Ger:forced")
	if subID != 1 || miss != "sub" {
		t.Errorf("planStreams = (%d, %q), want the full track selected (1) and reported as missing", subID, miss)
	}
	onlyForced := []plex.EpisodeStream{{ID: 2, Type: 3, LangCode: "deu", Forced: true}}
	_, subID, miss = planStreams(onlyForced, "", "Ger")
	if subID != 2 || miss != "sub" {
		t.Errorf("planStreams = (%d, %q), want the forced track selected (2) and reported as missing", subID, miss)
	}
}

// A Plex preference must reach the episodes the watch tracks and nothing else.
// For an endless series the show's own listing spans every episode ever aired,
// so the set is built from what the crawler saw under the watch's remote path,
// resolved through the watch's rename - which is what turns an absolute number
// into the season it is filed under.
func TestTrackedEpisodesCoversTheWatchOnly(t *testing.T) {
	s, _ := pendingFixture(t)
	var w Watch
	if err := s.DB.QueryRow(`SELECT id, server_id, remote_path, local_path, template, aired_mapping FROM watches WHERE id = 1`).
		Scan(&w.ID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Template, &w.AiredMapping); err != nil {
		t.Fatal(err)
	}
	w.Mode = "template"
	add := func(parent, name string, isDir int) {
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, ?, ?, ?, ?)`,
			parent+"/"+name, parent, name, isDir)
	}
	add("/ftp/Conan", "Conan - 1207.mkv", 0) // the season map resolves 1207 to S34E21
	add("/ftp/Conan", "Season 34", 1)        // a directory carries no episode
	add("/ftp/Conan", "readme.txt", 0)       // not a video
	// a sibling whose name differs from the watch's only where an underscore
	// sits - a LIKE prefix would read that "_" as a wildcard and swallow it
	add("/ftp/Conan_Movies", "Conan - S01E05.mkv", 0)

	got := s.trackedEpisodes(w)
	if !got[epKey(34, 21)] {
		t.Errorf("tracked = %v, want the aired mapping to resolve 1207 to S34E21", got)
	}
	if got[epKey(1, 5)] {
		t.Error("a sibling folder that only differs by an underscore was counted as tracked")
	}
	if len(got) != 1 {
		t.Errorf("tracked = %v, want exactly one episode", got)
	}

	// what the watch already downloaded counts too, whatever it was named
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (7, 1, 1, '/ftp/Conan/Conan - 1180.mkv', '/media/Conan/Season_34/Conan - S34E01.mkv', 'done')`)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
		VALUES (8, 1, 1, '/ftp/Conan/Conan - 1181.mkv', '/media/Conan/Season_34/Conan - S34E02.mkv', 'error')`)
	got = s.trackedEpisodes(w)
	if !got[epKey(34, 1)] {
		t.Error("a finished download of this watch is not tracked")
	}
	if got[epKey(34, 2)] {
		t.Error("a failed download must not count as present")
	}
}
