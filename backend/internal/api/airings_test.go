package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/animeschedule"
	"github.com/ch4d1/weebsync/internal/crunchyroll"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The providers hand out the future only: an episode that aired yesterday is
// gone from their schedule, and the calendar used to have nothing to show for
// the days just gone. The sweep writes every slot down, the list endpoint reads
// the past week back - with the watch's own episode offset applied, because the
// table stores what the provider counted.
func TestPastAiringsFillTheCalendarWeek(t *testing.T) {
	d := dbtest.Open(t)
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
	d := dbtest.Open(t)
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

// The recorder asks Crunchyroll which episodes of a watched title came out in
// the dub its watch filters for, and writes their release moments down under
// the dub's language. Only released versions exist over there, so the
// episode whose dub is still to come leaves no row - the calendar projects it.
func TestRecordDubAiringsFromCrunchyroll(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/v1/token", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"access_token":"anon","expires_in":300}`))
	})
	mux.HandleFunc("/content/v2/cms/series/GRGG9798R/seasons", func(w http.ResponseWriter, r *http.Request) {
		// the older season first, as Crunchyroll lists them; the title we
		// watch is the newer one, which the start date picks
		w.Write([]byte(`{"data":[{"id":"GS0OLD","season_number":1,"audio_locale":"ja-JP"},{"id":"GS0NEW","season_number":2,"audio_locale":"ja-JP"}]}`))
	})
	mux.HandleFunc("/content/v2/cms/seasons/GS0NEW/episodes", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[
			{"id":"GE1JAJP","episode_number":1,"episode_air_date":"2026-04-08T00:00:00Z","premium_available_date":"2026-04-08T14:00:00Z","versions":[{"audio_locale":"ja-JP","guid":"GE1JAJP"},{"audio_locale":"de-DE","guid":"GE1DEDE"}]},
			{"id":"GE2JAJP","episode_number":2,"episode_air_date":"2026-04-15T00:00:00Z","premium_available_date":"2026-04-15T14:00:00Z","versions":[{"audio_locale":"ja-JP","guid":"GE2JAJP"}]}]}`))
	})
	mux.HandleFunc("/content/v2/cms/seasons/GS0OLD/episodes", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"GE0JAJP","episode_number":1,"episode_air_date":"2025-01-01T00:00:00Z","versions":[{"audio_locale":"ja-JP","guid":"GE0JAJP"}]}]}`))
	})
	objects := 0
	mux.HandleFunc("/content/v2/cms/objects/GE1DEDE", func(w http.ResponseWriter, r *http.Request) {
		objects++
		w.Write([]byte(`{"data":[{"id":"GE1DEDE","episode_metadata":{"episode_number":1,"audio_locale":"de-DE","premium_available_date":"2026-04-29T14:00:00Z"}}]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d), Crunchyroll: crunchyroll.NewAt(srv.URL)}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, want_dub)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - E{episode:02}', 'Ger')`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","startDate":20260408,"externalLinks":[{"site":"Crunchyroll","url":"https://www.crunchyroll.com/series/GRGG9798R/re-zero"}]}`, anilist.MediaSchema))

	s.recordDubAirings(context.Background())
	var at int64
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM airings WHERE media_id = 5 AND lang = 'de'`).Scan(&n)
	d.QueryRow(`SELECT airing_at FROM airings WHERE media_id = 5 AND lang = 'de' AND episode = 1`).Scan(&at)
	if n != 1 || at != 1777471200 { // 2026-04-29T14:00:00Z
		t.Fatalf("recorded %d dub rows, episode 1 at %d; want one row at 2026-04-29 14:00Z", n, at)
	}
	// the originals it never saw are filled in from Crunchyroll's own release
	// moments, so the lag has something to measure against from day one
	var orig int
	d.QueryRow(`SELECT COUNT(*) FROM airings WHERE media_id = 5 AND lang = ''`).Scan(&orig)
	if orig != 2 {
		t.Errorf("original rows = %d, want the two Japanese releases", orig)
	}
	// the season it settled on is remembered, and a version already written
	// down is not asked for again
	if v, ok := s.cacheGet("cr:season:5", time.Hour); !ok || v != "GS0NEW" {
		t.Errorf("season cache = %q, %v; want GS0NEW", v, ok)
	}
	s.recordDubAirings(context.Background())
	if objects != 1 {
		t.Errorf("objects fetched %d times, want once: the recorded version needs no second look", objects)
	}
}

// English has a published timetable: AnimeSchedule dates dub episodes weeks
// ahead. With a token the recorder writes those dates down as the dub's
// slots - announcements, so a date that moves is updated in place - and the
// week fetched once is not fetched again within the hour.
func TestRecordDubTimetableFromAnimeschedule(t *testing.T) {
	weeks := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/anime", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"anime":[{"route":"show-4th-season"}]}`))
	})
	mux.HandleFunc("/timetables/dub", func(w http.ResponseWriter, r *http.Request) {
		weeks++
		w.Write([]byte(`[{"route":"other","episodeDate":"2026-09-16T14:00:00Z","episodeNumber":3,"airType":"dub"},
			{"route":"show-4th-season","episodeDate":"2026-09-16T15:00:00Z","episodeNumber":15,"airType":"dub"}]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	d := dbtest.Open(t)
	as := animeschedule.New(d)
	as.BaseURL = srv.URL
	s := &Server{DB: d, Anilist: anilist.New(d), Animeschedule: as}
	d.Exec(`INSERT INTO settings (key, value) VALUES ('animeschedule_token', 'tok')`)

	if n := s.recordDubTimetable(context.Background(), 5, "en"); n != 1 {
		t.Fatalf("recorded %d rows, want the one episode of our title (the same slot repeats in every week asked)", n)
	}
	var at int64
	d.QueryRow(`SELECT airing_at FROM airings WHERE media_id = 5 AND lang = 'en' AND episode = 15`).Scan(&at)
	if at != 1789570800 { // 2026-09-16T15:00:00Z
		t.Errorf("episode 15 at %d, want 2026-09-16 15:00Z", at)
	}
	if weeks != 5 {
		t.Errorf("fetched %d weeks, want this one and four ahead", weeks)
	}
	if n := s.recordDubTimetable(context.Background(), 5, "en"); n != 0 || weeks != 5 {
		t.Errorf("second pass: %d rows changed, %d weeks fetched; want nothing changed and the cache answering", n, weeks)
	}
}

// A simuldub releases with the original. Its measured lag is zero, and zero
// is a measurement: the coming episodes get a dub slot at the original's time
// rather than none.
func TestSimuldubProjectsAtZeroLag(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d)}
	now := time.Now().Unix()
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, want_dub)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - E{episode:02}', 'Ger')`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","schedule":[{"airingAt":%d,"episode":11}]}`, anilist.MediaSchema, now+6*86400))
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 10, '')`, now-86400)
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 10, 'de')`, now-86400)
	list, err := s.watchesFor(1)
	if err != nil || len(list) != 1 {
		t.Fatalf("watches: %v", err)
	}
	var got []Airing
	for _, a := range list[0].Airings {
		if a.Dub == "de" {
			got = append(got, a)
		}
	}
	if len(got) != 2 || got[1].Episode != 11 || !got[1].Est || got[1].At != now+6*86400 {
		t.Fatalf("dub slots = %+v, want the release of 10 and episode 11 projected at the original's time", got)
	}
}

// dubStanding measures a watch against the dub schedule, not the original
// broadcast: released-but-not-local is behind, everything else is expected
// waiting - dated when the next original slot is known, overdue once the
// forecast plus the grace has passed.
func TestDubStanding(t *testing.T) {
	now := time.Now()
	day := int64(86400)
	fc := dubForecast{
		Known: true,
		Lag:   21 * day,
		Released: []Airing{
			{At: now.Unix() - 8*day, Episode: 1},
			{At: now.Unix() - day, Episode: 2},
		},
		OrigAt: map[int]int64{
			1: now.Unix() - 29*day, 2: now.Unix() - 22*day,
			3: now.Unix() - 15*day, 4: now.Unix() - 8*day,
		},
	}
	tests := []struct {
		name       string
		fc         dubForecast
		localFiles int
		behind     int
		expectedIn int64 // expectedAt - now, in days; 0 = no date
		overdue    bool
	}{
		{"caught up, next dub a week out", fc, 2, 0, 6, false},
		{"released but not local", fc, 1, 1, -1, false},
		{"nothing released yet, dub late", dubForecast{Known: true, Lag: 21 * day, OrigAt: fc.OrigAt}, 0, 0, -8, true},
		{"grace passed without a release", dubForecast{Known: true, Lag: 7 * day, OrigAt: fc.OrigAt}, 2, 0, -8, true},
		{"no original slot known", dubForecast{Known: true, Lag: 21 * day}, 2, 0, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			behind, expectedAt, overdue := dubStanding(tt.fc, 0, 1, tt.localFiles, now)
			if behind != tt.behind {
				t.Errorf("behind = %d, want %d", behind, tt.behind)
			}
			if overdue != tt.overdue {
				t.Errorf("overdue = %v, want %v", overdue, tt.overdue)
			}
			if tt.expectedIn == 0 {
				if expectedAt != 0 {
					t.Errorf("expectedAt = %d, want none", expectedAt)
				}
			} else if got := expectedAt - now.Unix(); got != tt.expectedIn*day {
				t.Errorf("expectedAt is %d days out, want %d", got/day, tt.expectedIn)
			}
		})
	}
}

// A dub watch whose backlog the forecast explains is waiting, not behind:
// Behind drops to what the dub itself has released, the language backlog
// stops being attention, and the expected date rides along. Once the
// forecast plus the grace has passed, the same watch is overdue.
func TestDubWatchWaitsInsteadOfBehind(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d)}

	now := time.Now()
	day := int64(86400)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, want_dub, dub_lag_days, last_filtered)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - E{episode:02}', 'Ger', 28, 2)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	// episode 1 aired the day before yesterday, 3 is dated ahead
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 1, '')`, now.Unix()-2*day)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","schedule":[{"airingAt":%d,"episode":3}]}`, anilist.MediaSchema, now.Unix()+5*day))

	list, err := s.watchesFor(1)
	if err != nil || len(list) != 1 {
		t.Fatalf("watches: %v, %d", err, len(list))
	}
	w := list[0]
	if w.Behind != 0 {
		t.Errorf("Behind = %d, want 0: trailing the original is what a dub watch does", w.Behind)
	}
	if !w.DubWaiting || w.DubOverdue {
		t.Errorf("DubWaiting = %v, DubOverdue = %v, want waiting and not overdue", w.DubWaiting, w.DubOverdue)
	}
	if want := now.Unix() - 2*day + 28*day; w.DubExpectedAt != want {
		t.Errorf("DubExpectedAt = %d, want %d (original plus the configured lag)", w.DubExpectedAt, want)
	}
	if len(w.Attention) != 0 {
		t.Errorf("Attention = %v, want none: the waiting is expected", w.Attention)
	}

	// the same watch with the forecast long past: overdue, and that is attention
	d.Exec(`UPDATE watches SET dub_lag_days = 1`)
	d.Exec(`UPDATE airings SET airing_at = ? WHERE lang = ''`, now.Unix()-20*day)
	list, _ = s.watchesFor(1)
	w = list[0]
	if !w.DubOverdue {
		t.Fatalf("DubOverdue = false, want true: expected %d days ago", 19)
	}
	if len(w.Attention) != 1 || w.Attention[0] != "dubOverdue" {
		t.Errorf("Attention = %v, want [dubOverdue]", w.Attention)
	}
}
