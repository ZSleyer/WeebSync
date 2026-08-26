package anilist

import (
	"encoding/json"
	"testing"
)

func TestSearchCacheKeyNormalized(t *testing.T) {
	a := SearchReq{Query: "Show  Name"}
	b := SearchReq{Query: "show name"}
	if a.cacheKey() != b.cacheKey() {
		t.Errorf("case/whitespace variants should share a key: %q vs %q", a.cacheKey(), b.cacheKey())
	}
	c := SearchReq{Query: "Show Name", Season: "SUMMER", Year: 2026}
	if c.cacheKey() == a.cacheKey() {
		t.Error("season/year-filtered key must differ from the plain key")
	}
}

// media payloads are read back in two shapes: the GraphQL objects AniList
// returns, and the flattened form we marshal into the cache.
func TestMediaSortFieldsRoundTrip(t *testing.T) {
	const live = `{"popularity":4211,"studios":{"nodes":[{"name":"Bones"},{"name":""}]},
		"startDate":{"year":2026,"month":7,"day":5},"endDate":{"year":0,"month":0,"day":0}}`
	var m Media
	if err := json.Unmarshal([]byte(live), &m); err != nil {
		t.Fatalf("live shape: %v", err)
	}
	if m.Popularity != 4211 || len(m.Studios) != 1 || m.Studios[0] != "Bones" {
		t.Fatalf("got popularity %d studios %v", m.Popularity, m.Studios)
	}
	if m.StartDate != 20260705 || m.EndDate != 0 {
		t.Fatalf("got start %d end %d", m.StartDate, m.EndDate)
	}
	payload, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var back Media
	if err := json.Unmarshal(payload, &back); err != nil {
		t.Fatalf("cached shape: %v", err)
	}
	if back.StartDate != m.StartDate || len(back.Studios) != 1 || back.Popularity != m.Popularity {
		t.Fatalf("round trip lost fields: %+v", back)
	}
}
