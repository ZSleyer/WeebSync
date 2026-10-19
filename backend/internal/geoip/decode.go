package geoip

import (
	"errors"
	"fmt"
	"io"
)

// Data types of the format; 12 and 13 are deprecated and refused.
const (
	typePointer = 1
	typeString  = 2
	typeDouble  = 3
	typeBytes   = 4
	typeUint16  = 5
	typeUint32  = 6
	typeMap     = 7
	typeInt32   = 8
	typeUint64  = 9
	typeUint128 = 10
	typeArray   = 11
	typeBool    = 14
	typeFloat   = 15
)

var (
	errTooMany = errors.New("geoip: too many values in one record")
	errDepth   = errors.New("geoip: record nested too deeply")
)

// decoder walks one section (data or metadata). It never follows a pointer
// while skipping, only when a wanted key leads through one, so a pointer
// loop cannot make it spin; visited and the depth cap bound the rest.
type decoder struct {
	r       io.ReaderAt
	size    int64
	visited int
}

// value locates one decoded item without reading its payload.
type value struct {
	typ  byte
	size int64 // payload bytes, element count, or the bool itself
	off  int64 // first byte of the payload
	end  int64 // first byte after the item where it stands (past the pointer if it was one)
	ptr  bool
}

func (d *decoder) read(off int64, p []byte) error {
	if off < 0 || off > d.size || int64(len(p)) > d.size-off {
		return errors.New("geoip: read outside section")
	}
	n, err := d.r.ReadAt(p, off)
	if n == len(p) {
		return nil
	}
	if err == nil || errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return err
}

func beInt(p []byte) int64 {
	var n int64
	for _, c := range p {
		n = n<<8 | int64(c)
	}
	return n
}

// head decodes a control byte and its extension and size bytes.
func (d *decoder) head(pos int64) (value, error) {
	var b [4]byte
	if err := d.read(pos, b[:1]); err != nil {
		return value{}, err
	}
	c := b[0]
	typ := int(c >> 5)
	off := pos + 1

	if typ == typePointer {
		ss := int(c >> 3 & 3)
		n := ss + 1
		if ss == 3 {
			n = 4
		}
		if err := d.read(off, b[:n]); err != nil {
			return value{}, err
		}
		x := beInt(b[:n])
		if ss < 3 {
			x |= int64(c&7) << (8 * n)
		}
		switch ss {
		case 1:
			x += 2048
		case 2:
			x += 526336
		}
		return value{typ: typePointer, size: x, off: off + int64(n)}, nil
	}

	if typ == 0 {
		if err := d.read(off, b[:1]); err != nil {
			return value{}, err
		}
		typ = 7 + int(b[0])
		off++
	}
	switch typ {
	case typeString, typeDouble, typeBytes, typeUint16, typeUint32, typeMap,
		typeInt32, typeUint64, typeUint128, typeArray, typeBool, typeFloat:
	default:
		return value{}, fmt.Errorf("geoip: unsupported data type %d", typ)
	}

	size := int64(c & 31)
	extra := 0
	if size >= 29 {
		extra = int(size) - 28
	}
	if extra > 0 {
		if err := d.read(off, b[:extra]); err != nil {
			return value{}, err
		}
		off += int64(extra)
		size = [...]int64{0, 29, 285, 65821}[extra] + beInt(b[:extra])
	}
	return value{typ: byte(typ), size: size, off: off}, nil
}

// finish checks the payload against its type and finds where it ends.
func (d *decoder) finish(v value) (value, error) {
	var fixed, atMost int64 = -1, -1
	switch v.typ {
	case typeDouble:
		fixed = 8
	case typeFloat:
		fixed = 4
	case typeUint16:
		atMost = 2
	case typeUint32, typeInt32:
		atMost = 4
	case typeUint64:
		atMost = 8
	case typeUint128:
		atMost = 16
	case typeBool:
		if v.size > 1 {
			return value{}, errors.New("geoip: invalid bool")
		}
		v.end = v.off
		return v, nil
	case typeMap, typeArray:
		v.end = v.off
		return v, nil
	}
	if (fixed >= 0 && v.size != fixed) || (atMost >= 0 && v.size > atMost) {
		return value{}, fmt.Errorf("geoip: bad size %d for type %d", v.size, v.typ)
	}
	v.end = v.off + v.size
	if v.end > d.size {
		return value{}, errors.New("geoip: value runs past section")
	}
	return v, nil
}

// value decodes the item at pos, resolving a pointer one level.
func (d *decoder) value(pos int64) (value, error) {
	if d.visited++; d.visited > maxValues {
		return value{}, errTooMany
	}
	h, err := d.head(pos)
	if err != nil {
		return value{}, err
	}
	if h.typ != typePointer {
		return d.finish(h)
	}
	t, err := d.head(h.size)
	if err != nil {
		return value{}, err
	}
	if t.typ == typePointer {
		return value{}, errors.New("geoip: pointer to pointer")
	}
	v, err := d.finish(t)
	if err != nil {
		return value{}, err
	}
	v.end, v.ptr = h.off, true
	return v, nil
}

// skip returns the offset after the item at pos.
func (d *decoder) skip(pos int64, depth int) (int64, error) {
	if depth > maxDepth {
		return 0, errDepth
	}
	v, err := d.value(pos)
	if err != nil {
		return 0, err
	}
	if v.ptr || (v.typ != typeMap && v.typ != typeArray) {
		return v.end, nil
	}
	n := v.size
	if v.typ == typeMap {
		n *= 2
	}
	p := v.off
	for ; n > 0; n-- {
		if p, err = d.skip(p, depth+1); err != nil {
			return 0, err
		}
	}
	return p, nil
}

// find returns the position of the value stored under key in map m.
func (d *decoder) find(m value, key string) (int64, bool, error) {
	p := m.off
	var buf [64]byte
	for i := int64(0); i < m.size; i++ {
		k, err := d.value(p)
		if err != nil {
			return 0, false, err
		}
		if k.typ != typeString {
			return 0, false, errors.New("geoip: map key is not a string")
		}
		match := false
		if k.size == int64(len(key)) && len(key) <= len(buf) {
			if err := d.read(k.off, buf[:k.size]); err != nil {
				return 0, false, err
			}
			match = string(buf[:k.size]) == key
		}
		p = k.end
		if match {
			return p, true, nil
		}
		if p, err = d.skip(p, 1); err != nil {
			return 0, false, err
		}
	}
	return 0, false, nil
}

// path reads the string under the nested keys, or "" when any is missing.
func (d *decoder) path(pos int64, keys ...string) (string, error) {
	for _, key := range keys {
		v, err := d.value(pos)
		if err != nil {
			return "", err
		}
		if v.typ != typeMap {
			return "", nil
		}
		var ok bool
		if pos, ok, err = d.find(v, key); err != nil || !ok {
			return "", err
		}
	}
	v, err := d.value(pos)
	if err != nil {
		return "", err
	}
	if v.typ != typeString || v.size > maxString {
		return "", errors.New("geoip: unexpected value type or size")
	}
	buf := make([]byte, v.size)
	if err := d.read(v.off, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

// uint reads an unsigned integer of any width.
func (d *decoder) uint(pos int64) (uint64, error) {
	v, err := d.value(pos)
	if err != nil {
		return 0, err
	}
	if v.typ != typeUint16 && v.typ != typeUint32 && v.typ != typeUint64 {
		return 0, errors.New("geoip: not an unsigned integer")
	}
	var buf [8]byte
	if err := d.read(v.off, buf[:v.size]); err != nil {
		return 0, err
	}
	return uint64(beInt(buf[:v.size])), nil
}
