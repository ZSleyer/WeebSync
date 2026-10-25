package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// seedTVWatch gives user uid a server, a watch on /<name> matched to AniList
// media id, the media in the cache with one slot per future offset, and the
// past slots recorded.
func (dt *deviceTest) seedTVWatch(uid int64, name string, id int, past, future []time.Duration) {
	dt.t.Helper()
	d := dt.s.DB
	now := time.Now()
	res, err := d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (?, ?, 'sftp', 'localhost', 22, 'u', X'00', '/')`, uid, name+" srv")
	if err != nil {
		dt.t.Fatal(err)
	}
	sid, _ := res.LastInsertId()
	folder := "/" + name
	if _, err := d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template)
		VALUES (?, ?, ?, ?, 'template', '')`, uid, sid, folder, name); err != nil {
		dt.t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (?, ?, ?, 'anilist')`, sid, folder, id); err != nil {
		dt.t.Fatal(err)
	}
	sched := ""
	for i, f := range future {
		if i > 0 {
			sched += ","
		}
		sched += fmt.Sprintf(`{"airingAt":%d,"episode":%d}`, now.Add(f).Unix(), 10+i)
	}
	payload := fmt.Sprintf(`{"id":%d,"schema":99,"status":"RELEASING","title":{"romaji":%q,"english":"EN %s"},
		"coverImage":{"large":"https://img.example/%d-l.jpg","extraLarge":"https://img.example/%d-xl.jpg"},
		"schedule":[%s]}`, id, name, name, id, id, sched)
	if _, err := d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, ?)`, fmt.Sprintf("media:%d", id), payload); err != nil {
		dt.t.Fatal(err)
	}
	for i, p := range past {
		if _, err := d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode) VALUES ('anilist', ?, ?, ?)`,
			id, now.Add(-p).Unix(), 1+i); err != nil {
			dt.t.Fatal(err)
		}
	}
}

type tvCal struct {
	WatchID     int64  `json:"watchId"`
	AnilistID   int    `json:"anilistId"`
	Title       string `json:"title"`
	Episode     int    `json:"episode"`
	AiringAt    int64  `json:"airingAt"`
	Dub         bool   `json:"dub"`
	Estimated   bool   `json:"estimated"`
	Have        bool   `json:"have"`
	PosterURL   string `json:"posterUrl"`
	BackdropURL string `json:"backdropUrl"`
	Media       any    `json:"media"`
}

func (dt *deviceTest) calendar(tok, query string) []tvCal {
	dt.t.Helper()
	rec := dt.do("GET", "/api/tv/calendar"+query, "", nil, tok, "")
	if rec.Code != http.StatusOK {
		dt.t.Fatalf("calendar%s: %d %s", query, rec.Code, rec.Body)
	}
	var out []tvCal
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		dt.t.Fatal(err)
	}
	return out
}

// The calendar holds the caller's own slots from six hours back to the days
// asked for (clamped to 1..14), flat and sorted, with the picture URLs.
func TestTVCalendar(t *testing.T) {
	dt := newDeviceTest(t)
	h := time.Hour
	dt.seedTVWatch(1, "AliceShow", 5, []time.Duration{7 * h, 2 * h}, []time.Duration{50 * h, 26 * h, 10 * 24 * h, 20 * 24 * h})
	dt.seedTVWatch(2, "BobShow", 6, []time.Duration{h}, []time.Duration{3 * h})
	// the backdrop /api/media/backdrop would have found and cached
	for _, q := range []string{
		`INSERT INTO anime_ids (anilist_id, tmdb_id, tmdb_kind) VALUES (5, 77, 'tv')`,
		`INSERT INTO anilist_cache (key, payload) VALUES ('tmdb:backdrop:tv:77', '{"file_path":"/bd.jpg","width":1920}')`,
	} {
		if _, err := dt.s.DB.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	alice := dt.link(dt.alice, "A")
	bob := dt.link(dt.bob, "B")

	got := dt.calendar(alice, "")
	// 2 h ago, +26 h, +50 h; not 7 h ago, not +10 or +20 days
	if len(got) != 3 {
		t.Fatalf("default calendar = %+v, want 3 slots", got)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].AiringAt > got[i].AiringAt {
			t.Errorf("not sorted by airingAt: %+v", got)
		}
	}
	first := got[0]
	if first.Episode != 2 || time.Since(time.Unix(first.AiringAt, 0)) < time.Hour {
		t.Errorf("first slot = %+v, want the episode that aired 2 h ago", first)
	}
	if got[1].Episode != 11 || got[2].Episode != 10 {
		t.Errorf("future slots = %+v, want episodes 11 (+26 h) then 10 (+50 h)", got[1:])
	}
	for _, it := range got {
		if it.Title != "EN AliceShow" || it.AnilistID != 5 || it.WatchID == 0 || it.Dub || it.Estimated {
			t.Errorf("slot %+v: want alice's watch, the display title the web UI shows (English first for AniList), AniList id 5, original", it)
		}
		if it.PosterURL != "https://img.example/5-xl.jpg" || it.BackdropURL != "https://image.tmdb.org/t/p/w1280/bd.jpg" {
			t.Errorf("pictures of %+v", it)
		}
		if it.Media != nil {
			t.Errorf("slot embeds a media object")
		}
	}

	for _, c := range []struct {
		q    string
		want int
	}{
		{"?days=1", 1},   // 2 h ago; +26 h is past one day
		{"?days=0", 1},   // clamped up to 1
		{"?days=-3", 3},  // not digits: the default 7
		{"?days=abc", 3}, // the default
		{"?days=11", 4},  // +10 days in
		{"?days=99", 4},  // clamped to 14: +20 days stays out
		{"?days=14", 4},
	} {
		if n := len(dt.calendar(alice, c.q)); n != c.want {
			t.Errorf("calendar%s: %d slots, want %d", c.q, n, c.want)
		}
	}

	// bob's token: only bob's watch
	for _, it := range dt.calendar(bob, "?days=14") {
		if it.Title != "EN BobShow" || it.AnilistID != 6 {
			t.Errorf("bob sees %+v", it)
		}
	}
	if n := len(dt.calendar(bob, "")); n != 2 {
		t.Errorf("bob's calendar: %d slots, want 2", n)
	}
}

func TestTVIntParam(t *testing.T) {
	for q, want := range map[string]int{"": 7, "x": 7, "+5": 7, "5": 5, "0": 1, "15": 14, "99999999999999999999": 7, "007": 7} {
		r, _ := http.NewRequest("GET", "/?days="+q, nil)
		if got := tvIntParam(r, "days", 7, 1, 14); got != want {
			t.Errorf("days=%q: %d, want %d", q, got, want)
		}
	}
}

type tvRec struct {
	WatchID    int64  `json:"watchId"`
	Title      string `json:"title"`
	Season     int    `json:"season"`
	Episode    int    `json:"episode"`
	FinishedAt int64  `json:"finishedAt"`
	PosterURL  string `json:"posterUrl"`
}

func (dt *deviceTest) recent(tok, query string) []tvRec {
	dt.t.Helper()
	rec := dt.do("GET", "/api/tv/recent"+query, "", nil, tok, "")
	if rec.Code != http.StatusOK {
		dt.t.Fatalf("recent%s: %d %s", query, rec.Code, rec.Body)
	}
	var out []tvRec
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		dt.t.Fatal(err)
	}
	return out
}

// Recent lists the caller's finished downloads, one entry per episode and
// newest first; another user's downloads never show, not even on the same
// series path.
func TestTVRecent(t *testing.T) {
	dt := newDeviceTest(t)
	dt.seedTVWatch(1, "AliceShow", 5, nil, nil)
	dt.seedTVWatch(2, "BobShow", 6, nil, nil)
	at := func(ago time.Duration) string { return time.Now().Add(-ago).UTC().Format("2006-01-02 15:04:05") }
	for _, q := range []struct {
		user, server   int64
		remote, status string
		ago            time.Duration
	}{
		{1, 1, "/AliceShow/Show - S01E01 [1080p].mkv", "done", 5 * time.Hour},
		{1, 1, "/AliceShow/Show - S01E01 [720p].mkv", "done", 4 * time.Hour}, // the same episode again
		{1, 1, "/AliceShow/Show - S01E02 [1080p].mkv", "done", 2 * time.Hour},
		{1, 1, "/AliceShow/Show - S01E03 [1080p].mkv", "error", time.Hour},
		{1, 1, "/AliceShow/Show - S01E04 [1080p].mkv", "running", time.Minute},
		{2, 2, "/BobShow/Bob - S02E07 [1080p].mkv", "done", 3 * time.Hour},
	} {
		if _, err := dt.s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`, q.user, q.server, q.remote, "x"+q.remote, q.status, at(q.ago)); err != nil {
			t.Fatal(err)
		}
	}
	alice := dt.link(dt.alice, "A")
	bob := dt.link(dt.bob, "B")

	got := dt.recent(alice, "")
	if len(got) != 2 {
		t.Fatalf("alice's recent = %+v, want episodes 2 and 1", got)
	}
	if got[0].Episode != 2 || got[1].Episode != 1 || got[0].Season != 1 {
		t.Errorf("order = %+v, want S01E02 then S01E01", got)
	}
	if want := time.Now().Add(-4 * time.Hour).Unix(); got[1].FinishedAt < want-5 || got[1].FinishedAt > want+5 {
		t.Errorf("episode 1 finished at %d, want its newest copy (%d)", got[1].FinishedAt, want)
	}
	for _, it := range got {
		if it.WatchID != 1 || it.Title != "EN AliceShow" || it.PosterURL != "https://img.example/5-xl.jpg" {
			t.Errorf("entry %+v: want alice's watch, title and poster", it)
		}
	}
	if n := len(dt.recent(alice, "?limit=1")); n != 1 {
		t.Errorf("limit=1: %d entries", n)
	}
	if n := len(dt.recent(alice, "?limit=0")); n != 1 {
		t.Errorf("limit=0: %d entries, want clamped to 1", n)
	}
	if n := len(dt.recent(alice, "?limit=500")); n != 2 {
		t.Errorf("limit=500: %d entries, want all 2 (clamped to 50)", n)
	}

	b := dt.recent(bob, "")
	if len(b) != 1 || b[0].Title != "EN BobShow" || b[0].Season != 2 || b[0].Episode != 7 || b[0].WatchID != 2 {
		t.Errorf("bob's recent = %+v, want only his S02E07", b)
	}

	// alice downloads under the path bob's watch uses, on her own server:
	// still not bob's, and not tied to bob's watch
	if _, err := dt.s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, updated_at)
		VALUES (1, 1, '/BobShow/Bob - S02E08.mkv', 'x', 'done', ?)`, at(0)); err != nil {
		t.Fatal(err)
	}
	for _, it := range dt.recent(bob, "") {
		if it.Episode == 8 {
			t.Errorf("bob sees alice's download: %+v", it)
		}
	}
	for _, it := range dt.recent(alice, "") {
		if it.WatchID == 2 || it.Title == "EN BobShow" {
			t.Errorf("alice's download is tied to bob's watch or match: %+v", it)
		}
	}
}

// Only videos and books count as arrived episodes: the sidecar files a
// download queues with them (.nfo, pictures, fonts, subtitles) neither take
// the episode's place nor fill the list, not even past the rows scanned.
func TestTVRecentSkipsSidecars(t *testing.T) {
	dt := newDeviceTest(t)
	dt.seedTVWatch(1, "AliceShow", 5, nil, nil)
	at := func(ago time.Duration) string { return time.Now().Add(-ago).UTC().Format("2006-01-02 15:04:05") }
	add := func(remote, local string, ago time.Duration) {
		t.Helper()
		if _, err := dt.s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, updated_at)
			VALUES (1, 1, ?, ?, 'done', ?)`, remote, local, at(ago)); err != nil {
			t.Fatal(err)
		}
	}
	add("/AliceShow/Show - S01E05 [1080p].mkv", "AliceShow/Show - S01E05.mkv", 3*time.Hour)
	// a renamed copy whose local name lost the extension: the remote one decides
	add("/AliceShow/Show - S01E06 [1080p].mp4", "AliceShow/Show - S01E06", 3*time.Hour)
	add("/AliceShow/Show - S01E05 [1080p].nfo", "AliceShow/Show - S01E05.nfo", 2*time.Hour)
	add("/AliceShow/Show - S01E05 [1080p].jpg", "AliceShow/Show - S01E05.jpg", 2*time.Hour)
	add("/AliceShow/Show - S01E05 [1080p].srt", "AliceShow/Show - S01E05.srt", time.Hour)
	// more sidecars than one scan reads, all newer than the videos
	tx, err := dt.s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := range tvRecentScan + 10 {
		if _, err := tx.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, updated_at)
			VALUES (1, 1, ?, ?, 'done', ?)`, fmt.Sprintf("/AliceShow/fonts/f%d.ttf", i), fmt.Sprintf("AliceShow/fonts/f%d.TTF", i), at(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	tok := dt.link(dt.alice, "A")
	got := dt.recent(tok, "")
	if len(got) != 2 || got[0].Episode+got[1].Episode != 11 {
		t.Fatalf("recent = %+v, want only the two videos", got)
	}
	want := time.Now().Add(-3 * time.Hour).Unix()
	for _, it := range got {
		if it.FinishedAt < want-5 || it.FinishedAt > want+5 {
			t.Errorf("%+v finished at %d, want the video's own time %d", it, it.FinishedAt, want)
		}
	}
}
