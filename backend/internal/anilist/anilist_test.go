package anilist

import "testing"

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
