package rardecode

import "testing"

// A non-solid file must not inherit the previous file's distances; a solid
// continuation keeps them.
func TestDecoder20OffsetHistoryResetsOnlyForANewFile(t *testing.T) {
	d := &decoder20{lz: &lz20Decoder{length: 9, offset: [4]int{5, 6, 7, 8}}}
	d.init(nil, false, 10, decode20Ver)
	if d.lz.offset != [4]int{5, 6, 7, 8} || d.lz.length != 9 {
		t.Fatalf("a solid continuation lost its history: %v %d", d.lz.offset, d.lz.length)
	}
	d.init(nil, true, 10, decode20Ver)
	if d.lz.offset != [4]int{} || d.lz.length != 0 {
		t.Fatalf("a new file kept the history: %v %d", d.lz.offset, d.lz.length)
	}
}

// streamBuilder builds MSB-first bit streams for hand-made filter blocks.
type streamBuilder struct {
	out []byte
	n   int
}

func (b *streamBuilder) put(v uint32, width int) {
	for i := width - 1; i >= 0; i-- {
		if b.n%8 == 0 {
			b.out = append(b.out, 0)
		}
		b.out[len(b.out)-1] |= byte((v>>i)&1) << (7 - b.n%8)
		b.n++
	}
}

// uint writes a RAR 3 uint32 below 65536.
func (b *streamBuilder) uint(v uint32) {
	if v < 16 {
		b.put(0, 2)
		b.put(v, 4)
		return
	}
	b.put(2, 2)
	b.put(v, 16)
}

var deltaFilterCode = []byte{
	0x2f, 0x01, 0x9a, 0x41, 0x80, 0xec, 0x27, 0x48, 0x2f, 0x09, 0x76, 0x6d, 0xd3, 0xea, 0x41,
	0x5b, 0x59, 0x44, 0xe8, 0x17, 0x5c, 0xe1, 0x6c, 0x91, 0x4c, 0x4e, 0x3f, 0x77, 0x00,
}

func newFilterBlock(number uint32, length *uint32) []byte {
	flags := byte(0x80)
	if length != nil {
		flags |= 0x20
	}
	var b streamBuilder
	b.uint(number)
	b.uint(0) // offset
	if length != nil {
		b.uint(*length)
	}
	b.uint(uint32(len(deltaFilterCode)))
	for _, c := range deltaFilterCode {
		b.put(uint32(c), 8)
	}
	return append([]byte{flags}, b.out...)
}

// The length history got a second entry per new filter, so the next new
// filter without an explicit length inherited the previous block length.
func TestParseVMFilterLengthHistoryStaysAligned(t *testing.T) {
	d := new(decoder29)
	five := uint32(5)
	first, err := d.parseVMFilter(newFilterBlock(1, &five))
	if err != nil {
		t.Fatal(err)
	}
	if first.length != 5 {
		t.Fatalf("first length = %d, want 5", first.length)
	}
	second, err := d.parseVMFilter(newFilterBlock(2, nil))
	if err != nil {
		t.Fatal(err)
	}
	if second.length != 0 {
		t.Fatalf("second length = %d, want 0", second.length)
	}
	if len(d.flen) != 2 || d.flen[0] != 5 || d.flen[1] != 0 {
		t.Fatalf("flen = %v, want [5 0]", d.flen)
	}
}

// RAR 7.0 runs on the 5.0 decoder; any other mix is still refused.
func TestDecoderFamily(t *testing.T) {
	if decoderFamily(decode70Ver) != decoderFamily(decode50Ver) {
		t.Fatal("7.0 and 5.0 must share a decoder")
	}
	if decoderFamily(decode29Ver) == decoderFamily(decode50Ver) {
		t.Fatal("2.9 and 5.0 must not")
	}
}
