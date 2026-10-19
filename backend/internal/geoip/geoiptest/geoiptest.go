// Package geoiptest writes tiny MaxMind DB files for tests of code that
// downloads or reads a geolocation database. It is a trimmed copy of the
// writer the geoip package tests itself with (that one cannot be imported
// from another package) and is never linked into the server.
package geoiptest

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"net/netip"
	"time"
)

// Net is one network of the database and the place it resolves to.
type Net struct {
	CIDR, City, Country string
}

// Options shape the file's metadata. The zero value is a valid DB-IP style
// city database built now.
type Options struct {
	Type  string    // database_type, default "DBIP-City-Lite"
	Built time.Time // build_epoch, default now
}

type kv struct {
	k string
	v any
}

type (
	u16 uint16
	u32 uint32
	u64 uint64
	m   []kv
)

func size(typ, n int) []byte {
	var tail []byte
	b := byte(n)
	switch {
	case n < 29:
	case n < 285:
		b, tail = 29, []byte{byte(n - 29)}
	default:
		s := n - 285
		b, tail = 30, []byte{byte(s >> 8), byte(s)}
	}
	if typ <= 7 {
		return append([]byte{byte(typ)<<5 | b}, tail...)
	}
	return append([]byte{b, byte(typ - 7)}, tail...)
}

func minBE(n uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	return bytes.TrimLeft(b[:], "\x00")
}

func enc(v any) []byte {
	switch x := v.(type) {
	case string:
		return append(size(2, len(x)), x...)
	case u16:
		b := minBE(uint64(x))
		return append(size(5, len(b)), b...)
	case u32:
		b := minBE(uint64(x))
		return append(size(6, len(b)), b...)
	case u64:
		b := minBE(uint64(x))
		return append(size(9, len(b)), b...)
	case m:
		out := size(7, len(x))
		for _, p := range x {
			out = append(out, enc(p.k)...)
			out = append(out, enc(p.v)...)
		}
		return out
	}
	panic("geoiptest: unsupported value")
}

type child struct{ kind, v int } // kind 0 empty, 1 node, 2 data offset

// Build returns an IPv6 tree with 24-bit records holding the given networks.
// IPv4 networks live under ::/96, as in the real files.
func Build(nets []Net, o Options) []byte {
	if o.Type == "" {
		o.Type = "DBIP-City-Lite"
	}
	if o.Built.IsZero() {
		o.Built = time.Now()
	}
	var data []byte
	nodes := [][2]child{{}}
	for _, n := range nets {
		off := len(data)
		data = append(data, enc(m{
			{"city", m{{"names", m{{"en", n.City}}}}},
			{"country", m{{"iso_code", n.Country}}},
		})...)
		p := netip.MustParsePrefix(n.CIDR)
		a, bits := p.Addr().As16(), p.Bits()
		if p.Addr().Is4() {
			a4 := p.Addr().As4()
			a = [16]byte{}
			copy(a[12:], a4[:])
			bits += 96
		}
		cur := 0
		for i := 0; i < bits; i++ {
			bit := a[i/8] >> (7 - i%8) & 1
			if i == bits-1 {
				nodes[cur][bit] = child{2, off}
				break
			}
			if nodes[cur][bit].kind != 1 {
				nodes = append(nodes, [2]child{})
				nodes[cur][bit] = child{1, len(nodes) - 1}
			}
			cur = nodes[cur][bit].v
		}
	}
	count := len(nodes)
	rec := func(c child) uint32 {
		switch c.kind {
		case 1:
			return uint32(c.v)
		case 2:
			return uint32(count + 16 + c.v)
		}
		return uint32(count)
	}
	var out []byte
	for _, n := range nodes {
		l, r := rec(n[0]), rec(n[1])
		out = append(out, byte(l>>16), byte(l>>8), byte(l), byte(r>>16), byte(r>>8), byte(r))
	}
	out = append(out, make([]byte, 16)...)
	out = append(out, data...)
	out = append(out, "\xab\xcd\xefMaxMind.com"...)
	return append(out, enc(m{
		{"node_count", u32(count)},
		{"record_size", u16(24)},
		{"ip_version", u16(6)},
		{"database_type", o.Type},
		{"binary_format_major_version", u16(2)},
		{"binary_format_minor_version", u16(0)},
		{"build_epoch", u64(o.Built.Unix())},
	})...)
}

// Gzip compresses b the way the download is served.
func Gzip(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(b); err != nil {
		panic(err) // writing to a buffer cannot fail
	}
	if err := w.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}
