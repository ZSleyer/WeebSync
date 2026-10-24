package api

import (
	"bytes"
	"fmt"
	"net/url"
	"strconv"
)

// An EPUB chapter is shown in a frame without scripts and without an origin
// of its own, so the reader cannot reach into it to set the type. Instead the
// reader asks for the chapter with its look in the query (size, line height,
// background, typeface) and the server writes a small stylesheet into the
// chapter's head. The sandbox stays as it is; only the bytes change.

// readerLook is the reader's chosen look for a chapter. Every field is
// checked against a fixed set or range, so nothing from the query reaches
// the stylesheet as text.
type readerLook struct {
	size  int    // font size in px, 15..26
	lead  int    // line height in tenths, 13..19
	theme string // dark | sepia | light
	font  string // serif | sans
}

// readerThemes are the page and text colours of the reader's backgrounds.
var readerThemes = map[string][3]string{
	// background, text, links
	"dark":  {"#0b0b0d", "#e6ebf0", "#33c2b5"},
	"sepia": {"#f4ecd8", "#3b3024", "#0c7069"},
	"light": {"#fbfbf8", "#1a1a1a", "#0c7069"},
}

var readerFonts = map[string]string{
	"serif": `"Noto Serif", Georgia, "Times New Roman", serif`,
	"sans":  `system-ui, "Segoe UI", Roboto, sans-serif`,
}

// lookOf reads the look from a chapter request. ok is false when the request
// asks for none (the book's own styles stand) or names a value outside the
// allowed sets.
func lookOf(q url.Values) (readerLook, bool) {
	if q.Get("look") != "1" {
		return readerLook{}, false
	}
	l := readerLook{size: 19, lead: 16, theme: "dark", font: "serif"}
	if v := q.Get("size"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 15 || n > 26 {
			return readerLook{}, false
		}
		l.size = n
	}
	if v := q.Get("lead"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		n := int(f*10 + 0.5)
		if err != nil || n < 13 || n > 19 {
			return readerLook{}, false
		}
		l.lead = n
	}
	if v := q.Get("theme"); v != "" {
		if _, ok := readerThemes[v]; !ok {
			return readerLook{}, false
		}
		l.theme = v
	}
	if v := q.Get("font"); v != "" {
		if _, ok := readerFonts[v]; !ok {
			return readerLook{}, false
		}
		l.font = v
	}
	return l, true
}

// css is the stylesheet for the look. Plain characters only (no "<" or "&"),
// so it sits in an XHTML head without a CDATA section.
func (l readerLook) css() string {
	c := readerThemes[l.theme]
	return fmt.Sprintf(`html{background:%[1]s !important;color:%[2]s !important}`+
		`body{margin:0 auto !important;max-width:40em;padding:1.5em 1.5em 3em !important;`+
		`font-family:%[4]s !important;font-size:%[5]dpx !important;line-height:%[6]d.%[7]d !important;`+
		`background:transparent !important;color:inherit !important;hyphens:auto;overflow-wrap:break-word}`+
		`body *{color:inherit !important;background-color:transparent !important;line-height:inherit}`+
		`body a{color:%[3]s !important}`+
		`img,svg,video{max-width:100%% !important;height:auto !important}`,
		c[0], c[1], c[2], readerFonts[l.font], l.size, l.lead/10, l.lead%10)
}

// injectLook writes the look's stylesheet into a chapter: as the last thing
// in its head, so it wins over the book's own sheets, or in a new head when
// the chapter has none.
func injectLook(doc []byte, l readerLook) []byte {
	style := []byte(`<style id="weebsync-reader">` + l.css() + `</style>`)
	lower := asciiLower(doc)
	if i := bytes.Index(lower, []byte("</head")); i >= 0 {
		return splice(doc, i, style)
	}
	if i := tagEnd(lower, "<html"); i >= 0 {
		return splice(doc, i, append(append([]byte("<head>"), style...), "</head>"...))
	}
	return append(style, doc...)
}

// asciiLower lower-cases A-Z only, byte for byte: its offsets are the
// document's. bytes.ToLower maps whole code points, some of which change
// length (KELVIN SIGN, an invalid byte becoming U+FFFD).
func asciiLower(b []byte) []byte {
	out := make([]byte, len(b))
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return out
}

// tagEnd is the position after the ">" closing the first tag named open
// ("<html"), or -1.
func tagEnd(lower []byte, open string) int {
	for from := 0; ; {
		i := bytes.Index(lower[from:], []byte(open))
		if i < 0 {
			return -1
		}
		i += from
		// "<html" must not match "<htmlfoo"
		if j := i + len(open); j < len(lower) && (lower[j] == '>' || lower[j] == ' ' || lower[j] == '\t' || lower[j] == '\n' || lower[j] == '\r' || lower[j] == '/') {
			if k := bytes.IndexByte(lower[j:], '>'); k >= 0 {
				return j + k + 1
			}
			return -1
		}
		from = i + len(open)
	}
}

func splice(doc []byte, at int, in []byte) []byte {
	out := make([]byte, 0, len(doc)+len(in))
	out = append(out, doc[:at]...)
	out = append(out, in...)
	return append(out, doc[at:]...)
}

// maxLookChapter caps the chapters the look is written into: a chapter is
// read whole for it, and a book's chapter is a few hundred KB at most.
const maxLookChapter = 8 << 20
