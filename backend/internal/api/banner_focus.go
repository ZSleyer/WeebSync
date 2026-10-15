package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg" // AniList banners are JPEGs
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// A banner is far wider than the box that shows it (AniList's are about
// 4.7:1, a phone shows 16:9 and a desktop panel even less), so the box only
// ever sees a slice. Where the slice sits decides whether the picture shows
// its characters or the empty sky beside them. The server reads each banner
// once and keeps a coarse map of where its detail is; the page picks the
// slice with the most of it for the size it draws.

const (
	focusCols = 64
	focusRows = 16
	// the grid the detail is measured on: a face's outline survives it, a
	// meadow's blades do not
	focusGridW = 64
	// how much a skin-coloured cell weighs against the strongest outline,
	// and how strong an outline next to it has to be for it to count
	focusSkin     = 0.6
	focusSkinGate = 0.3
	focusMaxBytes = 8 << 20
	focusMaxSide  = 8000
	// a picture behind a URL never changes; a failed read is retried after
	// this long
	focusFailAge = 24 * time.Hour
)

// bannerFocus is where a banner's detail lies, per column and per row,
// scaled 0..100.
type bannerFocus struct {
	W    int   `json:"w"`
	H    int   `json:"h"`
	Cols []int `json:"cols"`
	Rows []int `json:"rows"`
}

// focusProfile scores each cell of a coarse grid by its outlines plus how
// much of it looks like skin. The grid is coarse on purpose: averaged into
// 64 columns, foliage, grass and rain blur into an even tone while a
// character's outline still stands out, and the skin term pulls the slice to
// faces rather than to the busiest corner of the background.
func focusProfile(img image.Image) bannerFocus {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	gw := min(focusGridW, w)
	gh := max(3, min(h, int(math.Round(float64(gw)*float64(h)/float64(w)))))
	// the cells' mean colour, from every second pixel each way
	type acc struct{ r, g, b, n float64 }
	cells := make([]acc, gw*gh)
	for y := 0; y < h; y += 2 {
		for x := 0; x < w; x += 2 {
			r, g, bl, _ := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			c := &cells[(y*gh/h)*gw+x*gw/w]
			c.r += float64(r) / 65535
			c.g += float64(g) / 65535
			c.b += float64(bl) / 65535
			c.n++
		}
	}
	gray := make([]float64, gw*gh)
	skin := make([]float64, gw*gh)
	for i, c := range cells {
		if c.n == 0 {
			continue
		}
		r, g, bl := c.r/c.n, c.g/c.n, c.b/c.n
		gray[i] = 0.299*r + 0.587*g + 0.114*bl
		hi, lo := max(r, g, bl), min(r, g, bl)
		if s := (hi - lo) / max(hi, 1e-6); r > g && g > bl && r-bl > 0.06 && hi > 0.55 && s > 0.08 && s < 0.6 {
			skin[i] = 1
		}
	}
	edge := make([]float64, gw*gh)
	top := 0.0
	for y := 1; y < gh-1; y++ {
		for x := 1; x < gw-1; x++ {
			i := y*gw + x
			edge[i] = math.Abs(gray[i+1]-gray[i-1]) + math.Abs(gray[i+gw]-gray[i-gw])
			top = max(top, edge[i])
		}
	}
	if top > 0 {
		for i := range edge {
			edge[i] /= top
		}
	}
	cols := make([]float64, focusCols)
	rows := make([]float64, focusRows)
	for y := range gh {
		for x := range gw {
			i := y*gw + x
			e := edge[i]
			// skin counts only next to an outline: a face has one, a sunset
			// in the same warm tones does not
			if skin[i] > 0 && nearEdge(edge, gw, gh, x, y) > focusSkinGate {
				e += focusSkin
			}
			cols[x*focusCols/gw] += e
			rows[y*focusRows/gh] += e
		}
	}
	return bannerFocus{W: w, H: h, Cols: scale100(cols), Rows: scale100(rows)}
}

// nearEdge is the strongest outline in the cell's 3x3 neighbourhood.
func nearEdge(edge []float64, gw, gh, x, y int) float64 {
	v := 0.0
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if xx, yy := x+dx, y+dy; xx >= 0 && yy >= 0 && xx < gw && yy < gh {
				v = max(v, edge[yy*gw+xx])
			}
		}
	}
	return v
}

func scale100(v []float64) []int {
	top := 0.0
	for _, x := range v {
		top = max(top, x)
	}
	out := make([]int, len(v))
	for i, x := range v {
		if top > 0 {
			out[i] = int(math.Round(x / top * 100))
		}
	}
	return out
}

// focusClient follows no redirect: one to another host would get past the
// check on the URL.
var focusClient = &http.Client{
	Timeout:       30 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func focusKey(u string) string { return "banner-focus:v1:" + u }

// cachedFocus is the banner's map, or nil while it has not been read; a
// banner not read yet is queued, and its map rides along on a later visit.
func (s *Server) cachedFocus(u string) *bannerFocus {
	if raw, ok := s.cacheGet(focusKey(u), 100*365*24*time.Hour); ok {
		var f bannerFocus
		if raw == "" || json.Unmarshal([]byte(raw), &f) != nil || f.W == 0 {
			return nil
		}
		return &f
	}
	if raw, ok := s.cacheGet(focusKey(u)+":fail", focusFailAge); ok && raw != "" {
		return nil
	}
	s.runJobFor("focus:"+u, time.Minute, func(ctx context.Context) {
		f, err := fetchFocus(ctx, u)
		if err != nil {
			slog.Debug("banner focus", "url", u, "err", err)
			s.cacheSet(focusKey(u)+":fail", "1")
			return
		}
		raw, _ := json.Marshal(f)
		s.cacheSet(focusKey(u), string(raw))
	})
	return nil
}

func anilistImage(u string) bool {
	p, err := url.Parse(u)
	return err == nil && p.Scheme == "https" && (p.Hostname() == "anilist.co" || strings.HasSuffix(p.Hostname(), ".anilist.co"))
}

// fetchFocus reads one banner. Only AniList's image host is fetched: the URL
// comes from AniList's answers, and this must not become a way to make the
// server load an arbitrary address.
func fetchFocus(ctx context.Context, u string) (bannerFocus, error) {
	if !anilistImage(u) {
		return bannerFocus{}, fmt.Errorf("not an AniList image")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return bannerFocus{}, err
	}
	res, err := focusClient.Do(req)
	if err != nil {
		return bannerFocus{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return bannerFocus{}, fmt.Errorf("status %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, focusMaxBytes+1))
	if err != nil {
		return bannerFocus{}, err
	}
	if len(raw) > focusMaxBytes {
		return bannerFocus{}, fmt.Errorf("too large")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width > focusMaxSide || cfg.Height > focusMaxSide || cfg.Width == 0 || cfg.Height == 0 {
		return bannerFocus{}, fmt.Errorf("not a picture we read")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return bannerFocus{}, err
	}
	return focusProfile(img), nil
}
