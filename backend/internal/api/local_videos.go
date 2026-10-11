package api

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// localVideo is a video file under a watched folder: its path below the folder,
// its name and its size.
type localVideo struct {
	sub, name string
	size      int64
}

// localVideoCache keeps the video files of each watched folder as the last
// walk found them. The auto-sync loop counts every watch's folder each minute
// and the Auto-Sync page every 10 s, each a recursive walk of a library
// folder: on spun-down or network disks that kept them busy around the clock.
// A finished download and any write request empty it, so what the user just
// changed shows at once; anything else is seen within localVideoTTL.
type localVideoCache struct {
	mu  sync.Mutex
	gen uint64 // bumped by every forget, so a walk that raced one is not kept
	all map[string]localVideoList
}

type localVideoList struct {
	at    time.Time
	files []localVideo
}

const localVideoTTL = 5 * time.Minute

// localVideos lists the video files under rel, from the cache when it is
// fresh. An empty listing is never kept - it costs nothing to redo, and it is
// what a disk that is not mounted yet looks like: the next look must see the
// files the moment they are back.
func (s *Server) localVideos(rel string) []localVideo {
	c := &s.localVids
	c.mu.Lock()
	l, ok := c.all[rel]
	gen := c.gen
	c.mu.Unlock()
	if ok && time.Since(l.at) < localVideoTTL {
		return l.files
	}
	var files []localVideo
	err := s.walkLocal(rel, func(sub string, d fs.DirEntry) error {
		if !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		var size int64
		if fi, err := d.Info(); err == nil {
			size = fi.Size()
		}
		files = append(files, localVideo{sub: sub, name: d.Name(), size: size})
		return nil
	})
	if err != nil || len(files) == 0 {
		return files
	}
	c.mu.Lock()
	if c.gen == gen {
		if c.all == nil || len(c.all) >= 1024 {
			c.all = map[string]localVideoList{}
		}
		c.all[rel] = localVideoList{at: time.Now(), files: files}
	}
	c.mu.Unlock()
	return files
}

// forgetLocalVideos drops every cached listing.
func (s *Server) forgetLocalVideos() {
	c := &s.localVids
	c.mu.Lock()
	c.gen++
	c.all = nil
	c.mu.Unlock()
}

// ForgetLocalOnWrite empties the folder cache after every request that may
// have changed files - a rename, a delete, the trash, a replacement: they are
// rare, and listing every such route would miss the next one.
func (s *Server) ForgetLocalOnWrite(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			s.forgetLocalVideos()
		}
	})
}
