package api

import (
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

func TestSafeLocalNeverEscapesRoot(t *testing.T) {
	s := &Server{DownloadRoot: "/data/downloads"}
	for _, in := range []string{"", ".", "a/b", "../../etc/passwd", "/abs/path", "a/../..", "..", "foo/../../etc"} {
		p, err := s.safeLocal(in)
		if err != nil {
			continue // rejected is fine
		}
		if p != "/data/downloads" && !strings.HasPrefix(p, "/data/downloads/") {
			t.Errorf("safeLocal(%q) escaped root: %q", in, p)
		}
	}
}

func TestVirtualEntries(t *testing.T) {
	roots := []string{
		"/media/haibara/plex/animeseries",
		"/media/haibara/plex/animemovies",
		"/media/shiho/plex/animeseries",
		"/media/shinichi/plex/tvseries",
	}
	names := func(es []remote.Entry) []string {
		out := make([]string, len(es))
		for i, e := range es {
			out[i] = e.Name
		}
		return out
	}
	// top level: single "media" group is skipped, one entry per disk,
	// single-child chains compressed to <disk>/plex
	es, ok := virtualEntries(roots, "")
	if !ok || len(es) != 3 {
		t.Fatalf("top: %v %v", names(es), ok)
	}
	if es[0].Name != "haibara/plex" || es[0].Path != "/media/haibara/plex" ||
		es[1].Name != "shiho/plex/animeseries" || es[2].Name != "shinichi/plex/tvseries" {
		t.Errorf("top entries: %+v", es)
	}
	// below a shared parent: the real mounts appear
	es, ok = virtualEntries(roots, "/media/haibara/plex")
	if !ok || len(es) != 2 || es[0].Name != "animemovies" || es[1].Name != "animeseries" {
		t.Fatalf("disk level: %v %v", names(es), ok)
	}
	// a real root and anything below it is NOT virtual
	if _, ok := virtualEntries(roots, "/media/haibara/plex/animeseries"); ok {
		t.Error("root itself must browse the filesystem")
	}
	if _, ok := virtualEntries(roots, "/media/haibara/plex/animeseries/Show"); ok {
		t.Error("path inside a root must browse the filesystem")
	}
	// unrelated path: not virtual (falls through to safeLocal)
	if _, ok := virtualEntries(roots, "/somewhere/else"); ok {
		t.Error("unrelated path must not be virtual")
	}
	// breadcrumb-style path without leading slash
	es, ok = virtualEntries(roots, "media/haibara/plex")
	if !ok || len(es) != 2 {
		t.Errorf("relative crumb path: %v %v", names(es), ok)
	}
	// extra top-level root stays its own entry, media group intact
	es, ok = virtualEntries(append(roots, "/downloads"), "")
	if !ok || len(es) != 2 || es[0].Name != "downloads" || es[1].Name != "media" {
		t.Fatalf("mixed top: %v %v", names(es), ok)
	}
	// one root being the parent of another: parent stays a browseable entry
	es, ok = virtualEntries([]string{"/a/b", "/a/b/c", "/x/y"}, "")
	if !ok || len(es) != 2 || es[0].Name != "a/b" || es[0].Path != "/a/b" {
		t.Fatalf("nested roots: %+v %v", es, ok)
	}
}
