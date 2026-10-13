package api

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func bn(tier string, id int, url string) todayBanner {
	return todayBanner{Source: "anilist", ID: id, URL: url, Tier: tier}
}

// The tiers keep their order, a title comes once, a title without a banner
// never, and the page holds five at most.
func TestPickBannersTiers(t *testing.T) {
	watch := []todayBanner{bn("watch", 1, "u1"), bn("watch", 2, ""), bn("watch", 3, "u3")}
	match := []todayBanner{bn("match", 3, "u3"), bn("match", 4, "u4")}
	def := []todayBanner{bn("default", 21, "d21"), bn("default", 235, "d235"), bn("default", 4, "u4"), bn("default", 143270, "d3")}
	for seed := uint64(0); seed < 20; seed++ {
		got := pickBanners([][]todayBanner{watch, match, def}, 5, rand.New(rand.NewPCG(seed, 1)))
		if len(got) != 5 {
			t.Fatalf("seed %d: %d banners, want 5", seed, len(got))
		}
		ids := map[int]bool{}
		for _, b := range got {
			if ids[b.ID] {
				t.Fatalf("seed %d: id %d twice", seed, b.ID)
			}
			ids[b.ID] = true
		}
		// the two watch banners lead, then the match, then two defaults
		tiers := []string{got[0].Tier, got[1].Tier, got[2].Tier, got[3].Tier, got[4].Tier}
		want := []string{"watch", "watch", "match", "default", "default"}
		for i := range want {
			if tiers[i] != want[i] {
				t.Fatalf("seed %d: tiers %v, want %v", seed, tiers, want)
			}
		}
		if ids[2] {
			t.Fatalf("seed %d: a title without a banner was drawn", seed)
		}
	}
	if got := pickBanners(nil, 5, rand.New(rand.NewPCG(1, 1))); len(got) != 0 {
		t.Fatalf("nothing reachable: %v", got)
	}
}

// The draw changes between visits: over many draws more than one title leads.
func TestPickBannersShuffles(t *testing.T) {
	watch := []todayBanner{bn("watch", 1, "a"), bn("watch", 2, "b"), bn("watch", 3, "c"), bn("watch", 4, "d"), bn("watch", 5, "e"), bn("watch", 6, "f")}
	first := map[int]bool{}
	for seed := uint64(0); seed < 30; seed++ {
		first[pickBanners([][]todayBanner{watch}, 5, rand.New(rand.NewPCG(seed, 7)))[0].ID] = true
	}
	if len(first) < 2 {
		t.Fatalf("always the same first banner: %v", first)
	}
}

// The endpoint reads the banners from the media cache: a watch's matched title
// first, the defaults behind it, and it counts the caller's watches.
func TestTodayBannersEndpoint(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.Anilist = anilist.New(s.DB)
	cache := func(id int, banner string) {
		m := anilist.Media{ID: id, BannerImage: banner, Schema: anilist.MediaSchema}
		m.Title.Romaji = fmt.Sprintf("Title %d", id)
		payload, _ := json.Marshal(m)
		if _, err := s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, ?)`, fmt.Sprintf("media:%d", id), string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	if _, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/anime/Show', '/media/Show')`); err != nil {
		t.Fatal(err)
	}
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/anime/Show', 500, 'anilist')`)
	cache(500, "https://example.com/banner/500.jpg")
	// every default cached (nothing is fetched in a test), only one with a
	// banner: the others are skipped
	for _, id := range defaultBannerIDs {
		banner := ""
		if id == 21 {
			banner = "https://example.com/banner/21.jpg"
		}
		cache(id, banner)
	}

	rec := doReq(mux, "GET", "/api/today/banners", "", adminC)
	var got todayBannersResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%v %s", err, rec.Body)
	}
	if got.Watches != 1 {
		t.Errorf("watches = %d, want 1", got.Watches)
	}
	if len(got.Banners) != 2 {
		t.Fatalf("banners = %+v, want the watch's and one default", got.Banners)
	}
	if b := got.Banners[0]; b.ID != 500 || b.Tier != "watch" || b.URL != "https://example.com/banner/500.jpg" || b.Title != "Title 500" {
		t.Errorf("first = %+v", b)
	}
	if b := got.Banners[1]; b.ID != 21 || b.Tier != "default" {
		t.Errorf("second = %+v", b)
	}
}
