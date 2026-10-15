package tvdb

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// An endless anime on TVDB carries what its AniList entry did: the genres, and
// the next episode by its absolute number at the Japanese air time, counted
// when TVDB has not numbered it yet. Specials do not count.
func TestEnrichEndlessAnime(t *testing.T) {
	var r seriesRecord
	if err := json.Unmarshal([]byte(`{
		"genres": [{"name": "Mystery"}, {"name": "Anime"}],
		"airsTime": "18:00", "originalCountry": "jpn",
		"episodes": [
			{"seasonNumber": 34, "number": 2, "aired": "2026-10-24"},
			{"seasonNumber": 0, "number": 1, "aired": "2026-10-10"},
			{"seasonNumber": 33, "number": 1, "absoluteNumber": 1, "aired": "2026-10-03"},
			{"seasonNumber": 34, "number": 1, "aired": "2026-10-17"}
		]}`), &r); err != nil {
		t.Fatal(err)
	}
	var m anilist.Media
	r.enrich(&m, time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	if len(m.Genres) != 2 || m.Genres[1] != "Anime" {
		t.Errorf("genres %v", m.Genres)
	}
	if m.Episodes != 3 {
		t.Errorf("episodes %d, want the 3 regular ones", m.Episodes)
	}
	want := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC).Unix() // 18:00 JST
	if m.NextAiring == nil || m.NextAiring.Episode != 2 || m.NextAiring.AiringAt != want || len(m.Schedule) != 2 || m.Schedule[1].Episode != 3 {
		t.Fatalf("next airing %+v, want episode 2 at %d", m.NextAiring, want)
	}
	// Chinese animation TVDB files under "Animation" only is anime as AniList
	// counts it; western animation is not
	var donghua, western seriesRecord
	json.Unmarshal([]byte(`{"originalCountry": "chn", "genres": [{"name": "Animation"}, {"name": "Fantasy"}]}`), &donghua)
	json.Unmarshal([]byte(`{"originalCountry": "usa", "genres": [{"name": "Animation"}]}`), &western)
	var dg, wm anilist.Media
	donghua.enrich(&dg, time.Now())
	western.enrich(&wm, time.Now())
	if !slices.Contains(dg.Genres, "Anime") || slices.Contains(wm.Genres, "Anime") {
		t.Errorf("donghua %v, western %v", dg.Genres, wm.Genres)
	}
	// a finished show has no next episode
	var done seriesRecord
	json.Unmarshal([]byte(`{"episodes": [{"seasonNumber": 1, "number": 1, "aired": "2002-04-03"}]}`), &done)
	var dm anilist.Media
	done.enrich(&dm, time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC))
	if dm.NextAiring != nil || dm.Episodes != 1 {
		t.Errorf("finished: %+v", dm)
	}
}
