package api

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

var fakeWordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

type fakeEntry struct {
	ID                      int
	Romaji, English, Format string
	Year                    int
	Synonyms                []string
}

// fakeSearchAnilist answers searches the way AniList does for a missing word: an
// entry is a hit only when every word of the query is in one of its titles.
func fakeSearchAnilist(t *testing.T, entries []fakeEntry, searches *atomic.Int32) *anilist.Client {
	t.Helper()
	cl := anilist.New(dbtest.Open(t))
	cl.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var in struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			return nil, err
		}
		data := map[string]any{}
		if searches != nil && strings.Contains(in.Query, "media(") {
			searches.Add(1)
		}
		for n, v := range in.Variables {
			idx, ok := strings.CutPrefix(n, "q")
			if !ok {
				continue
			}
			words := fakeWordRe.FindAllString(strings.ToLower(v.(string)), -1)
			var hits []any
			for _, e := range entries {
				has := map[string]bool{}
				for _, title := range append([]string{e.Romaji, e.English}, e.Synonyms...) {
					for _, w := range fakeWordRe.FindAllString(strings.ToLower(title), -1) {
						has[w] = true
					}
				}
				all := len(words) > 0
				for _, w := range words {
					all = all && has[w]
				}
				if all {
					hits = append(hits, map[string]any{"id": e.ID, "format": e.Format, "seasonYear": e.Year, "synonyms": e.Synonyms,
						"title": map[string]any{"romaji": e.Romaji, "english": e.English}})
				}
			}
			data["r"+idx] = map[string]any{"media": hits}
		}
		if strings.Contains(in.Query, "relations") {
			for n := range in.Variables {
				if idx, ok := strings.CutPrefix(n, "id"); ok {
					data["r"+idx] = map[string]any{"relations": map[string]any{"edges": []any{}}}
				}
			}
		}
		raw, _ := json.Marshal(map[string]any{"data": data})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{}}, nil
	})}
	cl.WithoutRateLimit()
	return cl
}

var relaxedFixtures = []fakeEntry{
	{ID: 1, Romaji: "Re:Zero kara Hajimeru Isekai Seikatsu", English: "Re:ZERO -Starting Life in Another World-", Format: "TV", Year: 2016},
	{ID: 2, Romaji: "SPY×FAMILY", English: "SPY x FAMILY", Format: "TV", Year: 2022},
	{ID: 3, Romaji: "SPY×FAMILY Part 2", English: "SPY x FAMILY Part 2", Format: "TV", Year: 2022},
	{ID: 4, Romaji: "SPY×FAMILY Season 2", English: "SPY x FAMILY Season 2", Format: "TV", Year: 2023},
	{ID: 5, Romaji: "Dr. Stone", Format: "TV", Year: 2019},
	{ID: 6, Romaji: "Enen no Shouboutai", English: "Fire Force", Format: "TV", Year: 2019},
	{ID: 7, Romaji: "Enen no Shouboutai: Ni no Shou", English: "Fire Force Season 2", Format: "TV", Year: 2020},
	{ID: 8, Romaji: "Kimi no Na wa.", English: "Your Name.", Format: "MOVIE", Year: 2016},
	{ID: 9, Romaji: "Mewkledreamy", Format: "TV", Year: 2020},
	{ID: 10, Romaji: "Senki Zesshou Symphogear", Format: "TV", Year: 2012},
	{ID: 11, Romaji: "Senki Zesshou Symphogear G", Format: "TV", Year: 2013},
	{ID: 12, Romaji: "Made in Abyss", Format: "TV", Year: 2017},
	{ID: 13, Romaji: "Shin Shirayukihime Densetsu Pretear", Format: "TV", Year: 2001},
	{ID: 14, Romaji: "Ore wo Suki nano wa Omae dake ka yo", Format: "TV", Year: 2019, Synonyms: []string{"Oresuki"}},
}

func TestMatchBatchFallbacks(t *testing.T) {
	var searches atomic.Int32
	cl := fakeSearchAnilist(t, relaxedFixtures, &searches)
	s := testServer(t, &Server{DB: cl.DB, Anilist: cl})

	cases := []struct {
		folder string
		want   int // 0 = stays unmatched
	}{
		// each fallback the folder needs
		{"Spy x Family Part 2 [JapDub,GerEngSub,CR]", 3},             // x for the times sign, Part 2 entry
		{"Mewkledreamy [JapDub,EngSub,Yumi] dropped", 9},             // free text after the tags
		{"Senki Zesshou Symphogear -2- G [JapDub,GerEngSub,CR]", 11}, // -2- infix
		// siblings and collections that must stay unmatched
	}
	var batch []matchJob
	for _, c := range cases {
		batch = append(batch, matchJob{serverID: 1, folder: "/lib/" + c.folder, name: c.folder})
	}
	for start := 0; start < len(batch); start += 10 {
		s.matchBatch(batch[start:min(start+10, len(batch))])
	}
	for _, c := range cases {
		var got int
		if err := s.DB.QueryRow(`SELECT media_id FROM catalog_matches WHERE server_id = 1 AND folder = ?`, "/lib/"+c.folder).Scan(&got); err != nil {
			t.Fatalf("%q: no match row: %v", c.folder, err)
		}
		if got != c.want {
			t.Errorf("%q matched %d, want %d", c.folder, got, c.want)
		}
	}
}
