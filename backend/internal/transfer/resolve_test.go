package transfer

import (
	"path/filepath"
	"strings"
	"testing"
)

func under(roots []string, abs string) bool {
	for _, r := range roots {
		r = filepath.Clean(r)
		if abs == r || strings.HasPrefix(abs, r+"/") {
			return true
		}
	}
	return false
}

func TestResolveLocal(t *testing.T) {
	multi := []string{"/media", "/config"}
	cases := []struct {
		roots []string
		in    string
		want  string
	}{
		{multi, "/media/anime/ep01.mkv", "/media/anime/ep01.mkv"},                   // absolute under a root
		{multi, "media/anime", "/media/anime"},                                      // rootless -> cleaned absolute matches
		{multi, "/config/x", "/config/x"},                                           // second root
		{[]string{"/data/downloads"}, "Show/ep.mkv", "/data/downloads/Show/ep.mkv"}, // legacy relative
		{[]string{"/data/downloads"}, "/data/downloads/x", "/data/downloads/x"},     // absolute under single root
	}
	for _, c := range cases {
		got, err := ResolveLocal(c.roots, c.in)
		if err != nil || got != c.want {
			t.Errorf("ResolveLocal(%v, %q) = %q, %v; want %q", c.roots, c.in, got, err, c.want)
		}
	}

	// security: no input may resolve outside the allowed roots
	for _, in := range []string{"/etc/passwd", "../../etc/shadow", "/media/../../etc", "..", "/"} {
		got, err := ResolveLocal(multi, in)
		if err == nil && !under(multi, got) {
			t.Errorf("escape: ResolveLocal(%v, %q) = %q (outside roots)", multi, in, got)
		}
	}

	if _, err := ResolveLocal(nil, "x"); err == nil {
		t.Error("no roots must error")
	}
}
