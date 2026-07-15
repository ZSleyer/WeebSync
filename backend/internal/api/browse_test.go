package api

import (
	"strings"
	"testing"
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
