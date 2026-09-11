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
