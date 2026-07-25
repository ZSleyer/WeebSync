package api

import (
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// nums builds the key set localEpisodeNums parses out of a file listing, so the
// tests read like the files they stand for.
func nums(pairs ...[2]int) map[int]bool {
	m := map[int]bool{}
	for _, p := range pairs {
		m[epKey(p[0], p[1])] = true
	}
	return m
}

func TestGapSeasons(t *testing.T) {
	for _, tc := range []struct {
		name string
		have map[int]bool
		want []int
	}{
		{"hole in one season", nums([2]int{1, 1}, [2]int{1, 2}, [2]int{1, 4}), []int{1}},
		{"holes in two", nums([2]int{1, 1}, [2]int{1, 3}, [2]int{3, 5}, [2]int{3, 7}), []int{1, 3}},
		{"a season without a hole stays out", nums([2]int{1, 1}, [2]int{1, 3}, [2]int{2, 1}, [2]int{2, 2}), []int{1}},
		// the badge would not fire here, but a direct call must still get a list
		{"no hole anywhere falls back to the newest season", nums([2]int{1, 1}, [2]int{2, 1}, [2]int{2, 2}), []int{2}},
		// specials are inherently sparse, missingEpisodes skips them too
		{"specials are ignored", nums([2]int{0, 1}, [2]int{0, 9}, [2]int{1, 1}), []int{1}},
		{"nothing local", map[int]bool{}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := gapSeasons(tc.have); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("gapSeasons = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSeasonAlias(t *testing.T) {
	eps := []provEpisode{{Season: 2, Number: 1}, {Season: 3, Number: 1}}
	// the provider knows the local season: identity, no guessing
	if got := seasonAlias([]int{2}, eps, 5); !reflect.DeepEqual(got, map[int]int{2: 2}) {
		t.Errorf("identity = %v", got)
	}
	// local S01 is a cour the provider counts as season 2, and it has no S01 at
	// all - only then does the Fribb season take over
	if got := seasonAlias([]int{1}, eps, 2); !reflect.DeepEqual(got, map[int]int{2: 1}) {
		t.Errorf("rescue = %v, want {2:1}", got)
	}
	// more than one local season: too ambiguous to remap
	want := map[int]int{1: 1, 4: 4}
	if got := seasonAlias([]int{1, 4}, eps, 2); !reflect.DeepEqual(got, want) {
		t.Errorf("multi season = %v, want %v", got, want)
	}
}

func TestMarkBySeason(t *testing.T) {
	eps := []provEpisode{
		{Season: 1, Number: 1, Title: "Erste", Aired: "2013-10-03"},
		{Season: 1, Number: 2, Title: "Zweite", Aired: "2013-10-10"},
		{Season: 1, Number: 3, Title: "Dritte", Aired: "2013-10-17"},
		{Season: 2, Number: 1, Title: "Fremde Staffel"},
	}
	got := markBySeason(eps, nums([2]int{1, 1}, [2]int{1, 3}), map[int]int{1: 1})
	if len(got) != 3 {
		t.Fatalf("want the three episodes of season 1, got %d: %+v", len(got), got)
	}
	if !got[0].Have || got[1].Have || !got[2].Have {
		t.Errorf("presence = %v %v %v, want true false true", got[0].Have, got[1].Have, got[2].Have)
	}
	if got[1].Title != "Zweite" || got[1].Aired != "2013-10-10" {
		t.Errorf("provider metadata lost: %+v", got[1])
	}
}

func TestMarkBySeasonWritesTheLocalSeason(t *testing.T) {
	// TVDB counts this cour as season 2, on disk it is Season 01
	eps := []provEpisode{{Season: 2, Number: 1, Title: "Auftakt"}}
	got := markBySeason(eps, nums([2]int{1, 1}), map[int]int{2: 1})
	if len(got) != 1 || got[0].Season != 1 || !got[0].Have {
		t.Fatalf("want season 1 present, got %+v", got)
	}
}

// One Piece and Conan carry {episode-N} templates: the file for absolute 1206
// is named E59, so the join has to go through the offset.
func TestMarkByAbsolute(t *testing.T) {
	eps := []provEpisode{
		{Season: 33, Number: 12, Absolute: 1206, Title: "Der Fall im Zug"},
		{Season: 33, Number: 13, Absolute: 1207, Title: "Schatten am Hafen"},
		{Season: 33, Number: 14, Absolute: 1208, Title: "Die rote Schleife"},
		{Season: 0, Number: 4, Absolute: 0, Title: "Special"},
	}
	local := nums([2]int{33, 59}, [2]int{33, 61}) // 1206 and 1208, 1207 missing
	got := markByAbsolute(eps, local, 33, -1147)
	if len(got) != 3 {
		t.Fatalf("want the span 59..61, got %d: %+v", len(got), got)
	}
	if got[0].Episode != 59 || got[0].Local != 59 || got[0].Absolute != 1206 || !got[0].Have {
		t.Errorf("first row = %+v", got[0])
	}
	if got[1].Episode != 60 || got[1].Have {
		t.Errorf("1207 should read as missing: %+v", got[1])
	}
}

func TestMarkByAbsoluteStaysInsideTheLocalSpan(t *testing.T) {
	eps := []provEpisode{
		{Season: 33, Number: 12, Absolute: 1206},
		{Season: 33, Number: 20, Absolute: 1214}, // beyond what is on disk
	}
	got := markByAbsolute(eps, nums([2]int{33, 59}), 33, -1147)
	// an absolute run has no upper bound; without the cap the list would run on
	if len(got) != 1 || got[0].Absolute != 1206 {
		t.Fatalf("want only the local span, got %+v", got)
	}
}

func TestSpanEpisodes(t *testing.T) {
	got := spanEpisodes(nums([2]int{1, 1}, [2]int{1, 2}, [2]int{1, 3}, [2]int{1, 5}), []int{1})
	if len(got) != 5 {
		t.Fatalf("want 1..5, got %d: %+v", len(got), got)
	}
	if got[3].Episode != 4 || got[3].Have {
		t.Errorf("episode 4 should be the gap: %+v", got[3])
	}
	if !got[4].Have {
		t.Errorf("episode 5 is present: %+v", got[4])
	}
}

func TestWatchEpisodesOwnershipAndDegradation(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	// no Tvdb/Tmdb client: the handler must degrade instead of reaching out
	s := &Server{DB: d}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1,'a@example.com',1), (2,'b@example.com',0)`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO watches (id, user_id, server_id, remote_path, local_path)
		VALUES (1, 1, 1, '/ftp/Show', 'Show')`)

	if rec := doReq(mux, "GET", "/api/watches/1/episodes", "", cookieForUser(t, d, 2)); rec.Code != http.StatusNotFound {
		t.Errorf("another user's watch: got %d, want 404", rec.Code)
	}
	rec := doReq(mux, "GET", "/api/watches/1/episodes", "", cookieForUser(t, d, 1))
	if rec.Code != http.StatusOK {
		t.Fatalf("own watch: got %d: %s", rec.Code, rec.Body)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"reason":"no_provider"`) || !strings.Contains(body, `"episodes":`) {
		t.Errorf("want a degraded but complete answer, got %s", body)
	}
}
