// Package geoip resolves an IP address to a city and country from a MaxMind
// DB (.mmdb) file, such as the DB-IP "IP to City Lite" database. It is a
// small reader written against the published format (spec 2.0) so that the
// project does not take on a third-party dependency for one lookup. The file
// is read with ReadAt and never loaded as a whole, and every byte of it is
// treated as hostile: a database is downloaded, not authored here.
package geoip

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"time"
)

// Place is what a lookup yields. Country is an ISO 3166-1 alpha-2 code.
// Fields the database does not know stay empty.
type Place struct {
	City, Country string
}

const (
	// The spec puts the metadata after the last marker within the final 128
	// KiB, so that is as far back as anything is searched
	metadataWindow = 128 << 10
	// bytes between the search tree and the data section
	separatorLen = 16

	// Limits for one lookup. Real records are a few dozen values nested four
	// deep; these only stop a crafted file from looping or allocating.
	maxDepth  = 32
	maxValues = 1 << 16
	maxString = 4 << 10
)

var metadataMarker = []byte("\xab\xcd\xefMaxMind.com")

// Reader is safe for concurrent use: lookups only issue ReadAt calls.
type Reader struct {
	f         *os.File
	data      *io.SectionReader
	nodeCount uint32
	recBits   int
	nodeLen   int64
	treeSize  int64
	ipv6      bool
	v4Start   uint32 // node reached after 96 zero bits, where IPv4 lives in a v6 tree
	built     time.Time
}

// Open validates the metadata and the tree geometry up front so that Lookup
// never has to doubt the file's shape, only its contents.
func Open(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	r, err := newReader(f)
	if err != nil {
		if cerr := f.Close(); cerr != nil {
			err = errors.Join(err, cerr)
		}
		return nil, err
	}
	return r, nil
}

func newReader(f *os.File) (*Reader, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	winStart := max(size-metadataWindow, 0)
	tail := make([]byte, size-winStart)
	if _, err := f.ReadAt(tail, winStart); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	i := bytes.LastIndex(tail, metadataMarker)
	if i < 0 {
		return nil, errors.New("geoip: metadata marker not found")
	}
	markerPos := winStart + int64(i)
	meta := tail[i+len(metadataMarker):]

	md := &decoder{r: bytes.NewReader(meta), size: int64(len(meta))}
	root, err := md.value(0)
	if err != nil {
		return nil, fmt.Errorf("geoip: metadata: %w", err)
	}
	if root.typ != typeMap {
		return nil, errors.New("geoip: metadata is not a map")
	}
	num := func(key string) (uint64, error) {
		pos, ok, err := md.find(root, key)
		if err != nil {
			return 0, fmt.Errorf("geoip: metadata %s: %w", key, err)
		}
		if !ok {
			return 0, fmt.Errorf("geoip: metadata %s missing", key)
		}
		n, err := md.uint(pos)
		if err != nil {
			return 0, fmt.Errorf("geoip: metadata %s: %w", key, err)
		}
		return n, nil
	}
	nodes, err := num("node_count")
	if err != nil {
		return nil, err
	}
	recBits, err := num("record_size")
	if err != nil {
		return nil, err
	}
	ipv, err := num("ip_version")
	if err != nil {
		return nil, err
	}
	major, err := num("binary_format_major_version")
	if err != nil {
		return nil, err
	}
	epoch, err := num("build_epoch")
	if err != nil {
		return nil, err
	}
	pos, ok, err := md.find(root, "database_type")
	if err != nil || !ok {
		return nil, errors.New("geoip: metadata database_type missing")
	}
	if v, err := md.value(pos); err != nil || v.typ != typeString {
		return nil, errors.New("geoip: metadata database_type is not a string")
	}

	switch {
	case major != 2:
		return nil, fmt.Errorf("geoip: unsupported format major version %d", major)
	case recBits != 24 && recBits != 28 && recBits != 32:
		return nil, fmt.Errorf("geoip: unsupported record size %d", recBits)
	case ipv != 4 && ipv != 6:
		return nil, fmt.Errorf("geoip: unsupported ip version %d", ipv)
	case nodes == 0 || nodes > 1<<32-1:
		return nil, fmt.Errorf("geoip: invalid node count %d", nodes)
	case epoch > 1<<62:
		return nil, errors.New("geoip: invalid build epoch")
	}

	r := &Reader{
		f:         f,
		nodeCount: uint32(nodes),
		recBits:   int(recBits),
		nodeLen:   int64(recBits) / 4,
		ipv6:      ipv == 6,
		built:     time.Unix(int64(epoch), 0).UTC(),
	}
	r.treeSize = r.nodeLen * int64(r.nodeCount)
	dataStart := r.treeSize + separatorLen
	if dataStart > markerPos {
		return nil, errors.New("geoip: search tree does not fit in file")
	}
	r.data = io.NewSectionReader(f, dataStart, markerPos-dataStart)

	if r.ipv6 {
		node := uint32(0)
		for i := 0; i < 96 && node < r.nodeCount; i++ {
			if node, err = r.next(node, 0); err != nil {
				return nil, err
			}
		}
		r.v4Start = node
	}
	return r, nil
}

// BuildTime is when the database was generated, from its metadata.
func (r *Reader) BuildTime() time.Time { return r.built }

// Close releases the file.
func (r *Reader) Close() error { return r.f.Close() }

// next reads one record of a node: bit 0 is the left record, 1 the right.
func (r *Reader) next(node uint32, bit byte) (uint32, error) {
	var b [8]byte
	buf := b[:r.nodeLen]
	if _, err := r.f.ReadAt(buf, int64(node)*r.nodeLen); err != nil {
		return 0, fmt.Errorf("geoip: reading node %d: %w", node, err)
	}
	be := func(p []byte) uint32 {
		var n uint32
		for _, c := range p {
			n = n<<8 | uint32(c)
		}
		return n
	}
	switch r.recBits {
	case 24:
		return be(buf[bit*3 : bit*3+3]), nil
	case 28:
		if bit == 0 {
			return uint32(buf[3]&0xF0)<<20 | be(buf[0:3]), nil
		}
		return uint32(buf[3]&0x0F)<<24 | be(buf[4:7]), nil
	default:
		return be(buf[bit*4 : bit*4+4]), nil
	}
}

// Lookup returns the zero Place and no error for an address the database
// does not cover.
func (r *Reader) Lookup(ip netip.Addr) (Place, error) {
	if !ip.IsValid() {
		return Place{}, errors.New("geoip: invalid address")
	}
	ip = ip.Unmap()
	var bits []byte
	node := uint32(0)
	switch {
	case ip.Is4():
		a := ip.As4()
		bits = a[:]
		if r.ipv6 {
			node = r.v4Start
		}
	case r.ipv6:
		a := ip.As16()
		bits = a[:]
	default:
		return Place{}, nil
	}

walk:
	for _, c := range bits {
		for s := 7; s >= 0; s-- {
			if node >= r.nodeCount {
				break walk
			}
			var err error
			if node, err = r.next(node, c>>s&1); err != nil {
				return Place{}, err
			}
		}
	}

	switch {
	case node <= r.nodeCount:
		// an empty record, or a walk that ran out of bits inside the tree
		return Place{}, nil
	case node-r.nodeCount < separatorLen:
		// points into the zero separator, which no valid file does
		return Place{}, fmt.Errorf("geoip: invalid record value %d", node)
	}
	off := int64(node-r.nodeCount) - separatorLen
	d := &decoder{r: r.data, size: r.data.Size()}
	var p Place
	var err error
	if p.City, err = d.path(off, "city", "names", "en"); err != nil {
		return Place{}, err
	}
	if p.Country, err = d.path(off, "country", "iso_code"); err != nil {
		return Place{}, err
	}
	return p, nil
}
