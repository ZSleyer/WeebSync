package main

import (
	"compress/gzip"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipMinSize is the smallest body (by Content-Length) worth compressing;
// below it the gzip framing eats most of the gain. Bodies of unknown length
// (most JSON) are compressed regardless.
const gzipMinSize = 1024

// compressibleTypes are the media types worth gzipping. Everything else -
// images, video, audio, fonts, archives and text/event-stream - passes
// through untouched: either it is compressed already or it streams.
var compressibleTypes = map[string]bool{
	"text/html":                 true,
	"text/css":                  true,
	"text/plain":                true,
	"text/javascript":           true,
	"text/xml":                  true,
	"application/javascript":    true,
	"application/json":          true,
	"application/manifest+json": true,
	"application/xml":           true,
	"application/rss+xml":       true,
	"image/svg+xml":             true,
	// the subtitle renderer's wasm shrinks to less than half
	"application/wasm": true,
}

// gzipSkipPrefixes are routes that hand out files or media: the player's
// streams, subtitles and fonts and the reader's book pieces are served with
// byte ranges and long-lived writes, and stay byte-exact.
var gzipSkipPrefixes = []string{"/api/play/", "/api/read/b/"}

var gzipPool = sync.Pool{New: func() any {
	gz, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
	return gz
}}

// acceptsGzip reports whether the request's Accept-Encoding allows gzip,
// honouring q=0 for gzip itself and for the * wildcard.
func acceptsGzip(r *http.Request) bool {
	gzipQ, starQ := -1.0, -1.0
	for _, v := range r.Header.Values("Accept-Encoding") {
		for part := range strings.SplitSeq(v, ",") {
			name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
			q := 1.0
			for p := range strings.SplitSeq(params, ";") {
				k, val, ok := strings.Cut(strings.TrimSpace(p), "=")
				if ok && strings.EqualFold(strings.TrimSpace(k), "q") {
					f, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
					if err != nil {
						f = 0
					}
					q = f
				}
			}
			switch strings.ToLower(strings.TrimSpace(name)) {
			case "gzip", "x-gzip":
				gzipQ = max(gzipQ, q)
			case "*":
				starQ = max(starQ, q)
			}
		}
	}
	if gzipQ >= 0 {
		return gzipQ > 0
	}
	return starQ > 0
}

// gzipHandler compresses compressible responses for clients that accept gzip.
// The decision is made when the header is written, from what the handler set
// by then: status, Content-Type, Content-Encoding, Content-Disposition and
// Content-Length. It sits inside harden, so the security headers are already
// on the response and survive unchanged.
func gzipHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead || r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		for _, p := range gzipSkipPrefixes {
			if strings.HasPrefix(r.URL.Path, p) {
				next.ServeHTTP(w, r)
				return
			}
		}
		gw := &gzipResponseWriter{ResponseWriter: w, accepts: acceptsGzip(r)}
		defer gw.finish()
		next.ServeHTTP(gw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	accepts     bool
	wroteHeader bool
	gz          *gzip.Writer // non-nil once the body is being compressed
}

func (g *gzipResponseWriter) WriteHeader(code int) {
	if g.wroteHeader {
		g.ResponseWriter.WriteHeader(code) // let net/http report the superfluous call
		return
	}
	g.wroteHeader = true
	h := g.Header()
	ct, _, _ := mime.ParseMediaType(h.Get("Content-Type"))
	eligible := compressibleTypes[ct]
	if eligible || code == http.StatusNotModified {
		// the cache key splits on Accept-Encoding even when identity is sent
		h.Add("Vary", "Accept-Encoding")
	}
	if code == http.StatusNotModified && g.accepts {
		// the client holds the gzip representation; keep its validator weak
		weakenETag(h)
	}
	if !g.accepts || !eligible || code < 200 || code >= 300 ||
		code == http.StatusNoContent || code == http.StatusPartialContent ||
		h.Get("Content-Encoding") != "" ||
		strings.HasPrefix(strings.ToLower(h.Get("Content-Disposition")), "attachment") {
		g.ResponseWriter.WriteHeader(code)
		return
	}
	if cl := h.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil && n < gzipMinSize {
			g.ResponseWriter.WriteHeader(code)
			return
		}
	}
	h.Del("Content-Length")
	// byte offsets into the file do not address the compressed body
	h.Del("Accept-Ranges")
	h.Set("Content-Encoding", "gzip")
	// a compressed and an identity body must not share a strong validator
	weakenETag(h)
	g.gz = gzipPool.Get().(*gzip.Writer)
	g.gz.Reset(g.ResponseWriter)
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		// what net/http would sniff, so the decision sees the same type
		if _, ok := g.Header()["Content-Type"]; !ok && len(p) > 0 {
			g.Header().Set("Content-Type", http.DetectContentType(p))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(p)
	}
	return g.ResponseWriter.Write(p)
}

// Flush pushes out what is buffered. A flush before any write commits the
// header as written so far; event streams are never compressed, so their
// events reach the client as they happen.
func (g *gzipResponseWriter) Flush() {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the connection (write
// deadlines, hijacking) through the wrapper.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipResponseWriter) finish() {
	if g.gz == nil {
		return
	}
	_ = g.gz.Close()
	g.gz.Reset(nil)
	gzipPool.Put(g.gz)
	g.gz = nil
}

func weakenETag(h http.Header) {
	if et := h.Get("ETag"); et != "" && !strings.HasPrefix(et, "W/") {
		h.Set("ETag", "W/"+et)
	}
}
