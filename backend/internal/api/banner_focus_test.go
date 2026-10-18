package api

import (
	"encoding/json"
	"image"
	"image/color"
	"net/url"
	"testing"
)

// The focus endpoint answers a cached map and refuses any host but AniList's.
func TestBannerFocusEndpoint(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	u := "https://s4.anilist.co/file/banner/1.jpg"
	raw, _ := json.Marshal(bannerFocus{W: 4, H: 1, Cols: []int{1, 2, 3, 4}, Rows: []int{5}})
	s.cacheSet(focusKey(u), string(raw))

	rec := doReq(mux, "GET", "/api/media/banner-focus?url="+url.QueryEscape(u), "", adminC)
	var got bannerFocusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != 200 || got.Focus == nil || got.Focus.W != 4 {
		t.Errorf("cached: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/media/banner-focus?url="+url.QueryEscape("https://example.com/b.jpg"), "", adminC)
	if rec.Code != 400 {
		t.Errorf("foreign host: %d, want 400", rec.Code)
	}
}

func TestFocusProfileFindsTheDetail(t *testing.T) {
	// a flat sky on the left two thirds, line art on the right third
	img := image.NewRGBA(image.Rect(0, 0, 900, 200))
	for y := range 200 {
		for x := range 900 {
			c := color.RGBA{120, 160, 220, 255}
			if x > 600 && (x/3+y/3)%2 == 0 {
				c = color.RGBA{20, 20, 20, 255}
			}
			img.Set(x, y, c)
		}
	}
	f := focusProfile(img)
	if f.W != 900 || f.H != 200 || len(f.Cols) != focusCols || len(f.Rows) != focusRows {
		t.Fatalf("shape: %+v", f)
	}
	left, right := 0, 0
	for i, v := range f.Cols {
		if i < focusCols/2 {
			left += v
		} else {
			right += v
		}
	}
	if right <= left*4 {
		t.Fatalf("detail not found on the right: left %d right %d (%v)", left, right, f.Cols)
	}
}

func TestAnilistImageOnly(t *testing.T) {
	for u, want := range map[string]bool{
		"https://s4.anilist.co/file/anilistcdn/media/anime/banner/1.jpg": true,
		"http://s4.anilist.co/file/x.jpg":                                false,
		"https://anilist.co.example.com/x.jpg":                           false,
		"https://127.0.0.1/x.jpg":                                        false,
		"":                                                               false,
	} {
		if got := anilistImage(u); got != want {
			t.Errorf("%q: got %v", u, got)
		}
	}
}
