package geoip

import (
	"bytes"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// record builds a GeoIP2-City shaped record with one of every skippable
// type ahead of the wanted keys, and again between them.
func record(city, country string) omap {
	return omap{
		{"a_double", 1.5},
		{"a_bytes", []byte{1, 2, 3}},
		{"a_u16", u16(513)},
		{"a_u32", u32(70000)},
		{"a_i32", i32(-5)},
		{"a_u64", u64(1 << 40)},
		{"a_u128", u128{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}},
		{"an_array", []any{omap{{"k", u16(1)}}, omap{}, "s", []any{}}},
		{"a_bool", true},
		{"a_float", float32(2.5)},
		{"nested", omap{{"x", omap{{"y", []any{false, u16(0)}}}}}},
		{"city", omap{
			{"geoname_id", u32(2950159)},
			{"names", omap{{"de", "Berlin-de"}, {"en", city}, {"fr", "Berlin-fr"}}},
		}},
		{"continent", omap{{"code", "EU"}, {"names", omap{{"en", "Europe"}}}}},
		{"country", omap{{"is_in_eu", true}, {"iso_code", country}, {"names", omap{{"en", "x"}}}}},
		{"location", omap{{"latitude", 52.52}, {"longitude", 13.4}}},
	}
}

func place(city, country string) Place { return Place{city, country} }

// fixture holds the networks every record size is tested with.
func fixture() (*dataSection, []network) { return fixtureWith(600000) }

func fixtureWith(far int) (*dataSection, []network) {
	ds := &dataSection{}
	berlin := ds.add(record("Berlin", "DE"))
	tokyo := ds.add(record("Tokyo", "JP"))
	mid := ds.add(record(strings.Repeat("m", 40), "AT"))   // size byte 29
	long := ds.add(record(strings.Repeat("L", 300), "CH")) // size byte 30
	onlyCountry := ds.add(omap{{"country", omap{{"iso_code", "NL"}}}})
	empty := ds.add(omap{})

	// keys and values reached through pointers, near and far
	kCountry := ds.add("country")
	kISO := ds.add("iso_code")
	vDE := ds.add("DE")
	ds.add(make([]byte, 3000))
	vFR := ds.add("FR")
	ds.add(make([]byte, far))
	vES := ds.add("ES")
	viaRefs := ds.add(omap{{ref(kCountry), omap{{ref(kISO), ref(vDE)}}}})
	viaRefs2 := ds.add(omap{{ref(kCountry), omap{{ref(kISO), ref(vFR)}}}})
	viaRefs3 := ds.add(omap{{ref(kCountry), omap{{ref(kISO), ref(vES)}}}})

	return ds, []network{
		{cidr: "81.2.69.0/24", off: berlin},
		{cidr: "81.2.70.0/24", off: berlin}, // shares the record
		{cidr: "2001:db8::/32", off: tokyo},
		{cidr: "10.0.0.0/8", off: mid},
		{cidr: "11.0.0.0/8", off: long},
		{cidr: "12.0.0.0/8", off: onlyCountry},
		{cidr: "13.0.0.0/8", off: empty},
		{cidr: "14.0.0.0/8", off: viaRefs},
		{cidr: "15.0.0.0/8", off: viaRefs2},
		{cidr: "16.0.0.0/8", off: viaRefs3},
	}
}

func mustOpen(t *testing.T, b []byte) *Reader {
	t.Helper()
	r, err := Open(writeTemp(t, b))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	})
	return r
}

func TestLookup(t *testing.T) {
	cases := []struct {
		ip   string
		want Place
	}{
		{"81.2.69.142", place("Berlin", "DE")},
		{"81.2.70.1", place("Berlin", "DE")},
		{"::ffff:81.2.69.142", place("Berlin", "DE")},
		{"2001:db8::1", place("Tokyo", "JP")},
		{"2001:db8:ffff::1", place("Tokyo", "JP")},
		{"10.1.2.3", place(strings.Repeat("m", 40), "AT")},
		{"11.1.2.3", place(strings.Repeat("L", 300), "CH")},
		{"12.1.2.3", place("", "NL")},
		{"13.1.2.3", place("", "")},
		{"14.1.2.3", place("", "DE")},
		{"15.1.2.3", place("", "FR")},
		{"16.1.2.3", place("", "ES")},
		{"8.8.8.8", place("", "")},
		{"81.2.71.1", place("", "")},
		{"2001:db9::1", place("", "")},
		{"::1", place("", "")},
	}
	for _, size := range []int{24, 28, 32} {
		ds, nets := fixture()
		r := mustOpen(t, dbSpec{recSize: size, nets: nets, data: ds}.build())
		for _, c := range cases {
			got, err := r.Lookup(netip.MustParseAddr(c.ip))
			if err != nil {
				t.Fatalf("size %d %s: %v", size, c.ip, err)
			}
			if got != c.want {
				t.Errorf("size %d %s: got %+v, want %+v", size, c.ip, got, c.want)
			}
		}
	}
}

func TestLookupIPv4Database(t *testing.T) {
	ds, nets := fixture()
	var v4 []network
	for _, n := range nets {
		if netip.MustParsePrefix(n.cidr).Addr().Is4() {
			v4 = append(v4, n)
		}
	}
	r := mustOpen(t, dbSpec{ipv: 4, nets: v4, data: ds}.build())
	for ip, want := range map[string]Place{
		"81.2.69.142":        place("Berlin", "DE"),
		"::ffff:81.2.69.142": place("Berlin", "DE"),
		"8.8.8.8":            {},
		"2001:db8::1":        {},
	} {
		got, err := r.Lookup(netip.MustParseAddr(ip))
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v; want %+v", ip, got, err, want)
		}
	}
}

func TestLookupInvalidAddr(t *testing.T) {
	ds, nets := fixture()
	r := mustOpen(t, dbSpec{nets: nets, data: ds}.build())
	if _, err := r.Lookup(netip.Addr{}); err == nil {
		t.Error("zero address: want error")
	}
}

func TestBuildTime(t *testing.T) {
	ds, nets := fixture()
	r := mustOpen(t, dbSpec{nets: nets, data: ds}.build())
	if want := time.Unix(1760000000, 0).UTC(); !r.BuildTime().Equal(want) {
		t.Errorf("BuildTime = %v, want %v", r.BuildTime(), want)
	}
}

func TestConcurrentLookup(t *testing.T) {
	ds, nets := fixture()
	r := mustOpen(t, dbSpec{nets: nets, data: ds}.build())
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 50 {
				p, err := r.Lookup(netip.MustParseAddr("81.2.69.1"))
				if err != nil || p != place("Berlin", "DE") {
					t.Errorf("got %+v, %v", p, err)
					return
				}
			}
		})
	}
	wg.Wait()
}

func TestOpenRejects(t *testing.T) {
	good := func() dbSpec {
		ds, nets := fixture()
		return dbSpec{nets: nets, data: ds}
	}
	with := func(k string, v any) []byte {
		s := good()
		s.meta = map[string]any{k: v}
		return s.build()
	}
	noMark := good()
	noMark.noMark = true
	full := good().build()

	cases := map[string][]byte{
		"missing marker":      noMark.build(),
		"empty file":          {},
		"bad record size":     with("record_size", u16(26)),
		"zero record size":    with("record_size", u16(0)),
		"huge tree":           with("node_count", u32(1<<24-1)),
		"zero nodes":          with("node_count", u32(0)),
		"major version":       with("binary_format_major_version", u16(3)),
		"bad ip version":      with("ip_version", u16(5)),
		"missing node_count":  with("node_count", nil),
		"missing build_epoch": with("build_epoch", nil),
		"missing type":        with("database_type", nil),
		"wrong type":          with("node_count", "many"),
		"huge epoch":          with("build_epoch", u64(1<<63)),
		"truncated mid-file":  full[:len(full)/2],
		"truncated metadata":  full[:len(full)-5],
		"truncated to tree":   full[:20],
	}
	for name, b := range cases {
		r, err := Open(writeTemp(t, b))
		if err == nil {
			if cerr := r.Close(); cerr != nil {
				t.Error(cerr)
			}
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := Open(t.TempDir() + "/nope.mmdb"); err == nil {
		t.Error("missing file: want error")
	}
}

func TestLookupHostile(t *testing.T) {
	ipOf := "10.1.1.1"
	build := func(nets func(ds *dataSection) network) []byte {
		ds := &dataSection{}
		n := nets(ds)
		n.cidr = "10.0.0.0/8"
		return dbSpec{nets: []network{n}, data: ds}.build()
	}
	rec := func(v any) func(*dataSection) network {
		return func(ds *dataSection) network { return network{off: ds.add(v)} }
	}

	deep := any("x")
	for range 100 {
		deep = []any{deep}
	}
	manyBools := raw(append(putSize(11, 70000), bytes.Repeat(encode(true), 70000)...))

	cases := []struct {
		name string
		db   []byte
		want error // nil: any error will do
	}{
		{"pointer to pointer", build(func(ds *dataSection) network {
			s := ds.add("DE")
			p := ds.add(ref(s))
			return network{off: ds.add(omap{{"country", omap{{"iso_code", ref(p)}}}})}
		}), nil},
		{"record in separator", build(func(*dataSection) network { return network{rec: 5} }), nil},
		{"record past data", build(func(ds *dataSection) network { ds.add("x"); return network{rec: 5000} }), nil},
		{"pointer out of bounds", build(rec(omap{{"country", omap{{"iso_code", ref(1 << 20)}}}})), nil},
		{"deep nesting", build(rec(omap{{"deep", deep}, {"country", omap{{"iso_code", "DE"}}}})), errDepth},
		{"too many values", build(rec(omap{{"many", manyBools}, {"country", omap{{"iso_code", "DE"}}}})), errTooMany},
		{"oversized string", build(rec(omap{{"country", omap{{"iso_code", strings.Repeat("a", 5000)}}}})), nil},
		{"leaf of wrong type", build(rec(omap{{"country", omap{{"iso_code", u16(7)}}}})), nil},
		{"deprecated type", build(rec(omap{{"x", raw{0x00, 5}}, {"country", omap{{"iso_code", "DE"}}}})), nil},
		{"bad double size", build(rec(omap{{"x", raw{0x62, 0, 0}}, {"country", omap{{"iso_code", "DE"}}}})), nil},
		{"oversized uint16", build(rec(omap{{"x", raw{0xA3, 0, 0, 0}}, {"country", omap{{"iso_code", "DE"}}}})), nil},
		{"value past section", build(rec(omap{{"x", raw{0x5F, 0xFF, 0xFF, 0xFF}}})), nil},
		{"key not a string", build(rec(omap{{u16(1), "x"}})), nil},
	}
	for _, c := range cases {
		r := mustOpen(t, c.db)
		p, err := r.Lookup(netip.MustParseAddr(ipOf))
		if err == nil {
			t.Errorf("%s: want error, got %+v", c.name, p)
		} else if c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, err, c.want)
		}
		if p != (Place{}) {
			t.Errorf("%s: place %+v alongside error", c.name, p)
		}
	}
}

func TestMetadataPointerAndSkips(t *testing.T) {
	// the writer already puts a pointer and nested values in the metadata;
	// this pins that Open accepts such a file with a trailing extra key
	ds, nets := fixture()
	s := dbSpec{nets: nets, data: ds, meta: map[string]any{"zz_extra": omap{{"k", []any{u32(1)}}}}}
	mustOpen(t, s.build())
}
