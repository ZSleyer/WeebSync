package api

import (
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// poster paints an image whose red channel follows the row and green the column.
func poster(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{uint8(y * 255 / h), uint8(x * 255 / w), 0, 255})
		}
	}
	return img
}

func TestCropSquare(t *testing.T) {
	// a portrait keeps its upper part: 230x345 leaves 115 spare rows, 30% above
	out := cropSquare(poster(230, 345))
	if out.Bounds().Dx() != 230 || out.Bounds().Dy() != 230 {
		t.Fatalf("size %v", out.Bounds())
	}
	if want := 34 * 255 / 345; int(out.RGBAAt(0, 0).R)-want > 1 || want-int(out.RGBAAt(0, 0).R) > 1 {
		t.Fatalf("top row red %d, want about %d", out.RGBAAt(0, 0).R, want)
	}
	// a landscape keeps its middle
	out = cropSquare(poster(400, 200))
	if out.Bounds().Dx() != 200 || out.RGBAAt(0, 0).G < 60 || out.RGBAAt(0, 0).G > 70 {
		t.Fatalf("landscape: %v green %d", out.Bounds(), out.RGBAAt(0, 0).G)
	}
	// a big poster is scaled down to the cap
	if out := cropSquare(poster(1000, 1500)); out.Bounds().Dx() != pushCoverSide || out.Bounds().Dy() != pushCoverSide {
		t.Fatalf("big: %v", out.Bounds())
	}
}

func TestPushCoverEndpoint(t *testing.T) {
	s := digestTestServer(t)
	db.SetSetting(s.DB, "base_url", "https://weebsync.example.com")
	calls := 0
	old := pushCoverFetch
	pushCoverFetch = func(string) (image.Image, error) { calls++; return poster(230, 345), nil }
	t.Cleanup(func() { pushCoverFetch = old })

	cover := "https://s4.anilist.co/file/anilistcdn/media/anime/cover/c.jpg"
	link := s.pushCoverURL(cover)
	// the link warms the crop in the background; every request below is a cache hit
	s.Shutdown(context.Background())
	if calls != 1 {
		t.Fatalf("warmed with %d fetches", calls)
	}
	u, err := url.Parse(link)
	if err != nil || u.Host != "weebsync.example.com" || u.Path != "/api/push/cover" || u.Query().Get("u") != cover {
		t.Fatalf("link %q", link)
	}
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.handlePushCover(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	rec := get(u.RequestURI())
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	img, err := jpeg.Decode(rec.Body)
	if err != nil || img.Bounds().Dx() != 230 || img.Bounds().Dy() != 230 {
		t.Fatalf("not a square jpeg: %v %v", err, img)
	}
	// the second request comes from the cache
	if get(u.RequestURI()).Code != 200 || calls != 1 {
		t.Fatalf("fetched %d times", calls)
	}
	// a link the server did not sign is refused, and nothing is fetched for it
	other := "/api/push/cover?u=" + url.QueryEscape("https://s4.anilist.co/file/anilistcdn/media/anime/cover/x.jpg") + "&sig=" + u.Query().Get("sig")
	if get(other).Code != 404 || get("/api/push/cover?u="+url.QueryEscape(cover)).Code != 404 || calls != 1 {
		t.Fatalf("unsigned link served (%d fetches)", calls)
	}
}

func TestPushCoverURLFallsBack(t *testing.T) {
	s := digestTestServer(t)
	cover := "https://s4.anilist.co/file/anilistcdn/media/anime/cover/c.jpg"
	// no base URL: the plain cover goes out
	if got := s.pushCoverURL(cover); got != cover {
		t.Fatalf("got %q", got)
	}
	db.SetSetting(s.DB, "base_url", "http://weebsync.example.com")
	if got := s.pushCoverURL(cover); got != cover {
		t.Fatalf("plain-http origin: got %q", got)
	}
	if got := s.pushCoverURL(""); got != "" {
		t.Fatalf("empty: %q", got)
	}
	// a cover on any other host is not signed for a fetch
	db.SetSetting(s.DB, "base_url", "https://weebsync.example.com")
	if got := s.pushCoverURL("https://example.com/c.jpg"); got != "https://example.com/c.jpg" {
		t.Fatalf("foreign host: got %q", got)
	}
}
