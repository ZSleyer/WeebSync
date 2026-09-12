package api

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// The providers hand out the future only: an episode that aired yesterday is
// gone from their schedule, and the calendar used to have nothing to show for
// the days just gone. The sweep writes every slot down, the list endpoint reads
// the past week back - with the watch's own episode offset applied, because the
// table stores what the provider counted.
func TestPastAiringsFillTheCalendarWeek(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Anilist: anilist.New(d)}

	now := time.Now()
	soon := now.Add(48 * time.Hour).Unix()
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - S01E{episode-100:02}')`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"status":"RELEASING","schedule":[{"airingAt":%d,"episode":104}]}`, soon))

	// the sweep copies what the cache currently holds
	s.recordAirings()
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM airings WHERE source = 'anilist' AND media_id = 5`).Scan(&n)
	if n != 1 {
		t.Fatalf("recorded %d slots, want 1", n)
	}

	// the provider pushes the episode back a day: the recorded slot moves with
	// it rather than leaving its old time behind as a second airing
	d.Exec(`UPDATE anilist_cache SET payload = ? WHERE key = 'media:5'`,
		fmt.Sprintf(`{"id":5,"status":"RELEASING","schedule":[{"airingAt":%d,"episode":104}]}`, soon+86400))
	s.recordAirings()
	var moved int64
	d.QueryRow(`SELECT COUNT(*) FROM airings WHERE media_id = 5`).Scan(&n)
	d.QueryRow(`SELECT airing_at FROM airings WHERE media_id = 5 AND episode = 104`).Scan(&moved)
	if n != 1 || moved != soon+86400 {
		t.Fatalf("after a delay: %d rows, episode 104 at %d, want 1 row at %d", n, moved, soon+86400)
	}

	// slots the providers no longer know about: two inside the calendar's week
	// - a double episode, both dated to the same moment the way TMDB dates a
	// whole day - and one older than the calendar reaches
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode) VALUES ('anilist', 5, ?, 103)`, now.Add(-48*time.Hour).Unix())
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode) VALUES ('anilist', 5, ?, 102)`, now.Add(-48*time.Hour).Unix())
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode) VALUES ('anilist', 5, ?, 90)`, now.Add(-20*24*time.Hour).Unix())

	list, err := s.watchesFor(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d watches", len(list))
	}
	got := list[0].Airings
	if len(got) != 3 {
		t.Fatalf("got %d airings, want both past episodes plus what is dated ahead: %+v", len(got), got)
	}
	if got[0].At > got[1].At || got[1].At > got[2].At {
		t.Errorf("airings are not sorted by time: %+v", got)
	}
	// episode 102/103 with a -100 template are local episodes 2 and 3, and the
	// absolute number rides along for the "(103)" the calendar shows in
	// parentheses. Both survive their shared timestamp.
	if got[0].Episode != 2 || got[1].Episode != 3 || got[1].EpisodeAbs != 103 {
		t.Errorf("past airings = %+v, want local episodes 2 and 3", got[:2])
	}
	if got[2].Episode != 4 {
		t.Errorf("future airing = ep %d, want 4", got[2].Episode)
	}
}

// A watch filtering for a dub gets the dub's own slots. Two of them have been
// recorded as released, three weeks after their originals; the episodes still
// ahead are projected at the same lag and marked as estimates, and the
// release that has been seen stands as it is, whatever the lag says.
func TestDubSlotsProjectTheObservedLag(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Anilist: anilist.New(d)}

	now := time.Now()
	day := int64(86400)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, want_dub)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - E{episode:02}', 'Ger')`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	// originals: 13 and 14 aired weeks ago, 16 aired yesterday, 17 is a week out
	ep := map[int]int64{13: now.Unix() - 29*day, 14: now.Unix() - 22*day, 16: now.Unix() - day, 17: now.Unix() + 6*day}
	for n, at := range ep {
		if n < 17 {
			d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, ?, '')`, at, n)
		}
	}
	// current schema and a finished status: anything else queues a refetch
	// that drops the cache row first, and there is no network here to
	// write it back
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","schedule":[{"airingAt":%d,"episode":17}]}`, anilist.MediaSchema, ep[17]))
	// the dub: 13 and 14 came out 21 days after their originals
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 13, 'de')`, ep[13]+21*day)
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 14, 'de')`, ep[14]+21*day)

	list, err := s.watchesFor(1)
	if err != nil || len(list) != 1 {
		t.Fatalf("watches: %v, %d", err, len(list))
	}
	var dub []Airing
	for _, a := range list[0].Airings {
		if a.Dub == "de" {
			dub = append(dub, a)
		}
	}
	// 14's release is a day inside the week the calendar shows, 13's is not;
	// 16 and 17 are projected, nothing is projected twice
	if len(dub) != 3 {
		t.Fatalf("dub slots = %+v, want the release of 14 and projections for 16 and 17", dub)
	}
	if dub[0].Episode != 14 || dub[0].Est || dub[0].At != ep[14]+21*day {
		t.Errorf("recorded release = %+v, want episode 14 as released, not estimated", dub[0])
	}
	if dub[1].Episode != 16 || !dub[1].Est || dub[1].At != ep[16]+21*day {
		t.Errorf("projection = %+v, want episode 16 three weeks after its original, estimated", dub[1])
	}
	if dub[2].Episode != 17 || !dub[2].Est || dub[2].At != ep[17]+21*day {
		t.Errorf("projection = %+v, want episode 17 three weeks after its original, estimated", dub[2])
	}
	// the original slots are untouched by the dub's presence
	var orig int
	for _, a := range list[0].Airings {
		if a.Dub == "" {
			orig++
		}
	}
	if orig != 2 {
		t.Errorf("original slots = %d, want 16 (yesterday) and 17 (ahead)", orig)
	}

	// no release seen yet: the watch's own lag projects, and without one
	// nothing does
	d.Exec(`DELETE FROM airings WHERE lang = 'de'`)
	list, _ = s.watchesFor(1)
	for _, a := range list[0].Airings {
		if a.Dub != "" {
			t.Fatalf("without a release or a lag, no dub slot should show: %+v", a)
		}
	}
	if _, err := d.Exec(`UPDATE watches SET dub_lag_days = 28`); err != nil {
		t.Fatal(err)
	}
	list, _ = s.watchesFor(1)
	var got []Airing
	for _, a := range list[0].Airings {
		if a.Dub == "de" {
			got = append(got, a)
		}
	}
	if len(got) != 2 || got[0].At != ep[16]+28*day || !got[0].Est {
		t.Errorf("with a lag of 28 days: %+v, want 16 and 17 projected four weeks out", got)
	}
}
