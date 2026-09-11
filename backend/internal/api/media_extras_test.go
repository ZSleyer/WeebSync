package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMediaExtras(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d)}
	// no network in tests: every miss is a failure, so a cached answer must
	// never touch the client and a miss must surface as 502
	s.Anilist.HTTP = &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("offline")
	})}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	c := cookieForUser(t, d, 1)

	// fully cached title: the three caches the handler composes
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('rel2:7', '[{"relationType":"SEQUEL","node":{"id":8,"title":{"romaji":"Two"}}}]')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('rec1:7', '[{"rating":9,"mediaRecommendation":{"id":9,"title":{"romaji":"Three"}}}]')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('extras1:7', '{"characters":[{"name":"Frieren","voiceActor":"Atsumi Tanezaki"}],"links":[{"site":"Crunchyroll","url":"https://example.com","type":"STREAMING"}],"threads":[{"id":1,"title":"Ep 1 discussion","replies":3,"url":"https://example.com/t"}]}')`)
	rec := doReq(mux, "GET", "/api/media/extras?id=7", "", c)
	if rec.Code != http.StatusOK {
		t.Fatalf("cached: got %d: %s", rec.Code, rec.Body)
	}
	body := rec.Body.Bytes()
	for _, want := range []string{`"relationType":"SEQUEL"`, `"id":9`, `"name":"Frieren"`, `"site":"Crunchyroll"`, `"title":"Ep 1 discussion"`} {
		if !jsonHas(body, want) {
			t.Errorf("cached body lacks %s: %s", want, body)
		}
	}

	// a miss with the provider unreachable is a gateway error, not a crash
	if rec := doReq(mux, "GET", "/api/media/extras?id=8", "", c); rec.Code != http.StatusBadGateway {
		t.Errorf("miss: got %d, want 502", rec.Code)
	}
	if rec := doReq(mux, "GET", "/api/media/extras?id=7&source=imdb", "", c); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown source: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "GET", "/api/media/extras", "", c); rec.Code != http.StatusBadRequest {
		t.Errorf("no id: got %d, want 400", rec.Code)
	}
}
