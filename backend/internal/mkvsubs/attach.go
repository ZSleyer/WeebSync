package mkvsubs

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"strings"
	"unicode/utf16"
)

const (
	idAttachments  = 0x1941A469
	idAttachedFile = 0x61A7
	idFileName     = 0x466E
	idFileMimeType = 0x4660
	idFileData     = 0x465C
)

// Attachment is a file the container carries (a font, a cover), with where its
// bytes lie: Off and Len cover the data alone.
type Attachment struct {
	Name, Mime string
	Off, Len   int64
}

// Attachments lists the files attached to the Matroska file behind r without
// reading their data: one read per attachment. A file without any gives none.
func Attachments(r io.ReaderAt, size int64) ([]Attachment, error) {
	at, err := attachmentsAt(r, size)
	if err != nil || at < 0 {
		return nil, err
	}
	_, n, hl, err := elementHeader(r, at)
	if err != nil {
		return nil, err
	}
	var out []Attachment
	for pos, end := at+hl, at+hl+n; pos < end; {
		// the name, the type and the data's header sit up front
		buf := make([]byte, 4<<10)
		k, err := r.ReadAt(buf, pos)
		if k == 0 {
			return nil, err
		}
		w := window{r: r, off: pos, buf: buf[:k]}
		id, n, hl, err := elementHeader(w, pos)
		if err != nil {
			return nil, err
		}
		if id == idAttachedFile {
			a := Attachment{Off: -1}
			for c, cend := pos+hl, pos+hl+n; c < cend; {
				cid, cn, chl, err := elementHeader(w, c)
				if err != nil {
					return nil, err
				}
				switch cid {
				case idFileName, idFileMimeType:
					if cn > 1<<10 {
						break
					}
					b := make([]byte, cn)
					if _, err := w.ReadAt(b, c+chl); err != nil {
						return nil, err
					}
					if cid == idFileName {
						a.Name = string(b)
					} else {
						a.Mime = string(b)
					}
				case idFileData:
					a.Off, a.Len = c+chl, cn
				}
				c += chl + cn
				// what follows the data (its UID) lies past the read
				if a.Off >= 0 && a.Name != "" && a.Mime != "" {
					break
				}
			}
			if a.Off >= 0 {
				out = append(out, a)
			}
		}
		pos += hl + n
	}
	return out, nil
}

// attachmentsAt finds the Attachments element: through the SeekHead, or by
// walking the top level up to the first cluster; -1 when there is none.
func attachmentsAt(r io.ReaderAt, size int64) (int64, error) {
	seg, err := segmentStart(r)
	if err != nil {
		return 0, err
	}
	for pos := seg; pos < size; {
		id, n, hl, err := elementHeader(r, pos)
		if err != nil {
			return 0, err
		}
		switch id {
		case idAttachments:
			return pos, nil
		case idCluster:
			return -1, nil
		case idSeekHead:
			var v struct {
				V seekHead `ebml:"SeekHead"`
			}
			if err := unmarshalAt(r, pos, hl+n, &v); err != nil {
				return 0, err
			}
			for _, s := range v.V.Seek {
				if beUint(s.SeekID) == idAttachments {
					return seg + int64(s.SeekPosition), nil
				}
			}
		}
		pos += hl + n
	}
	return -1, nil
}

// Font is what ReadFont learns of a font from its table directory and name
// table alone.
type Font struct {
	// Names are what libass may ask for the font by, lowercased: its family
	// with and without the style ("noto sans bold", "noto sans" for the
	// regular one), its full name and its PostScript name.
	Names []string
	// Families are the plain family names, also of a bold or italic face.
	Families []string
	// Sum stands for the font's content: the table directory holds a checksum
	// of every table. Empty when the font could not be read.
	Sum string
}

// ReadFont reads a font's table directory and name table; a font it cannot
// read (WOFF, broken) gives nothing.
func ReadFont(r io.ReaderAt) (f Font) {
	var head [12]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return f
	}
	offs := []int64{0}
	if string(head[:4]) == "ttcf" {
		n := min(binary.BigEndian.Uint32(head[8:]), 64)
		b := make([]byte, 4*n)
		if _, err := r.ReadAt(b, 12); err != nil {
			return f
		}
		offs = offs[:0]
		for i := range n {
			offs = append(offs, int64(binary.BigEndian.Uint32(b[4*i:])))
		}
	}
	seen := map[string]bool{}
	add := func(to *[]string, s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" && !seen[s] {
			seen[s] = true
			*to = append(*to, s)
		}
	}
	sum := sha256.New()
	sum.Write(head[:])
	for _, off := range offs {
		nm, dir := sfntNames(r, off)
		if nm == nil {
			return Font{}
		}
		sum.Write(dir)
		for _, pair := range [][2]uint16{{16, 17}, {1, 2}} {
			fam, sub := nm[pair[0]], nm[pair[1]]
			if fam == "" {
				continue
			}
			add(&f.Names, fam+" "+sub)
			switch strings.ToLower(sub) {
			case "", "regular", "normal", "book", "roman":
				add(&f.Names, fam)
			default:
				add(&f.Families, fam)
			}
		}
		add(&f.Names, nm[4])
		add(&f.Names, nm[6])
	}
	f.Sum = hex.EncodeToString(sum.Sum(nil))
	return f
}

// sfntNames reads the name records of the font at off: family (1), style (2),
// full name (4), PostScript name (6), typographic family and style (16, 17).
// An English Windows record wins over the others. dir is the font's header
// and table directory.
func sfntNames(r io.ReaderAt, off int64) (names map[uint16]string, dir []byte) {
	var head [12]byte
	if _, err := r.ReadAt(head[:], off); err != nil {
		return nil, nil
	}
	numTables := min(binary.BigEndian.Uint16(head[4:]), 64)
	dir = make([]byte, 16*int(numTables))
	if _, err := r.ReadAt(dir, off+12); err != nil {
		return nil, nil
	}
	var at, size int64 = -1, 0
	for i := 0; i < len(dir); i += 16 {
		if string(dir[i:i+4]) == "name" {
			// table offsets count from the start of the file, in a collection too
			at, size = int64(binary.BigEndian.Uint32(dir[i+8:])), int64(binary.BigEndian.Uint32(dir[i+12:]))
		}
	}
	if at < 0 || size < 6 || size > 1<<20 {
		return nil, nil
	}
	t := make([]byte, size)
	if _, err := r.ReadAt(t, at); err != nil {
		return nil, nil
	}
	count, strs := int(binary.BigEndian.Uint16(t[2:])), int(binary.BigEndian.Uint16(t[4:]))
	out := map[uint16]string{}
	english := map[uint16]bool{}
	for i := 0; i < count && 6+12*i+12 <= len(t); i++ {
		rec := t[6+12*i:]
		platform, lang, id := binary.BigEndian.Uint16(rec), binary.BigEndian.Uint16(rec[4:]), binary.BigEndian.Uint16(rec[6:])
		n, o := int(binary.BigEndian.Uint16(rec[8:])), int(binary.BigEndian.Uint16(rec[10:]))
		switch id {
		case 1, 2, 4, 6, 16, 17:
		default:
			continue
		}
		if strs+o+n > len(t) || english[id] {
			continue
		}
		b := t[strs+o : strs+o+n]
		var s string
		switch platform {
		case 0, 3: // UTF-16BE
			u := make([]uint16, len(b)/2)
			for j := range u {
				u[j] = binary.BigEndian.Uint16(b[2*j:])
			}
			s = string(utf16.Decode(u))
		case 1: // Macintosh, Roman: ASCII for the names that matter
			s = string(b)
		default:
			continue
		}
		if platform == 3 && lang == 0x409 {
			english[id] = true
			out[id] = s
		} else if out[id] == "" {
			out[id] = s
		}
	}
	return out, append(head[:], dir...)
}
