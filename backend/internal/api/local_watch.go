package api

import (
	"encoding/binary"
	"errors"
	"log/slog"
	"sync"

	"golang.org/x/sys/unix"
)

// dirWatcher tells the folder cache which directories changed, through one
// inotify instance: a file created, removed, renamed, written to the end or
// touched, a directory removed, or its file system unmounted. A watch covers
// one directory, not its subdirectories; a new subdirectory is a change of
// its parent, and the walk that follows adds its watch.
type dirWatcher struct {
	fd    int
	mu    sync.Mutex
	paths map[string]int // directory -> watch descriptor
	byWD  map[int]string
	full  bool // the kernel's watch limit was reached once (logged)
	dead  bool // reading events failed: nothing is watched any more
}

const dirEvents = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO |
	unix.IN_CLOSE_WRITE | unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF |
	// a directory only, and never through a link: os.Root confines the walk,
	// inotify_add_watch on its own would follow one
	unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW

// newDirWatcher starts watching; changed gets the directory an event happened
// in, or "" when events were lost and everything must be read again. nil
// when inotify is not available.
func newDirWatcher(changed func(dir string)) *dirWatcher {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		slog.Warn("local folder watch unavailable, folders are read again every few minutes", "err", err)
		return nil
	}
	w := &dirWatcher{fd: fd, paths: map[string]int{}, byWD: map[int]string{}}
	go w.run(changed)
	return w
}

// add watches dir; false when it cannot be watched, so its listing must not
// be trusted for long.
func (w *dirWatcher) add(dir string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.dead {
		return false
	}
	if _, ok := w.paths[dir]; ok {
		return true
	}
	wd, err := unix.InotifyAddWatch(w.fd, dir, dirEvents)
	if err != nil {
		if errors.Is(err, unix.ENOSPC) && !w.full {
			w.full = true
			slog.Warn("local folder watch limit reached, the rest are read again every few minutes",
				"hint", "raise fs.inotify.max_user_watches")
		}
		return false
	}
	w.paths[dir], w.byWD[wd] = wd, dir
	return true
}

func (w *dirWatcher) run(changed func(dir string)) {
	buf := make([]byte, 64<<10)
	for {
		n, err := unix.Read(w.fd, buf)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || n <= 0 {
			slog.Warn("local folder watch stopped, folders are read again every few minutes", "err", err)
			w.mu.Lock()
			w.dead = true
			w.mu.Unlock()
			changed("")
			return
		}
		// struct inotify_event: wd, mask, cookie, len, then len bytes of name
		for off := 0; off+unix.SizeofInotifyEvent <= n; {
			wd := int(int32(binary.NativeEndian.Uint32(buf[off:])))
			mask := binary.NativeEndian.Uint32(buf[off+4:])
			off += unix.SizeofInotifyEvent + int(binary.NativeEndian.Uint32(buf[off+12:]))
			if mask&unix.IN_Q_OVERFLOW != 0 {
				changed("")
				continue
			}
			w.mu.Lock()
			dir := w.byWD[wd]
			if mask&unix.IN_IGNORED != 0 { // removed, unmounted, or unwatched
				delete(w.byWD, wd)
				if w.paths[dir] == wd {
					delete(w.paths, dir)
				}
			}
			w.mu.Unlock()
			if dir != "" {
				changed(dir)
			}
		}
	}
}

// watchable reports whether inotify sees every change below dir. Network and
// FUSE file systems (NFS, SMB, mergerfs) report only what this machine did
// through that mount, not what another host or a branch disk changed.
func watchable(dir string) bool {
	var st unix.Statfs_t
	if unix.Statfs(dir, &st) != nil {
		return false
	}
	switch uint32(st.Type) {
	case 0x6969, // NFS
		0x517B,     // SMB
		0xFF534D42, // CIFS
		0xFE534D42, // SMB2
		0x65735546, // FUSE
		0x00C36400, // Ceph
		0x01021997: // 9p
		return false
	}
	return true
}
