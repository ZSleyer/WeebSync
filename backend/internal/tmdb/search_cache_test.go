package tmdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A search narrowed to a year must not stand in for the free search of the
// same words: "Show (2020)" matched first would otherwise fill "show" with the
// 2020 hits and hide the 1990 series.
func TestSearchWithYearDoesNotFillThePlainSearch(t *testing.T) {
	var plain atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("first_air_date_year") != "" {
			w.Write([]byte(`{"results":[{"id":1,"name":"Show 2020","first_air_date":"2020-01-01"}]}`))
			return
		}
		plain.Add(1)
		w.Write([]byte(`{"results":[{"id":2,"name":"Show 1990","first_air_date":"1990-01-01"},{"id":1,"name":"Show 2020","first_air_date":"2020-01-01"}]}`))
	}))
	defer srv.Close()
	d := dbtest.Open(t)
	db.SetSetting(d, "tmdb_api_key", "test.jwt.token")
	c := New(d)
	c.BaseURL = srv.URL
	ctx := context.Background()

	if l, err := c.Search(ctx, "tv", "Show", 2020); err != nil || len(l) != 1 {
		t.Fatalf("year search: %v %v", l, err)
	}
	l, err := c.Search(ctx, "tv", "Show", 0)
	if err != nil || len(l) != 2 {
		t.Fatalf("plain search after a year search: %d hits, %v, want the real ranking of 2", len(l), err)
	}
	if plain.Load() != 1 {
		t.Errorf("plain search hit TMDB %d times, want 1", plain.Load())
	}
}
