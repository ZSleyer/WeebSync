package api

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/nwaples/rardecode/v2"
)

// The reader opens a book - a comic archive (cbz/cbr), an EPUB, a spreadsheet
// (ods/xlsx, a zip of XML as well) - by unpacking it once into a temporary
// folder and serving the pieces from there. A comic page is then a plain image
// and an EPUB chapter a plain XHTML document whose relative links to its
// pictures and styles resolve by themselves.
//
// The pieces are served under an unguessable token instead of the session:
// EPUB chapters are someone else's markup and are shown in a sandboxed frame
// without an origin of its own, and such a frame does not send the session
// cookie with the requests for its pictures. The token is the permission - it
// is handed out only to a signed-in user who may read the source file, and
// dies with the unpacked copy.

// Limits of one unpacked book: generous for a 300-page colour volume, small
// enough that an archive bomb stops long before the disk does.
const (
	bookMaxBytes   = 2 << 30
	bookMaxEntries = 10000
	// a remote zip is copied down first (its index sits at the end); a
	// larger file is not a book
	bookMaxDownload = 2 << 30
	// unpacked books kept around; the oldest is deleted when one more opens
	bookShelfSize = 6
)

// readerExt maps what the reader can open to how it shows it.
var readerExt = map[string]string{
	".cbz": "comic", ".cbr": "comic", ".zip": "comic", ".rar": "comic",
	".epub": "epub",
	".ods":  "sheet", ".xlsx": "sheet",
}

// pageExt are the entries of a comic archive that are pages.
var pageExt = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".avif": true, ".bmp": true}

// book is one unpacked file.
type book struct {
	key   string // user, server and path it was opened from
	token string
	dir   string
	kind  string   // comic | epub | sheet
	pages []string // comic pages in reading order, paths inside dir
	used  time.Time
}

// bookShelf holds the unpacked books, by source and by token.
type bookShelf struct {
	mu      sync.Mutex
	byKey   map[string]*book
	byToken map[string]*book
	// one unpack per source at a time; a second request waits for it
	opening map[string]chan struct{}
}

// ReaderBook describes an opened book to the reader.
type ReaderBook struct {
	// Base is the URL prefix every entry is served under: Base + entry path.
	Base  string   `json:"base"`
	Kind  string   `json:"kind" example:"comic"` // comic | epub | sheet
	Pages []string `json:"pages,omitempty"`      // comic pages in order, relative to Base
}

// @Summary  Open a book
// @Description Unpacks a comic archive (cbz/cbr), EPUB or spreadsheet (ods/xlsx) from a local (server omitted or 0) or remote path and returns where its pieces are served. Comic pages come in reading order.
// @Tags     Reader
// @Produce  json
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "File path"
// @Success  200 {object} ReaderBook
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/read/open [get]
func (s *Server) handleReadOpen(w http.ResponseWriter, r *http.Request) {
	src, err := readSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	b, err := s.openBook(r.Context(), src)
	if err != nil {
		if errors.Is(err, errNotBook) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writePlayErr(w, src, err)
		return
	}
	writeJSON(w, http.StatusOK, ReaderBook{Base: "/api/read/b/" + b.token + "/", Kind: b.kind, Pages: b.pages})
}

// readSourceFrom is playSourceFrom for the files the reader opens.
func readSourceFrom(r *http.Request) (playSource, error) {
	src, err := fileSourceFrom(r)
	if err == nil && readerExt[strings.ToLower(filepath.Ext(src.path))] == "" {
		err = errNotBook
	}
	return src, err
}

var errNotBook = errors.New("not a book the reader can open")

// openBook returns the unpacked copy of src, unpacking it on first use.
func (s *Server) openBook(ctx context.Context, src playSource) (*book, error) {
	key := fmt.Sprintf("%d|%d|%s", src.userID, src.serverID, src.path)
	sh := &s.books
	for {
		sh.mu.Lock()
		if sh.byKey == nil {
			sh.byKey, sh.byToken, sh.opening = map[string]*book{}, map[string]*book{}, map[string]chan struct{}{}
		}
		if b := sh.byKey[key]; b != nil {
			b.used = time.Now()
			sh.mu.Unlock()
			return b, nil
		}
		wait, busy := sh.opening[key]
		if !busy {
			sh.opening[key] = make(chan struct{})
			sh.mu.Unlock()
			break
		}
		sh.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	b, err := s.unpackBook(ctx, src)
	sh.mu.Lock()
	close(sh.opening[key])
	delete(sh.opening, key)
	if err == nil {
		b.key = key
		sh.byKey[key], sh.byToken[b.token] = b, b
		s.evictBooksLocked()
	}
	sh.mu.Unlock()
	return b, err
}

// evictBooksLocked drops the least recently opened books beyond the shelf
// size. Caller holds books.mu.
func (s *Server) evictBooksLocked() {
	sh := &s.books
	for len(sh.byKey) > bookShelfSize {
		var old *book
		for _, b := range sh.byKey {
			if old == nil || b.used.Before(old.used) {
				old = b
			}
		}
		delete(sh.byKey, old.key)
		delete(sh.byToken, old.token)
		os.RemoveAll(old.dir)
	}
}

// bookCacheDir is where books are unpacked, cleared at startup.
func bookCacheDir() string { return filepath.Join(os.TempDir(), "weebsync-books") }

// ClearBookCache removes what an earlier run left unpacked: its tokens died
// with it.
func ClearBookCache() { os.RemoveAll(bookCacheDir()) }

func (s *Server) unpackBook(ctx context.Context, src playSource) (*book, error) {
	if err := os.MkdirAll(bookCacheDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := s.openBookFile(ctx, src)
	if err != nil {
		return nil, err
	}
	defer f.close()
	dir, err := os.MkdirTemp(bookCacheDir(), "b*")
	if err != nil {
		return nil, err
	}
	b := &book{dir: dir, kind: readerExt[strings.ToLower(filepath.Ext(src.path))], used: time.Now()}
	tok := make([]byte, 16)
	rand.Read(tok)
	b.token = hex.EncodeToString(tok)
	start := time.Now()
	if err := unpack(f, dir); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	if b.kind == "comic" {
		b.pages = comicPages(dir)
		if len(b.pages) == 0 {
			os.RemoveAll(dir)
			return nil, errors.New("no pages in the archive")
		}
	}
	slog.Debug("book unpacked", "server", src.serverID, "path", logSafe(src.path), "pages", len(b.pages), "took", time.Since(start).Round(time.Millisecond))
	return b, nil
}

// unpack writes the archive in f into dir. The format is read from the first
// bytes, not the name: plenty of .cbr files are zips and the odd .cbz a rar.
func unpack(f *playFile, dir string) error {
	head := make([]byte, 8)
	n, _ := io.ReadFull(f, head)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	w := &entryWriter{root: root}
	switch {
	case bytes.HasPrefix(head[:n], []byte("Rar!")):
		rr, err := rardecode.NewReader(f)
		if err != nil {
			return err
		}
		for {
			h, err := rr.Next()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return err
			}
			if h.IsDir {
				continue
			}
			if err := w.write(h.Name, rr); err != nil {
				return err
			}
		}
	case bytes.HasPrefix(head[:n], []byte("PK")):
		ra, ok := f.ReadSeeker.(io.ReaderAt)
		if !ok {
			return errors.New("zip needs random access") // openBookFile always gives it
		}
		zr, err := zip.NewReader(ra, f.size)
		if err != nil {
			return err
		}
		for _, e := range zr.File {
			if e.FileInfo().IsDir() {
				continue
			}
			rc, err := e.Open()
			if err != nil {
				return err
			}
			err = w.write(e.Name, rc)
			rc.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("not a zip or rar archive")
}

// openBookFile opens the archive to unpack. A local file is read in place. A
// remote one is copied down whole first, in one stream: a zip's index sits at
// the end and every jump over SFTP is a fresh open, and the RAR decoder reads
// in small pieces that cost a round trip each - a 17 MB volume took minutes
// that way. The plain copy lets the SFTP client keep many reads in flight.
func (s *Server) openBookFile(ctx context.Context, src playSource) (*playFile, error) {
	if src.serverID == 0 {
		return s.openPlay(ctx, src)
	}
	client, _, err := s.dialServer(ctx, src.userID, src.serverID, pool.PriHigh)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	size, err := client.Size(src.path)
	if err != nil {
		return nil, err
	}
	if size > bookMaxDownload {
		return nil, errors.New("archive too large")
	}
	rc, err := client.Open(src.path, 0)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	tmp, err := os.CreateTemp(bookCacheDir(), "dl*")
	if err != nil {
		return nil, err
	}
	gone := func() { tmp.Close(); os.Remove(tmp.Name()) }
	// io.Copy hands the copy to the remote file's WriteTo, which is where
	// the concurrent reads live; the size was checked above
	start := time.Now()
	if _, err := io.Copy(tmp, rc); err != nil {
		gone()
		return nil, err
	}
	slog.Debug("book fetched", "server", src.serverID, "bytes", size, "took", time.Since(start).Round(time.Millisecond))
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		gone()
		return nil, err
	}
	return &playFile{ReadSeeker: tmp, size: size, close: gone}, nil
}

// entryWriter writes archive entries below its root, within the book limits.
type entryWriter struct {
	root    *os.Root
	written int64
	entries int
}

func (w *entryWriter) write(name string, r io.Reader) error {
	// a name is only a hint: no absolute paths, no way up, no backslashes
	// read as anything but a separator. os.Root refuses escapes regardless.
	rel := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(name, `\`, "/")), "/")
	if rel == "" || rel == "." {
		return nil
	}
	if w.entries++; w.entries > bookMaxEntries {
		return errors.New("archive has too many entries")
	}
	if d := path.Dir(rel); d != "." {
		if err := w.root.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	out, err := w.root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(r, bookMaxBytes-w.written+1))
	out.Close()
	w.written += n
	if err != nil {
		return err
	}
	if w.written > bookMaxBytes {
		return errors.New("archive unpacks too large")
	}
	return nil
}

// comicPages lists the images of an unpacked comic in reading order: by path,
// numbers compared as numbers ("2.jpg" before "10.jpg"), the macOS resource
// folders and hidden files left out.
func comicPages(dir string) []string {
	var pages []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "__MACOSX/") || strings.HasPrefix(path.Base(rel), ".") {
			return nil
		}
		if pageExt[strings.ToLower(path.Ext(rel))] {
			pages = append(pages, rel)
		}
		return nil
	})
	slices.SortFunc(pages, naturalCompare)
	return pages
}

// naturalCompare orders strings with digit runs compared by value.
func naturalCompare(a, b string) int {
	for a != "" && b != "" {
		da, db := digitRun(a), digitRun(b)
		if da > 0 && db > 0 {
			na, _ := strconv.ParseUint(a[:da], 10, 64)
			nb, _ := strconv.ParseUint(b[:db], 10, 64)
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			a, b = a[da:], b[db:]
			continue
		}
		ca, cb := strings.ToLower(a[:1]), strings.ToLower(b[:1])
		if ca != cb {
			return strings.Compare(ca, cb)
		}
		a, b = a[1:], b[1:]
	}
	return len(a) - len(b)
}

func digitRun(s string) int {
	i := 0
	for i < len(s) && i < 18 && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i
}

// bookMime is the type an entry is served with. Anything not listed is
// served as bytes the browser will not interpret.
var bookMime = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
	".xhtml": "application/xhtml+xml", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css", ".xml": "application/xml", ".opf": "application/xml", ".ncx": "application/xml",
	".rels": "application/xml",
	".ttf":  "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
}

// @Summary  Read a piece of an opened book
// @Description Serves one file of a book opened with /api/read/open. The token in the path is the permission; the response is sandboxed, so markup inside a book never runs script.
// @Tags     Reader
// @Produce  octet-stream
// @Param    token path string true "Book token from /api/read/open"
// @Param    entry path string true "Path inside the book"
// @Success  200 {file} binary
// @Failure  404 {object} ErrorResponse
// @Router   /api/read/b/{token}/{entry} [get]
func (s *Server) handleReadEntry(w http.ResponseWriter, r *http.Request) {
	sh := &s.books
	sh.mu.Lock()
	b := sh.byToken[r.PathValue("token")]
	var dir string
	if b != nil {
		b.used = time.Now()
		dir = b.dir
	}
	sh.mu.Unlock()
	if b == nil {
		writeErr(w, http.StatusNotFound, "book not open")
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		writeErr(w, http.StatusNotFound, "book not open")
		return
	}
	defer root.Close()
	name := strings.TrimPrefix(path.Clean("/"+r.PathValue("entry")), "/")
	f, err := root.Open(name)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not in the book")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		writeErr(w, http.StatusNotFound, "not in the book")
		return
	}
	h := w.Header()
	ct := bookMime[strings.ToLower(path.Ext(name))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	// the book's own markup: no script, no origin, nothing from elsewhere -
	// and it may be framed by the reader, by nobody else
	h.Set("Content-Security-Policy", "sandbox; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'")
	h.Set("X-Frame-Options", "SAMEORIGIN")
	// the token changes with every unpack, so what it names never does
	h.Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}
