// Package mkvsubs reads the text subtitle tracks out of a Matroska file
// without reading the file.
//
// A subtitle track is interleaved with the picture from the first cluster to
// the last, so the usual way to get it - demux everything - reads all of a
// 1.4 GB episode for a few hundred lines. mkvmerge, which made most of the
// files this app sees, also indexes every subtitle block in the Cues: the
// cluster it sits in and where inside. That index is a few kilobytes at the
// end of the file, and with it each line is two small reads.
//
// Read gives up with ErrNoCues on a file that does not index its subtitles,
// and the caller falls back to reading the whole file.
package mkvsubs

import (
	"bytes"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/at-wat/ebml-go"
)

// ErrNoCues: the file does not index its subtitle blocks, so they cannot be
// found without reading it.
var ErrNoCues = errors.New("the file does not index its subtitles")

// Track is one track of the file, in the file's order (which is also the
// order ffprobe numbers the streams in).
type Track struct {
	Number  uint64
	Codec   string // S_TEXT/ASS, S_TEXT/UTF8, ...
	Private []byte // the ASS script header
	Text    bool   // a text subtitle this package can read
	PGS     bool   // a Bluray picture subtitle (S_HDMV/PGS), read as SUP
}

// Event is one subtitle block.
type Event struct {
	Start, End time.Duration
	Data       []byte
	pos        int64 // in the file: the muxer's order of lines that start together
}

// Subtitles is what Read found: every track, and the events of each text track.
type Subtitles struct {
	Tracks []Track
	Events map[uint64][]Event
}

var textCodecs = map[string]bool{"S_TEXT/ASS": true, "S_TEXT/SSA": true, "S_TEXT/UTF8": true, "S_TEXT/WEBVTT": true}

const (
	idSegment  = 0x18538067
	idSeekHead = 0x114D9B74
	idInfo     = 0x1549A966
	idTracks   = 0x1654AE6B
	idCues     = 0x1C53BB6B
	idCluster  = 0x1F43B675
	idBlockGrp = 0xA0
	idSimple   = 0xA3
	// the header elements are small; a file claiming otherwise is not
	// trusted to be read into memory
	maxHeaderElem = 16 << 20
)

type seekHead struct {
	Seek []struct {
		SeekID       []byte `ebml:"SeekID"`
		SeekPosition uint64 `ebml:"SeekPosition"`
	} `ebml:"Seek"`
}

type info struct {
	TimecodeScale uint64 `ebml:"TimecodeScale"`
}

type tracks struct {
	TrackEntry []trackEntry `ebml:"TrackEntry"`
}

type trackEntry struct {
	TrackNumber      uint64 `ebml:"TrackNumber"`
	TrackType        uint64 `ebml:"TrackType"`
	CodecID          string `ebml:"CodecID"`
	CodecPrivate     []byte `ebml:"CodecPrivate,omitempty"`
	ContentEncodings []struct {
		ContentEncoding []struct {
			ContentEncodingType uint64 `ebml:"ContentEncodingType"`
			ContentCompression  []struct {
				ContentCompAlgo     uint64 `ebml:"ContentCompAlgo"`
				ContentCompSettings []byte `ebml:"ContentCompSettings,omitempty"`
			} `ebml:"ContentCompression"`
		} `ebml:"ContentEncoding"`
	} `ebml:"ContentEncodings"`
}

// decoder undoes what the muxer did to a track's blocks: mkvmerge stores PGS
// (and sometimes text) zlib-compressed or with a stripped common header. A nil
// decoder means the blocks are stored as they are, ok false that they are
// encrypted or packed in a way this package does not read.
func decoder(t trackEntry) (dec func([]byte) ([]byte, error), ok bool) {
	for _, es := range t.ContentEncodings {
		for _, e := range es.ContentEncoding {
			if e.ContentEncodingType != 0 || len(e.ContentCompression) != 1 {
				return nil, false
			}
			c := e.ContentCompression[0]
			switch c.ContentCompAlgo {
			case 0: // zlib, the default
				dec = func(b []byte) ([]byte, error) {
					zr, err := zlib.NewReader(bytes.NewReader(b))
					if err != nil {
						return nil, err
					}
					return io.ReadAll(io.LimitReader(zr, maxHeaderElem))
				}
			case 3: // header stripping
				head := c.ContentCompSettings
				dec = func(b []byte) ([]byte, error) { return append(append([]byte{}, head...), b...), nil }
			default:
				return nil, false
			}
		}
	}
	return dec, true
}

// index is what the head and the Cues of a file say: where its Segment
// starts, its time scale, its tracks, and (nil without Cues) the index.
type index struct {
	seg    int64
	scale  time.Duration
	tracks tracks
	cues   *cues
}

// readIndex walks the top level up to the first cluster (SeekHead, Info,
// Tracks; attachments and tags are stepped over) and reads the Cues the
// SeekHead points at.
func readIndex(r io.ReaderAt, size int64) (*index, error) {
	seg, err := segmentStart(r)
	if err != nil {
		return nil, err
	}
	var sh seekHead
	var inf info
	ix := &index{seg: seg}
	cuesAt := int64(-1)
	for pos := seg; pos < size; {
		id, n, hl, err := elementHeader(r, pos)
		if err != nil {
			return nil, err
		}
		if id == idCluster {
			break
		}
		switch id {
		case idSeekHead:
			var v struct {
				V seekHead `ebml:"SeekHead"`
			}
			err = unmarshalAt(r, pos, hl+n, &v)
			sh = v.V
		case idInfo:
			var v struct {
				V info `ebml:"Info"`
			}
			err = unmarshalAt(r, pos, hl+n, &v)
			inf = v.V
		case idTracks:
			var v struct {
				V tracks `ebml:"Tracks"`
			}
			err = unmarshalAt(r, pos, hl+n, &v)
			ix.tracks = v.V
		case idCues:
			cuesAt = pos
		}
		if err != nil {
			return nil, err
		}
		pos += hl + n
	}
	for _, s := range sh.Seek {
		if beUint(s.SeekID) == idCues {
			cuesAt = seg + int64(s.SeekPosition)
		}
	}
	ix.scale = time.Duration(inf.TimecodeScale)
	if ix.scale == 0 {
		ix.scale = time.Millisecond
	}
	if cuesAt < 0 {
		return ix, nil
	}
	_, n, hl, err := elementHeader(r, cuesAt)
	if err != nil {
		return nil, err
	}
	var cv struct {
		V cues `ebml:"Cues"`
	}
	if err := unmarshalAt(r, cuesAt, hl+n, &cv); err != nil {
		return nil, err
	}
	ix.cues = &cv.V
	return ix, nil
}

// Keyframes are the times of the first video track's indexed keyframes, in
// order: where a stream copy can be cut. mkvmerge indexes every keyframe of a
// video track, so a gap here is a gap in the file's own index.
func Keyframes(r io.ReaderAt, size int64) ([]time.Duration, error) {
	ix, err := readIndex(r, size)
	if err != nil {
		return nil, err
	}
	var video uint64
	for _, t := range ix.tracks.TrackEntry {
		if t.TrackType == 1 { // video
			video = t.TrackNumber
			break
		}
	}
	if video == 0 || ix.cues == nil {
		return nil, ErrNoCues
	}
	var out []time.Duration
	for _, p := range ix.cues.CuePoint {
		for _, tp := range p.CueTrackPositions {
			if tp.CueTrack == video {
				out = append(out, time.Duration(p.CueTime)*ix.scale)
				break
			}
		}
	}
	if len(out) < 2 {
		return nil, ErrNoCues
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

type cues struct {
	CuePoint []struct {
		CueTime           uint64 `ebml:"CueTime"`
		CueTrackPositions []struct {
			CueTrack            uint64 `ebml:"CueTrack"`
			CueClusterPosition  uint64 `ebml:"CueClusterPosition"`
			CueRelativePosition uint64 `ebml:"CueRelativePosition,omitempty"`
			CueDuration         uint64 `ebml:"CueDuration,omitempty"`
		} `ebml:"CueTrackPositions"`
	} `ebml:"CuePoint"`
}

type blockGroup struct {
	BlockDuration uint64     `ebml:"BlockDuration,omitempty"`
	Block         ebml.Block `ebml:"Block"`
}

// Read finds the text subtitle tracks of the file behind r and reads their
// blocks through the Cues, with up to parallel reads at a time.
func Read(r io.ReaderAt, size int64, parallel int) (*Subtitles, error) {
	ix, err := readIndex(r, size)
	if err != nil {
		return nil, err
	}
	seg, scale := ix.seg, ix.scale
	out := &Subtitles{Events: map[uint64][]Event{}}
	text := map[uint64]bool{}
	decs := map[uint64]func([]byte) ([]byte, error){}
	for _, t := range ix.tracks.TrackEntry {
		isText, isPGS := textCodecs[t.CodecID], t.CodecID == "S_HDMV/PGS"
		dec, ok := decoder(t)
		if !ok {
			isText, isPGS = false, false
		}
		decs[t.TrackNumber] = dec
		out.Tracks = append(out.Tracks, Track{Number: t.TrackNumber, Codec: t.CodecID, Private: t.CodecPrivate, Text: isText, PGS: isPGS})
		if isText || isPGS {
			text[t.TrackNumber] = true
		}
	}
	if len(text) == 0 {
		return out, nil
	}
	if ix.cues == nil {
		return nil, ErrNoCues
	}
	cs := *ix.cues

	var spots []spot
	for _, p := range cs.CuePoint {
		for _, tp := range p.CueTrackPositions {
			if !text[tp.CueTrack] {
				continue
			}
			spots = append(spots, spot{track: tp.CueTrack, start: time.Duration(p.CueTime) * scale,
				dur: time.Duration(tp.CueDuration) * scale, cluster: seg + int64(tp.CueClusterPosition),
				rel: int64(tp.CueRelativePosition), haveRelative: tp.CueRelativePosition > 0})
		}
	}
	for tn := range text {
		found := false
		for _, s := range spots {
			if s.track == tn && s.haveRelative {
				found = true
				break
			}
		}
		if !found {
			return nil, ErrNoCues
		}
	}

	// on a remote file each read is a round trip. Lines that start together
	// (a typeset sign is dozens of them) sit back to back in their cluster,
	// so nearby blocks come in one read; a cluster's header is read once, and
	// the clusters spread over a few workers
	var lines []spot
	for _, s := range spots {
		if s.haveRelative {
			lines = append(lines, s)
		}
	}
	sort.Slice(lines, func(i, j int) bool {
		if lines[i].cluster != lines[j].cluster {
			return lines[i].cluster < lines[j].cluster
		}
		return lines[i].rel < lines[j].rel
	})
	var clusters [][][]spot // the runs of each cluster
	for i, s := range lines {
		if i > 0 && s.cluster == lines[i-1].cluster {
			runs := clusters[len(clusters)-1]
			run := runs[len(runs)-1]
			if s.rel-lines[i-1].rel <= runGap && s.rel-run[0].rel <= runSpan {
				runs[len(runs)-1] = append(run, s)
			} else {
				clusters[len(clusters)-1] = append(runs, []spot{s})
			}
			continue
		}
		clusters = append(clusters, [][]spot{{s}})
	}
	if parallel < 1 {
		parallel = 1
	}
	var mu sync.Mutex
	var firstErr error
	jobs := make(chan [][]spot)
	var wg sync.WaitGroup
	for range parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for runs := range jobs {
				got, err := readCluster(r, runs, scale)
				for i := range got {
					if err == nil && decs[got[i].track] != nil {
						got[i].Data, err = decs[got[i].track](got[i].Data)
					}
				}
				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
				} else {
					for _, l := range got {
						out.Events[l.track] = append(out.Events[l.track], l.Event)
					}
				}
				mu.Unlock()
			}
		}()
	}
	for _, runs := range clusters {
		jobs <- runs
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	for tn := range out.Events {
		ev := out.Events[tn]
		sort.Slice(ev, func(i, j int) bool {
			if ev[i].Start != ev[j].Start {
				return ev[i].Start < ev[j].Start
			}
			return ev[i].pos < ev[j].pos
		})
	}
	return out, nil
}

type spot struct {
	track        uint64
	start, dur   time.Duration
	cluster, rel int64
	haveRelative bool
}

const (
	// a run of lines read at once: the next block at most runGap past the
	// last, the whole run at most runSpan
	runGap  = 64 << 10
	runSpan = 1 << 20
)

// readCluster reads the lines of one cluster, a run of nearby blocks at a
// time.
func readCluster(r io.ReaderAt, runs [][]spot, scale time.Duration) ([]line, error) {
	_, _, hl, err := elementHeader(r, runs[0][0].cluster)
	if err != nil {
		return nil, err
	}
	base := runs[0][0].cluster + hl
	var out []line
	for _, run := range runs {
		from := base + run[0].rel
		// the last block's header and a line of text past its start
		buf := make([]byte, run[len(run)-1].rel-run[0].rel+1<<10)
		k, err := r.ReadAt(buf, from)
		if k == 0 {
			return nil, err
		}
		w := window{r: r, off: from, buf: buf[:k]}
		for _, s := range run {
			ev, err := readEvent(w, base+s.rel, s.start, s.dur, scale)
			if err != nil {
				return nil, err
			}
			if ev != nil {
				ev.pos = base + s.rel
				out = append(out, line{s.track, *ev})
			}
		}
	}
	return out, nil
}

type line struct {
	track uint64
	Event
}

// window answers reads inside buf from memory and passes any other on to r:
// a block larger than the read is fetched on its own.
type window struct {
	r   io.ReaderAt
	off int64
	buf []byte
}

func (w window) ReadAt(p []byte, off int64) (int, error) {
	if off >= w.off && off+int64(len(p)) <= w.off+int64(len(w.buf)) {
		return copy(p, w.buf[off-w.off:]), nil
	}
	return w.r.ReadAt(p, off)
}

// readEvent reads the block at at.
func readEvent(r io.ReaderAt, at int64, start, cueDur, scale time.Duration) (*Event, error) {
	id, n, bhl, err := elementHeader(r, at)
	if err != nil {
		return nil, err
	}
	if n > maxHeaderElem {
		return nil, fmt.Errorf("subtitle block of %d bytes", n)
	}
	var block ebml.Block
	dur := cueDur
	switch id {
	case idBlockGrp:
		var gv struct {
			V blockGroup `ebml:"BlockGroup"`
		}
		if err := unmarshalAt(r, at, bhl+n, &gv); err != nil {
			return nil, err
		}
		g := gv.V
		block = g.Block
		if g.BlockDuration > 0 {
			dur = time.Duration(g.BlockDuration) * scale
		}
	case idSimple:
		var sb struct {
			V ebml.Block `ebml:"SimpleBlock"`
		}
		if err := unmarshalAt(r, at, bhl+n, &sb); err != nil {
			return nil, err
		}
		block = sb.V
	default:
		return nil, fmt.Errorf("no block where the cue points (element %#x)", id)
	}
	if len(block.Data) == 0 {
		return nil, nil
	}
	return &Event{Start: start, End: start + dur, Data: bytes.Join(block.Data, nil)}, nil
}

// ASS writes a text track as an ASS script: the track's own header for an ASS
// track, a plain one for SRT and WebVTT text.
func (s *Subtitles) ASS(t Track) string {
	var b strings.Builder
	events := s.Events[t.Number]
	if t.Codec == "S_TEXT/ASS" || t.Codec == "S_TEXT/SSA" {
		head := strings.TrimRight(string(t.Private), "\r\n")
		b.WriteString(head)
		if !strings.Contains(head, "[Events]") {
			b.WriteString("\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text")
		}
		b.WriteString("\n")
		// in the script's own order, as ffmpeg writes it: libass stacks
		// lines that collide by it
		events = slices.Clone(events)
		sort.SliceStable(events, func(i, j int) bool { return readOrder(events[i].Data) < readOrder(events[j].Data) })
		for _, e := range events {
			// a Matroska ASS block is "ReadOrder, Layer, Style, Name,
			// MarginL, MarginR, MarginV, Effect, Text"; the times live in
			// the container
			parts := strings.SplitN(string(e.Data), ",", 3)
			if len(parts) < 3 {
				continue
			}
			fmt.Fprintf(&b, "Dialogue: %s,%s,%s,%s\n", parts[1], assTime(e.Start), assTime(e.End), parts[2])
		}
		return b.String()
	}
	b.WriteString("[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288\nScaledBorderAndShadow: yes\n\n")
	b.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	b.WriteString("Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n")
	b.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	for _, e := range events {
		fmt.Fprintf(&b, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", assTime(e.Start), assTime(e.End), plainToASS(string(e.Data)))
	}
	return b.String()
}

// readOrder is the line number a Matroska ASS block carries first.
func readOrder(b []byte) int {
	s, _, _ := strings.Cut(string(b), ",")
	n, err := strconv.Atoi(s)
	if err != nil {
		return math.MaxInt
	}
	return n
}

// SUP writes a PGS track as a .sup file: Matroska stores each display set as
// its bare segments, a .sup file prefixes every segment with "PG" and its
// presentation time in 90 kHz ticks.
func (s *Subtitles) SUP(t Track) []byte {
	var b []byte
	for _, e := range s.Events[t.Number] {
		pts := uint32(e.Start.Seconds() * 90000)
		for d := e.Data; len(d) >= 3; {
			n := 3 + (int(d[1])<<8 | int(d[2]))
			if n > len(d) {
				break // a cut segment: the rest of the set is unreadable
			}
			b = append(b, 'P', 'G', byte(pts>>24), byte(pts>>16), byte(pts>>8), byte(pts), 0, 0, 0, 0)
			b = append(b, d[:n]...)
			d = d[n:]
		}
	}
	return b
}

// plainToASS carries SRT's few tags over and keeps the line breaks.
var plainTags = strings.NewReplacer("\r\n", `\N`, "\n", `\N`, "<i>", `{\i1}`, "</i>", `{\i0}`,
	"<b>", `{\b1}`, "</b>", `{\b0}`, "<u>", `{\u1}`, "</u>", `{\u0}`)

func plainToASS(s string) string { return plainTags.Replace(strings.TrimSpace(s)) }

func assTime(d time.Duration) string {
	cs := d.Milliseconds() / 10
	return fmt.Sprintf("%d:%02d:%02d.%02d", cs/360000, cs/6000%60, cs/100%60, cs%100)
}

// ── EBML ────────────────────────────────────────────────────────────────────

// segmentStart is where the Segment's data begins: the origin of every
// position the SeekHead and the Cues hold.
func segmentStart(r io.ReaderAt) (int64, error) {
	_, n, hl, err := elementHeader(r, 0) // EBML header
	if err != nil {
		return 0, err
	}
	pos := hl + n
	id, _, hl, err := elementHeader(r, pos)
	if err != nil {
		return 0, err
	}
	if id != idSegment {
		return 0, errors.New("not a Matroska file")
	}
	return pos + hl, nil
}

// elementHeader reads the ID and size of the element at pos; hl is the length
// of the two.
func elementHeader(r io.ReaderAt, pos int64) (id uint64, size, hl int64, err error) {
	var buf [12]byte
	n, err := r.ReadAt(buf[:], pos)
	if n == 0 && err != nil {
		return 0, 0, 0, err
	}
	b := buf[:n]
	id, il := vint(b, true)
	if il == 0 {
		return 0, 0, 0, errors.New("broken element id")
	}
	sz, sl := vint(b[il:], false)
	if sl == 0 {
		return 0, 0, 0, errors.New("broken element size")
	}
	return id, int64(sz), int64(il + sl), nil
}

// vint decodes an EBML variable-length integer; keepMarker leaves the length
// marker in (as element IDs are written).
func vint(b []byte, keepMarker bool) (uint64, int) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0
	}
	l := 1
	for mask := byte(0x80); b[0]&mask == 0; mask >>= 1 {
		l++
	}
	if l > 8 || len(b) < l {
		return 0, 0
	}
	v := uint64(b[0])
	if !keepMarker {
		v &= uint64(0xFF >> l)
	}
	for _, c := range b[1:l] {
		v = v<<8 | uint64(c)
	}
	return v, l
}

func unmarshalAt(r io.ReaderAt, pos, n int64, v any) error {
	if n > maxHeaderElem {
		return fmt.Errorf("element of %d bytes", n)
	}
	// read whole: the decoder asks for a few bytes at a time, and on a remote
	// file each of those would be a round trip
	buf := make([]byte, n)
	if k, err := r.ReadAt(buf, pos); k < len(buf) {
		return err
	}
	return ebml.Unmarshal(bytes.NewReader(buf), v, ebml.WithIgnoreUnknown(true))
}

func beUint(b []byte) uint64 {
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}
