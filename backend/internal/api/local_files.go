package api

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// localFile is a file below a cached local folder.
type localFile struct {
	sub, name   string // the path below the folder, and the name alone
	size, mtime int64  // bytes, Unix seconds
}

// localCache keeps the files of the local folders the background jobs look at
// - auto-sync targets every minute, the Auto-Sync page every 10 s, the Plex and
// quality scans every hour - as one walk found them. A folder inotify watches
// is read again only after a change in it, and every localWatchedTTL as a net
// for a missed event: a disk that sleeps stays asleep. On a network or FUSE
// file system, or past the watch limit, it is read every localUnwatchedTTL.
type localCache struct {
	mu    sync.Mutex
	gen   uint64 // bumped by every change, so a walk that raced one is not kept
	all   map[string]*localListing
	once  sync.Once
	watch *dirWatcher // nil without inotify
}

type localListing struct {
	at      time.Time
	abs     string
	watched bool
	files   []localFile
}

const (
	localWatchedTTL   = 6 * time.Hour
	localUnwatchedTTL = 5 * time.Minute
	// folders kept; past it the oldest listing goes. A Plex library is one per
	// season, so this has to be well above that
	localCacheMax = 8192
)

// localFiles lists the files under rel (the trash left out), from the cache
// when it is fresh. An empty listing is never kept - it costs nothing to
// redo, and it is what a disk that is not mounted yet looks like: the next
// look must see the files the moment they are back.
func (s *Server) localFiles(rel string) []localFile {
	c := &s.localCache
	c.once.Do(func() { c.watch = newDirWatcher(c.changed) })
	c.mu.Lock()
	l, ok := c.all[rel]
	gen := c.gen
	c.mu.Unlock()
	if ok {
		ttl := localUnwatchedTTL
		if l.watched {
			ttl = localWatchedTTL
		}
		if time.Since(l.at) < ttl {
			return l.files
		}
	}
	local, err := s.openLocal(rel)
	if err != nil {
		return nil
	}
	defer local.Close()
	// the walk goes through the os.Root, so a link leading out of the allowed
	// roots is a dead end rather than a door; Abs is only ever watched
	watched := c.watch != nil && watchable(local.Abs)
	var files []localFile
	start := filepath.ToSlash(local.Name)
	fs.WalkDir(local.Root.FS(), start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		sub, _ := filepath.Rel(start, p)
		if d.IsDir() {
			if err := skipTrash(d); err != nil {
				return err
			}
			// watched before it is read, so a change from here on is an event
			if watched && !c.watch.add(filepath.Join(local.Abs, sub)) {
				watched = false
			}
			return nil
		}
		f := localFile{sub: sub, name: d.Name()}
		if fi, err := d.Info(); err == nil {
			f.size, f.mtime = fi.Size(), fi.ModTime().Unix()
		}
		files = append(files, f)
		return nil
	})
	if len(files) == 0 {
		return files
	}
	c.mu.Lock()
	if c.gen == gen {
		if c.all == nil {
			c.all = map[string]*localListing{}
		}
		if len(c.all) >= localCacheMax {
			var oldest string
			for k, v := range c.all {
				if oldest == "" || v.at.Before(c.all[oldest].at) {
					oldest = k
				}
			}
			delete(c.all, oldest)
		}
		c.all[rel] = &localListing{at: time.Now(), abs: local.Abs, watched: watched, files: files}
	}
	c.mu.Unlock()
	return files
}

// changed drops the listings that cover dir, every listing for "".
func (c *localCache) changed(dir string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	if dir == "" {
		c.all = nil
		return
	}
	for rel, l := range c.all {
		if dir == l.abs || strings.HasPrefix(dir, l.abs+string(filepath.Separator)) {
			delete(c.all, rel)
		}
	}
}

// forgetUnwatched drops the listings no watch keeps current: weebsync knows it
// changed files, inotify does not tell it for those folders.
func (s *Server) forgetUnwatched() {
	c := &s.localCache
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	for rel, l := range c.all {
		if !l.watched {
			delete(c.all, rel)
		}
	}
}

// ForgetLocalOnWrite drops the unwatched listings after every request that
// may have changed files - a rename, a delete, the trash, a replacement: they
// are rare, and listing every such route would miss the next one.
func (s *Server) ForgetLocalOnWrite(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			s.forgetUnwatched()
		}
	})
}
