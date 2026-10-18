package api

import (
	"bytes"
	"crypto/hmac"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // TMDB and TVDB posters may be PNGs
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
)

// Android draws a notification's icon as a square. A portrait poster handed
// over as it is gets squeezed into that square, so the push carries a link to
// this endpoint instead: the poster cut square on the server.
const (
	pushCoverSide     = 256     // longest edge we send; smaller posters stay as they are
	pushCoverMaxBytes = 8 << 20 // largest poster we read
	pushCoverMaxSide  = 6000    // widest/tallest decoded poster
	pushCoverTopBias  = 0.3     // share of a portrait's spare height cut from the top; faces sit above the middle
	pushCoverAge      = 30 * 24 * time.Hour
	pushCoverJPEGQ    = 85
	pushCoverKeyPref  = "push-cover:v1:"
)

var (
	pushCoverHTTP = netguard.PublicClient(15 * time.Second)
	// decoding a poster costs tens of MB; a few at once is plenty
	pushCoverSlots = make(chan struct{}, 2)
)

func pushCoverSig(u string) string {
	mac, err := secret.MAC("push-cover|" + u)
	if err != nil {
		return ""
	}
	return hex.EncodeToString(mac)
}

// pushCoverURL turns a cover into the link the push carries: this server's
// square crop of it. The link is signed, so only covers the server itself put
// in a push can be fetched through it. Without an https origin (or a key) the
// plain cover goes out instead - squeezed, but there.
func (s *Server) pushCoverURL(cover string) string {
	base := s.baseURL()
	if cover == "" || !strings.HasPrefix(base, "https://") {
		return cover
	}
	sig := pushCoverSig(cover)
	if sig == "" {
		return cover
	}
	return base + "/api/push/cover?u=" + url.QueryEscape(cover) + "&sig=" + sig
}

// handlePushCover serves a poster cut square. No session: the system fetches
// notification icons without the app's cookies, so the signature stands in.
// @Summary      Square-cropped cover for a push notification
// @Description  Fetches the signed https poster URL, cuts the largest square out of it (upper part of a portrait) and serves it as a JPEG of at most 256 px. The signature is issued by the server inside the push payload.
// @Tags         Push
// @Produce      image/jpeg
// @Param        u    query  string  true  "Poster URL (https)"
// @Param        sig  query  string  true  "Signature of u"
// @Success      200  {file}  binary
// @Failure      404  {string}  string
// @Router       /api/push/cover [get]
func (s *Server) handlePushCover(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("u")
	want := pushCoverSig(u)
	got, err := hex.DecodeString(r.URL.Query().Get("sig"))
	if want == "" || err != nil || u == "" || len(u) > 2048 {
		http.NotFound(w, r)
		return
	}
	wantRaw, _ := hex.DecodeString(want)
	if !hmac.Equal(got, wantRaw) {
		http.NotFound(w, r)
		return
	}
	out, ok := s.pushCoverJPEG(u)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(out) //nolint:gosec // our own re-encoded JPEG, served as image/jpeg with nosniff
}

// pushCoverJPEG is the cropped poster, from the cache or fetched and cut.
func (s *Server) pushCoverJPEG(u string) ([]byte, bool) {
	key := pushCoverKeyPref + u
	if raw, ok := s.cacheGet(key, pushCoverAge); ok && raw != "" {
		if b, err := base64.StdEncoding.DecodeString(raw); err == nil {
			return b, true
		}
	}
	select {
	case pushCoverSlots <- struct{}{}:
		defer func() { <-pushCoverSlots }()
	case <-time.After(10 * time.Second):
		return nil, false
	}
	src, err := pushCoverFetch(u)
	if err != nil {
		slog.Debug("push cover", "err", err)
		return nil, false
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, cropSquare(src), &jpeg.Options{Quality: pushCoverJPEGQ}); err != nil {
		return nil, false
	}
	s.cacheSet(key, base64.StdEncoding.EncodeToString(buf.Bytes()))
	return buf.Bytes(), true
}

// pushCoverFetch is a variable so tests can serve a poster without the network.
var pushCoverFetch = fetchPushCover

func fetchPushCover(u string) (image.Image, error) {
	pu, err := url.Parse(u)
	if err != nil || pu.Scheme != "https" || pu.Hostname() == "" {
		return nil, fmt.Errorf("not an https URL")
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := pushCoverHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, pushCoverMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > pushCoverMaxBytes {
		return nil, fmt.Errorf("too large")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width == 0 || cfg.Height == 0 || cfg.Width > pushCoverMaxSide || cfg.Height > pushCoverMaxSide {
		return nil, fmt.Errorf("not a picture we read")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	return img, err
}

// cropSquare cuts the largest square out of img and scales it down to
// pushCoverSide. A portrait keeps its upper part (the top-biased window), a
// landscape its middle.
func cropSquare(img image.Image) *image.RGBA {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	side, x0, y0 := w, 0, 0
	if h < w {
		side, x0 = h, (w-h)/2
	} else {
		y0 = int(float64(h-w) * pushCoverTopBias)
	}
	out := pushCoverSide
	if side < out {
		out = side
	}
	dst := image.NewRGBA(image.Rect(0, 0, out, out))
	// box filter: every output pixel averages the source pixels it covers
	for y := 0; y < out; y++ {
		sy0, sy1 := y*side/out, (y+1)*side/out
		for x := 0; x < out; x++ {
			sx0, sx1 := x*side/out, (x+1)*side/out
			var r, g, bl, n uint64
			for sy := sy0; sy < sy1 || sy == sy0; sy++ {
				for sx := sx0; sx < sx1 || sx == sx0; sx++ {
					cr, cg, cb, _ := img.At(b.Min.X+x0+sx, b.Min.Y+y0+sy).RGBA()
					r, g, bl, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), n+1
				}
			}
			dst.SetRGBA(x, y, color.RGBA{uint8(r / n >> 8), uint8(g / n >> 8), uint8(bl / n >> 8), 255})
		}
	}
	return dst
}
