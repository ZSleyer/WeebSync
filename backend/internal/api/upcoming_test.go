package api

import (
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
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
		media(4, "TV", "RELEASING", anilist.Date(2026, 10, 1)),        // started too long ago: just missing
		media(5, "TV", "RELEASING", anilist.Date(2026, 10, 0)),        // month only: can't tell
		media(6, "MOVIE", "NOT_YET_RELEASED", 0),                      // not a series
		media(7, "ONA", "NOT_YET_RELEASED", 0),                        // on the server already
		media(8, "TV_SHORT", "NOT_YET_RELEASED", 0),                   // coming
	}
	got := upcomingOf(list, map[int]bool{7: true}, now)
	var ids []int
	for _, m := range got {
		ids = append(ids, m.ID)
		if m.Title.Preferred == "" {
			t.Errorf("media %d: no display title", m.ID)
		}
	}
	want := []int{1, 2, 3, 8}
	if len(ids) != len(want) {
		t.Fatalf("got %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("got %v, want %v", ids, want)
		}
	}
}
