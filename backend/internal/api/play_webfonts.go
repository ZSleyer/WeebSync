package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
)

// Fonts a subtitle script names but its file does not carry come from Google
// Fonts, through the server: the page's CSP keeps the browser on its own
// origin, and the server's font cache serves every later episode. Without
// them libass draws those lines in its one default font, whose widths are not
// the ones the typesetter placed and clipped the text for.
var (
	webFontMetaURL    = "https://fonts.google.com/metadata/fonts"
	webFontCSSURL     = "https://fonts.googleapis.com/css2"
	webFontFilePrefix = "https://fonts.gstatic.com/"
)

// webFontAlias maps the Windows families scripts name most to free fonts with
// the same metrics: same widths, so lines break and fit where they were
// timed to. Arial needs none - the default font is Liberation Sans.
var webFontAlias = map[string]string{
	"calibri":         "Carlito",
	"cambria":         "Caladea",
	"times new roman": "Tinos",
	"courier new":     "Cousine",
	"georgia":         "Gelasio",
}

// webFamily is one Google Fonts family and its upright weights.
type webFamily struct {
	name    string
	weights []int
}

// webFontList is Google's family list, read once and refreshed daily; a
// failed read is retried after a few minutes, not on every request.
type webFontList struct {
	mu     sync.Mutex
	next   time.Time
	byName map[string]webFamily // lower-case family
	// fetching closes when the read under way is done; nil when none is
	fetching chan struct{}
}

// get is the list, read first when it is due. The read is one for all
// callers and runs as the server's background work: a caller that goes away
// stops waiting, the read goes on for the next one.
func (l *webFontList) get(ctx context.Context, s *Server) map[string]webFamily {
	l.mu.Lock()
	if time.Now().Before(l.next) {
		defer l.mu.Unlock()
		return l.byName
	}
	done := l.fetching
	if done == nil {
		done = make(chan struct{})
		l.fetching = done
		s.spawn(func() { l.fetch(s.lifetimeCtx(), done) })
	}
	if l.byName != nil { // served as it is while the refresh runs
		defer l.mu.Unlock()
		return l.byName
	}
	l.mu.Unlock()
	select {
	case <-done:
	case <-ctx.Done():
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.byName
}

// fetch reads the list for everyone waiting on done, within a minute and
// the server's lifetime, never a caller's.
func (l *webFontList) fetch(ctx context.Context, done chan struct{}) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	m, err := fetchWebFontList(ctx)
	l.mu.Lock()
	if err != nil {
		slog.Warn("web font list", "err", err)
		l.next = time.Now().Add(10 * time.Minute)
	} else {
		l.byName, l.next = m, time.Now().Add(24*time.Hour)
	}
	l.fetching = nil
	l.mu.Unlock()
	close(done)
}

func fetchWebFontList(ctx context.Context) (map[string]webFamily, error) {
	b, err := webFontGet(ctx, webFontMetaURL, 32<<20)
	if err != nil {
		return nil, err
	}
	var meta struct {
		FamilyMetadataList []struct {
			Family string
			Fonts  map[string]json.RawMessage // "400", "700i", ...
		}
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, err
	}
	m := make(map[string]webFamily, len(meta.FamilyMetadataList))
	for _, f := range meta.FamilyMetadataList {
		var ws []int
		for k := range f.Fonts {
			if w, err := strconv.Atoi(k); err == nil {
				ws = append(ws, w)
			}
		}
		if len(ws) > 0 {
			slices.Sort(ws)
			m[strings.ToLower(f.Family)] = webFamily{f.Family, ws}
		}
	}
	return m, nil
}

// weight picks the family's weight closest to w, the lighter one on a tie.
func (f webFamily) weight(w int) int {
	best := f.weights[0]
	for _, x := range f.weights {
		if abs(x-w) < abs(best-w) {
			best = x
		}
	}
	return best
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// WebFont is the web font standing in for a family a script names. Family is
// the name inside the font file - libass matches by it, so a script naming a
// metric twin's original has to name the twin instead.
type WebFont struct {
	Family  string `json:"family"`
	Regular string `json:"regular"`
	Bold    string `json:"bold"`
}

// @Summary  Web fonts for missing families
// @Description Resolves font families a subtitle script names but the video does not carry to free web fonts (Google Fonts, metric-compatible stand-ins for common Windows fonts), keyed by the lower-case family asked for. Families without a match are left out.
// @Tags     Player
// @Produce  json
// @Param    family query []string true "Font family, repeated" collectionFormat(multi)
// @Success  200 {object} map[string]WebFont
// @Security CookieAuth
// @Router   /api/play/webfonts [get]
func (s *Server) handlePlayWebFonts(w http.ResponseWriter, r *http.Request) {
	fams := r.URL.Query()["family"]
	if len(fams) > 64 {
		fams = fams[:64]
	}
	out := map[string]WebFont{}
	var list map[string]webFamily
	for _, f := range fams {
		f = strings.ToLower(strings.TrimSpace(f))
		if f == "" {
			continue
		}
		if list == nil {
			list = s.webFonts.get(r.Context(), s)
		}
		name := f
		if a, ok := webFontAlias[f]; ok {
			name = strings.ToLower(a)
		}
		fam, ok := list[name]
		if !ok {
			continue
		}
		link := func(weight int) string {
			return "/api/play/webfont?" + url.Values{"family": {fam.name}, "weight": {strconv.Itoa(fam.weight(weight))}}.Encode()
		}
		out[f] = WebFont{fam.name, link(400), link(700)}
	}
	writeJSON(w, http.StatusOK, out)
}

// cssFontURL is the font file in a css2 answer: one @font-face for one weight.
var cssFontURL = regexp.MustCompile(`src:\s*url\(([^)]+)\)`)

// @Summary  Web font file
// @Description Returns one weight of a Google Fonts family as TrueType, for rendering ASS subtitles. Only families and weights Google lists are fetched.
// @Tags     Player
// @Produce  octet-stream
// @Param    family query string true "Google Fonts family"
// @Param    weight query int    true "Weight the family has"
// @Success  200 {file} binary
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/webfont [get]
func (s *Server) handlePlayWebFont(w http.ResponseWriter, r *http.Request) {
	fam, ok := s.webFonts.get(r.Context(), s)[strings.ToLower(r.URL.Query().Get("family"))]
	weight, err := strconv.Atoi(r.URL.Query().Get("weight"))
	if !ok || err != nil || !slices.Contains(fam.weights, weight) {
		writeErr(w, http.StatusNotFound, "no such web font")
		return
	}
	key := "web-" + strings.ReplaceAll(strings.ToLower(fam.name), " ", "_") + "-" + strconv.Itoa(weight)
	b := s.fonts.cache.get(key)
	if b == nil {
		if b, err = fetchWebFont(r.Context(), fam.name, weight); err != nil {
			slog.Warn("web font", "family", logSafe(fam.name), "err", err)
			writeErr(w, http.StatusBadGateway, "the web font could not be loaded")
			return
		}
		s.fonts.cache.put(key, b)
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(b)
}

func fetchWebFont(ctx context.Context, family string, weight int) ([]byte, error) {
	css, err := webFontGet(ctx, webFontCSSURL+"?"+url.Values{"family": {family + ":wght@" + strconv.Itoa(weight)}}.Encode(), 1<<20)
	if err != nil {
		return nil, err
	}
	m := cssFontURL.FindSubmatch(css)
	if m == nil || !strings.HasPrefix(string(m[1]), webFontFilePrefix) {
		return nil, errWebFont("no font file in the css answer")
	}
	b, err := webFontGet(ctx, string(m[1]), maxFontSize)
	if err != nil {
		return nil, err
	}
	// TrueType, OpenType or a TrueType collection, nothing else reaches libass
	if len(b) < 4 || !slices.ContainsFunc([][]byte{{0, 1, 0, 0}, []byte("OTTO"), []byte("true"), []byte("ttcf")}, func(p []byte) bool { return bytes.HasPrefix(b, p) }) {
		return nil, errWebFont("not a font file")
	}
	return b, nil
}

type errWebFont string

func (e errWebFont) Error() string { return string(e) }

func webFontGet(ctx context.Context, u string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	// css2 picks the font format by user agent: a non-browser one gets TrueType,
	// which libass reads without a WOFF2 decoder
	req.Header.Set("User-Agent", "weebsync")
	resp, err := netguard.Client(30 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errWebFont(resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}
