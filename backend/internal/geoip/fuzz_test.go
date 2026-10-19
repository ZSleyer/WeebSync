package geoip

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// The database is downloaded from a third party and read on request paths,
// so no file may panic or hang the reader. Run with e.g.
// `go test -run=^$ -fuzz=FuzzOpenLookup -fuzztime=30s ./internal/geoip/`;
// the seeds alone run with the normal tests.
func FuzzOpenLookup(f *testing.F) {
	for _, size := range []int{24, 28, 32} {
		ds, nets := fixtureWith(3000)
		f.Add(dbSpec{recSize: size, nets: nets, data: ds}.build())
	}
	ds, nets := fixtureWith(3000)
	f.Add(dbSpec{ipv: 4, nets: nets[:1], data: ds}.build())

	addrs := []netip.Addr{
		netip.MustParseAddr("81.2.69.142"),
		netip.MustParseAddr("10.1.2.3"),
		netip.MustParseAddr("2001:db8::1"),
		netip.MustParseAddr("::ffff:11.1.1.1"),
		netip.MustParseAddr("255.255.255.255"),
		netip.MustParseAddr("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
	}
	dir := f.TempDir()
	f.Fuzz(func(t *testing.T, b []byte) {
		path := filepath.Join(dir, "f.mmdb")
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
		r, err := Open(path)
		if err != nil {
			return
		}
		defer func() {
			if err := r.Close(); err != nil {
				t.Error(err)
			}
		}()
		r.BuildTime()
		for _, a := range addrs {
			// errors are the expected outcome for most mutated files; only a
			// panic or a hang is a finding
			_, _ = r.Lookup(a)
		}
	})
}
