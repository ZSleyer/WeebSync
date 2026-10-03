package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestUpcomingOf(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	media := func(id int, format, status string, start anilist.FuzzyDate) anilist.Media {
		m := anilist.Media{ID: id, Format: format, Status: status, StartDate: start}
		m.Title.Romaji = "Show"
		return m
	}
	list := []anilist.Media{
		media(1, "TV", "NOT_YET_RELEASED", anilist.Date(2026, 11, 2)), // coming
		media(2, "TV", "NOT_YET_RELEASED", 0),                         // coming, undated
		media(3, "TV", "RELEASING", anilist.Date(2026, 10, 12)),       // started, within grace
		media(4, "TV", "RELEASING", anilist.Date(2026, 10, 1)),        // started too long ago: missing
		media(5, "TV", "RELEASING", anilist.Date(2026, 10, 0)),        // month only: can't tell, missing
		media(9, "TV", "FINISHED", anilist.Date(2026, 7, 1)),          // over: neither
		media(6, "MOVIE", "NOT_YET_RELEASED", 0),                      // not a series
		media(7, "ONA", "NOT_YET_RELEASED", 0),                        // on the server already
		media(8, "TV_SHORT", "NOT_YET_RELEASED", 0),                   // coming
	}
	upcoming, missing := upcomingOf(list, map[int]bool{7: true}, now)
	check := func(name string, got []anilist.Media, want []int) {
		var ids []int
		for _, m := range got {
			ids = append(ids, m.ID)
			if m.Title.Preferred == "" {
				t.Errorf("media %d: no display title", m.ID)
			}
		}
		if fmt.Sprint(ids) != fmt.Sprint(want) {
			t.Errorf("%s: got %v, want %v", name, ids, want)
		}
	}
	check("upcoming", upcoming, []int{1, 2, 3, 8})
	check("missing", missing, []int{4, 5})
}

func TestElsewhereFor(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d)}
	// 20: continuation of 10, which the server keeps under its first season
	// (twice: the later season folder wins); 30: matched itself elsewhere;
	// 40: nothing on this server, its prequel only on another one
	for _, row := range []struct {
		server int
		folder string
		id     int
	}{
		{1, "/2025-4 Fall/Show", 10},
		{1, "/2026-2 Spring/Show", 10},
		{1, "/2026-3 Summer/Other", 30},
		{2, "/2026-3 Summer/Third", 41},
	} {
		d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, 0, 'anilist')`,
			row.server, row.folder, row.id)
	}
	rels := map[int]string{
		20: `[{"relationType":"PREQUEL","node":{"id":10}},{"relationType":"SIDE_STORY","node":{"id":30}}]`,
		30: `[]`,
		40: `[{"relationType":"PREQUEL","node":{"id":41}}]`,
	}
	for id, payload := range rels {
		d.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES (?, ?, datetime('now'))`,
			fmt.Sprintf("rel2:%d", id), payload)
	}
	got := s.elsewhereFor(context.Background(), 1, []anilist.Media{{ID: 20}, {ID: 30}, {ID: 40}})
	want := map[int]string{20: "/2026-2 Spring/Show", 30: "/2026-3 Summer/Other"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
