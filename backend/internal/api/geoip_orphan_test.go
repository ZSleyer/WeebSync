package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/geoip/geoiptest"
)

func geoipOrphan(t *testing.T, s *Server, name string) {
	t.Helper()
	if err := os.MkdirAll(s.geoipDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.geoipDir(), name), []byte("half a database"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A download killed mid-way (power loss, OOM) leaves its .part file behind;
// the next download sweeps it away.
func TestGeoipDownloadSweepsOrphanedPartFiles(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){
		geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{})),
	})
	s := geoipServer(t, host.URL)
	geoipOrphan(t, s, "dbip-123456.part")
	geoipOrphan(t, s, "dbip-654321.part")
	s.updateGeoip(context.Background(), true)
	if s.geoipReader() == nil {
		t.Fatal("setup: no database")
	}
	if got := geoipDirFiles(t, s); len(got) != 1 || got[0] != geoipFile {
		t.Errorf("geoip dir = %v, want only %s", got, geoipFile)
	}
}

// Switching the feature off leaves nothing on disk, partial files included.
func TestGeoipDropSweepsOrphanedPartFiles(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){})
	s := geoipServer(t, host.URL)
	geoipOrphan(t, s, "dbip-123456.part")
	s.dropGeoip()
	if got := geoipDirFiles(t, s); len(got) != 0 {
		t.Errorf("after drop: %v left behind", got)
	}
}
