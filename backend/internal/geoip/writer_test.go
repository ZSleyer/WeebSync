package geoip

import (
	"bytes"
	"encoding/binary"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// A minimal MMDB writer, just enough to exercise every path of the reader:
// it is written from the spec independently of the reader's decoder.

type pair struct{ K, V any }

// omap is a map with a fixed key order, so tests can put unwanted keys first.
type omap []pair

type (
	ref  int64  // pointer to an offset in the same section
	u128 []byte // up to 16 bytes, big endian
	raw  []byte // verbatim bytes
	i32  int32
	u16  uint16
	u32  uint32
	u64  uint64
)

func putSize(typ int, size int) []byte {
	var out []byte
	var tail []byte
	b := byte(0)
	switch {
	case size < 29:
		b = byte(size)
	case size < 285:
		b, tail = 29, []byte{byte(size - 29)}
	case size < 65821:
		s := size - 285
		b, tail = 30, []byte{byte(s >> 8), byte(s)}
	default:
		s := size - 65821
		b, tail = 31, []byte{byte(s >> 16), byte(s >> 8), byte(s)}
	}
	if typ <= 7 {
		out = append(out, byte(typ)<<5|b)
	} else {
		out = append(out, b, byte(typ-7))
	}
	return append(out, tail...)
}

func minBE(n uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	return bytes.TrimLeft(b[:], "\x00")
}

func encode(v any) []byte {
	switch x := v.(type) {
	case string:
		return append(putSize(2, len(x)), x...)
	case float64:
		return append(putSize(3, 8), binary.BigEndian.AppendUint64(nil, math.Float64bits(x))...)
	case []byte:
		return append(putSize(4, len(x)), x...)
	case u16:
		b := minBE(uint64(x))
		return append(putSize(5, len(b)), b...)
	case u32:
		b := minBE(uint64(x))
		return append(putSize(6, len(b)), b...)
	case i32:
		return append(putSize(8, 4), binary.BigEndian.AppendUint32(nil, uint32(x))...)
	case u64:
		b := minBE(uint64(x))
		return append(putSize(9, len(b)), b...)
	case u128:
		return append(putSize(10, len(x)), x...)
	case bool:
		if x {
			return putSize(14, 1)
		}
		return putSize(14, 0)
	case float32:
		return append(putSize(15, 4), binary.BigEndian.AppendUint32(nil, math.Float32bits(x))...)
	case []any:
		out := putSize(11, len(x))
		for _, e := range x {
			out = append(out, encode(e)...)
		}
		return out
	case omap:
		out := putSize(7, len(x))
		for _, p := range x {
			out = append(out, encode(p.K)...)
			out = append(out, encode(p.V)...)
		}
		return out
	case ref:
		o := int64(x)
		switch {
		case o < 2048:
			return []byte{0x20 | byte(o>>8), byte(o)}
		case o < 2048+1<<19:
			o -= 2048
			return []byte{0x28 | byte(o>>16), byte(o >> 8), byte(o)}
		case o < 526336+1<<27:
			o -= 526336
			return []byte{0x30 | byte(o>>24), byte(o >> 16), byte(o >> 8), byte(o)}
		default:
			return binary.BigEndian.AppendUint32([]byte{0x38}, uint32(o))
		}
	case raw:
		return x
	}
	panic("unsupported value")
}

// dataSection collects records and returns their offsets, so tests can
// share one record between networks or point at a string from a key.
type dataSection struct{ buf []byte }

func (s *dataSection) add(v any) int64 {
	off := int64(len(s.buf))
	s.buf = append(s.buf, encode(v)...)
	return off
}

type network struct {
	cidr string
	off  int64 // data offset of the record
	rec  int   // when non-zero: raw record value = node_count + rec
}

type dbSpec struct {
	recSize int // default 24
	ipv     int // default 6
	nets    []network
	data    *dataSection
	meta    map[string]any // overrides; a nil value drops the key
	noMark  bool
}

type child struct {
	kind byte // 0 empty, 1 node, 2 data, 3 raw
	v    int
}

func (s dbSpec) build() []byte {
	if s.recSize == 0 {
		s.recSize = 24
	}
	if s.ipv == 0 {
		s.ipv = 6
	}
	nodes := [][2]child{{}}
	for _, n := range s.nets {
		p := netip.MustParsePrefix(n.cidr)
		var key []byte
		bits := p.Bits()
		if s.ipv == 6 {
			a := p.Addr().As16()
			if p.Addr().Is4() {
				// As16 would give the ::ffff: form; the tree keeps IPv4 at ::/96
				a4 := p.Addr().As4()
				a = [16]byte{}
				copy(a[12:], a4[:])
				bits += 96
			}
			key = a[:]
		} else {
			a := p.Addr().As4()
			key = a[:]
		}
		cur := 0
		for i := 0; i < bits; i++ {
			bit := key[i/8] >> (7 - i%8) & 1
			if i == bits-1 {
				if n.rec != 0 {
					nodes[cur][bit] = child{3, n.rec}
				} else {
					nodes[cur][bit] = child{2, int(n.off)}
				}
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
		case 3:
			return uint32(count + c.v)
		}
		return uint32(count)
	}
	var tree []byte
	for _, n := range nodes {
		l, r := rec(n[0]), rec(n[1])
		switch s.recSize {
		case 24:
			tree = append(tree, byte(l>>16), byte(l>>8), byte(l), byte(r>>16), byte(r>>8), byte(r))
		case 28:
			tree = append(tree, byte(l>>16), byte(l>>8), byte(l), byte(l>>24)<<4|byte(r>>24), byte(r>>16), byte(r>>8), byte(r))
		default:
			tree = binary.BigEndian.AppendUint32(tree, l)
			tree = binary.BigEndian.AppendUint32(tree, r)
		}
	}

	meta := map[string]any{
		"node_count":                  u32(count),
		"record_size":                 u16(s.recSize),
		"ip_version":                  u16(s.ipv),
		"database_type":               "DBIP-City-Lite",
		"binary_format_major_version": u16(2),
		"binary_format_minor_version": u16(0),
		"build_epoch":                 u64(1760000000),
	}
	for k, v := range s.meta {
		if v == nil {
			delete(meta, k)
		} else {
			meta[k] = v
		}
	}
	keys := []string{"node_count", "record_size", "ip_version", "database_type",
		"binary_format_major_version", "binary_format_minor_version", "build_epoch"}
	// the description string sits after the map and is reached by a pointer,
	// which in metadata counts from the metadata start
	encMeta := func(descOff int64) []byte {
		m := omap{{"languages", []any{"en"}}, {"description", omap{{"en", ref(descOff)}}}}
		for _, k := range keys {
			if v, ok := meta[k]; ok {
				m = append(m, pair{k, v})
			}
		}
		return encode(m)
	}
	m := encMeta(0)
	m = encMeta(int64(len(m)))
	m = append(m, encode("DB-IP test")...)

	var out []byte
	out = append(out, tree...)
	out = append(out, make([]byte, 16)...)
	if s.data != nil {
		out = append(out, s.data.buf...)
	}
	if !s.noMark {
		out = append(out, metadataMarker...)
	}
	return append(out, m...)
}

func writeTemp(t testing.TB, b []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "t.mmdb")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
