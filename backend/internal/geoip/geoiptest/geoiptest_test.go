package geoiptest_test

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/geoip"
	"github.com/ch4d1/weebsync/internal/geoip/geoiptest"
)

func TestBuildReadsBack(t *testing.T) {
	built := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	p := filepath.Join(t.TempDir(), "t.mmdb")
	b := geoiptest.Build([]geoiptest.Net{
		{CIDR: "203.0.113.0/24", City: "Darmstadt", Country: "DE"},
		{CIDR: "2001:db8::/32", City: "Tokyo", Country: "JP"},
	}, geoiptest.Options{Built: built})
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := geoip.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.Type() != "DBIP-City-Lite" || !r.BuildTime().Equal(built) {
		t.Fatalf("metadata: %q %v", r.Type(), r.BuildTime())
	}
	for ip, want := range map[string]geoip.Place{
		"203.0.113.9":  {City: "Darmstadt", Country: "DE"},
		"2001:db8::1":  {City: "Tokyo", Country: "JP"},
		"198.51.100.1": {},
	} {
		got, err := r.Lookup(netip.MustParseAddr(ip))
		if err != nil || got != want {
			t.Errorf("%s: %v %v, want %v", ip, got, err, want)
		}
	}
}
