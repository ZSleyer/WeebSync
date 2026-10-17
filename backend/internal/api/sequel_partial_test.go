package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/match"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// RelationsBatch answers 10 ids per request. When the second request fails it
// still returns the first ten; fixSequelPicks must judge with them instead of
// throwing the whole batch away.
func TestFixSequelPicksUsesPartialRelations(t *testing.T) {
	var calls atomic.Int32
	cl := anilist.New(dbtest.Open(t))
	cl.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if calls.Add(1) > 1 {
			return &http.Response{StatusCode: http.StatusInternalServerError, Body: io.NopCloser(strings.NewReader("{}")), Header: http.Header{}}, nil
		}
		var in struct {
			Variables map[string]int `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			return nil, err
		}
		data := map[string]any{}
		for n := range in.Variables {
			idx := strings.TrimPrefix(n, "id")
			id := in.Variables[n]
			data["r"+idx] = map[string]any{"relations": map[string]any{"edges": []any{map[string]any{
				"relationType": "SEQUEL",
				"node":         map[string]any{"id": id + 1000, "format": "TV", "title": map[string]any{"romaji": fmt.Sprintf("Show %c Season 2", rune('A'+id))}},
			}}}}
		}
		raw, _ := json.Marshal(map[string]any{"data": data})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{}}, nil
	})}
	cl.WithoutRateLimit()
	s := testServer(t, &Server{Anilist: cl})

	const n = 12
	infos := make([]match.Info, n)
	picked := make([]*anilist.Media, n)
	for i := range picked {
		infos[i] = match.Info{Season: 2}
		picked[i] = &anilist.Media{ID: i + 1, Format: "TV"}
		picked[i].Title.Romaji = fmt.Sprintf("Show %c", rune('A'+i+1))
	}
	s.fixSequelPicks(t.Context(), infos, picked, make([]bool, n))

	upgraded := 0
	for i, m := range picked {
		if m.ID == i+1+1000 {
			upgraded++
		}
	}
	if upgraded != 10 {
		t.Fatalf("%d picks moved to their season-2 entry, want the 10 of the batch that resolved", upgraded)
	}
}

// The model reads aiLists' text: a linked user whose list is not cached yet
// (AniList unreachable) must not be told to link an account.
func TestAiListsSaysNotLoadedForALinkedAccount(t *testing.T) {
	s, _, _, _, d := linkedServer(t)
	s.Anilist.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("anilist unreachable")
	})}
	got := s.aiLists(1).(map[string]any)["anilist"]
	if msg, _ := got.(string); !strings.Contains(msg, "not loaded yet") {
		t.Fatalf("linked account, nothing cached: %v", got)
	}
	d.Exec(`DELETE FROM anilist_accounts`)
	got = s.aiLists(1).(map[string]any)["anilist"]
	if msg, _ := got.(string); !strings.Contains(msg, "no AniList account linked") {
		t.Fatalf("no account: %v", got)
	}
}
