package api

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/mkvsubs"
)

// PlayFont is a font the video carries. Names are what the subtitle renderer
// may ask for it by; a font without them is loaded up front.
type PlayFont struct {
	Index int      `json:"index"`
	Names []string `json:"names,omitempty"`
}

// mkvFonts are the font attachments of one Matroska file and where their
// bytes lie. Group releases carry tens of megabytes of them in the header:
// over a slow remote that is half a minute before ffprobe or a transcode has
// even seen a track.
type mkvFonts struct {
	size  int64
	files []fontFile
}

type fontFile struct {
	mkvsubs.Attachment
	mkvsubs.Font
}

type fontIndex struct {
	mu    sync.Mutex
	all   map[playSource]*mkvFonts
	cache fontCache
}

// maxFontSize bounds one font read into memory; a CJK family is ~25 MB.
const maxFontSize = 64 << 20

// mkvFontsFor finds the fonts of a Matroska source, once per file: a size
// that no longer matches (size >= 0) means the file was replaced. nil for
// another container or a file that could not be walked.
func (s *Server) mkvFontsFor(ctx context.Context, src playSource, size int64) *mkvFonts {
	if !strings.EqualFold(filepath.Ext(src.path), ".mkv") {
		return nil
	}
	src.low = false
	h := &s.fonts
	h.mu.Lock()
	mf, ok := h.all[src]
	h.mu.Unlock()
	if ok && mf != nil && (size < 0 || mf.size == size) {
		return mf
	}
	mf = s.readMKVFonts(ctx, src)
	if mf == nil {
		// a failed read (a dropped connection, a cancelled request) is not
		// the file's answer: the next call tries again
		return nil
	}
	h.mu.Lock()
	if h.all == nil || len(h.all) >= 256 {
		h.all = map[playSource]*mkvFonts{}
	}
	h.all[src] = mf
	h.mu.Unlock()
	return mf
}

func (s *Server) readMKVFonts(ctx context.Context, src playSource) *mkvFonts {
	ra, size, done, err := s.readerAt(ctx, src)
	if err != nil {
		return nil
	}
	defer done()
	atts, err := mkvsubs.Attachments(ra, size)
	if err != nil {
		return nil
	}
	mf := &mkvFonts{size: size}
	for _, a := range atts {
		if isFont(a.Mime, a.Name) && a.Off+a.Len <= size {
			mf.files = append(mf.files, fontFile{Attachment: a})
		}
	}
	// a few small reads per font for its names, side by side
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i := range mf.files {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			f := &mf.files[i]
			f.Font = mkvsubs.ReadFont(io.NewSectionReader(ra, f.Off, f.Len))
		}()
	}
	wg.Wait()
	// a family the file has no regular face of answers to its plain name with
	// the first face it has, as libass picks among the fonts it holds
	taken := map[string]bool{}
	for _, f := range mf.files {
		for _, n := range f.Names {
			taken[n] = true
		}
	}
	for i := range mf.files {
		for _, fam := range mf.files[i].Families {
			if !taken[fam] {
				taken[fam] = true
				mf.files[i].Names = append(mf.files[i].Names, fam)
			}
		}
	}
	return mf
}

// holes are the font bytes an ffmpeg run over the source never needs.
func (mf *mkvFonts) holes() []mkvsubs.Attachment {
	if mf == nil {
		return nil
	}
	out := make([]mkvsubs.Attachment, len(mf.files))
	for i, f := range mf.files {
		out[i] = f.Attachment
	}
	return out
}

// holeReader reads as the file it wraps, but answers the bytes inside its
// holes (sorted, apart) with zeros instead of fetching them: ffmpeg parses a
// font attachment's header, its data it only copies, and the zeros keep every
// offset in the file where it was.
type holeReader struct {
	rs    io.ReadSeeker
	holes []mkvsubs.Attachment
	pos   int64
	moved bool // rs is not at pos
}

func (h *holeReader) Read(p []byte) (int, error) {
	for _, hole := range h.holes {
		end := hole.Off + hole.Len
		if h.pos >= hole.Off && h.pos < end {
			n := min(int64(len(p)), end-h.pos)
			clear(p[:n])
			h.pos += n
			h.moved = true
			return int(n), nil
		}
		if hole.Off > h.pos {
			p = p[:min(int64(len(p)), hole.Off-h.pos)]
			break
		}
	}
	if h.moved {
		if _, err := h.rs.Seek(h.pos, io.SeekStart); err != nil {
			return 0, err
		}
		h.moved = false
	}
	n, err := h.rs.Read(p)
	h.pos += int64(n)
	return n, err
}

func (h *holeReader) Seek(offset int64, whence int) (int64, error) {
	pos, err := h.rs.Seek(offset, whence)
	if err == nil {
		h.pos, h.moved = pos, false
	}
	return pos, err
}

// fontLoad is one font being read out of the file for a job.
type fontLoad struct {
	done chan struct{}
	err  error // written before done closes
}

// loadFont reads the font at stream index n once per job; a failed read is
// forgotten, so the next request tries again.
func (s *Server) loadFont(j *mediaJob, n int, a fontFile) *fontLoad {
	j.mu.Lock()
	defer j.mu.Unlock()
	if l := j.fonts[n]; l != nil {
		return l
	}
	l := &fontLoad{done: make(chan struct{})}
	if j.fonts == nil {
		j.fonts = map[int]*fontLoad{}
	}
	j.fonts[n] = l
	go func() {
		defer close(l.done)
		if l.err = s.writeFont(j, n, a); l.err != nil {
			j.mu.Lock()
			delete(j.fonts, n)
			j.mu.Unlock()
		}
	}()
	return l
}

func (s *Server) writeFont(j *mediaJob, n int, a fontFile) error {
	if a.Len > maxFontSize {
		return errors.New("font too large")
	}
	name := filepath.Join(j.dir, strconv.Itoa(n)+".font")
	key := ""
	if a.Sum != "" {
		key = a.Sum + "-" + strconv.FormatInt(a.Len, 10)
		if b := s.fonts.cache.get(key); int64(len(b)) == a.Len {
			return os.WriteFile(name, b, 0o600)
		}
	}
	ra, _, done, err := s.readerAt(j.ctx, j.src)
	if err != nil {
		return err
	}
	defer done()
	b := make([]byte, a.Len)
	if k, err := ra.ReadAt(b, a.Off); k < len(b) {
		return err
	}
	if key != "" {
		s.fonts.cache.put(key, b)
	}
	return os.WriteFile(name, b, 0o600)
}

// fontCache keeps fonts across files: the episodes of a release carry the
// same ones, and over a slow remote each is seconds to read. It lives in the
// temp dir - a restart empties it, a backup of the data never carries it -
// and that is a tmpfs in the compose file, memory: only the fonts a script
// asked for land here, so a release costs a few MB.
type fontCache struct {
	mu sync.Mutex
}

var fontCacheMax int64 = 128 << 20

func fontCacheDir() string { return filepath.Join(os.TempDir(), "weebsync-fonts") }

// get gives the font under key, nil when there is none; a hit counts as use.
func (c *fontCache) get(key string) []byte {
	p := filepath.Join(fontCacheDir(), key)
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	now := time.Now()
	os.Chtimes(p, now, now)
	return b
}

// put stores a font and drops the least recently used ones past the limit.
func (c *fontCache) put(key string, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	dir := fontCacheDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, ".part*")
	if err != nil {
		return
	}
	_, err = tmp.Write(b)
	tmp.Close()
	if err != nil || os.Rename(tmp.Name(), filepath.Join(dir, key)) != nil {
		os.Remove(tmp.Name())
		return
	}
	entries, _ := os.ReadDir(dir)
	type entry struct {
		name string
		size int64
		used time.Time
	}
	var all []entry
	var total int64
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && fi.Mode().IsRegular() {
			all = append(all, entry{e.Name(), fi.Size(), fi.ModTime()})
			total += fi.Size()
		}
	}
	slices.SortFunc(all, func(a, b entry) int { return a.used.Compare(b.used) })
	for _, e := range all {
		if total <= fontCacheMax {
			break
		}
		if os.Remove(filepath.Join(dir, e.name)) == nil {
			total -= e.size
		}
	}
}
