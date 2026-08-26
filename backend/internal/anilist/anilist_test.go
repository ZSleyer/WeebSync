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

// the recommendations query nests media one level deeper than the cached form;
// both must read back into the same struct.
func TestRecommendationsRoundTrip(t *testing.T) {
	const live = `{"nodes":[{"rating":412,"mediaRecommendation":{"id":9,"title":{"romaji":"Kino"},"averageScore":83}},
		{"rating":-3,"mediaRecommendation":{"id":11,"title":{"romaji":"Haibane"}}}]}`
	var conn struct {
		Nodes []Recommendation `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(live), &conn); err != nil {
		t.Fatalf("live shape: %v", err)
	}
	if len(conn.Nodes) != 2 || conn.Nodes[0].Rating != 412 || conn.Nodes[0].Media.ID != 9 {
		t.Fatalf("got %+v", conn.Nodes)
	}
	if conn.Nodes[1].Rating != -3 {
		t.Fatalf("downvoted edge lost its rating: %+v", conn.Nodes[1])
	}
	payload, err := json.Marshal(conn.Nodes)
	if err != nil {
		t.Fatal(err)
	}
	var back []Recommendation
	if err := json.Unmarshal(payload, &back); err != nil {
		t.Fatalf("cached shape: %v", err)
	}
	if len(back) != 2 || back[0].Media.Title.Romaji != "Kino" || back[0].Rating != 412 {
		t.Fatalf("round trip lost fields: %+v", back)
	}
}
