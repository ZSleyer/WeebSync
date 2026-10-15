package api

import (
	"image"
	"image/color"
	"testing"
)

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
