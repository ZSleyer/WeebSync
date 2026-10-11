package mkvsubs

import (
	"bytes"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"unicode/utf16"
)

// sfnt builds a font that is a table directory with a name table and nothing
// else: all FontNames reads.
func sfnt(names map[uint16]string) []byte {
	var recs, strs bytes.Buffer
	ids := []uint16{}
	for id := range names {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		u := utf16.Encode([]rune(names[id]))
		// a Windows English record: platform 3, encoding 1, language 0x409
		binary.Write(&recs, binary.BigEndian, []uint16{3, 1, 0x409, id, uint16(2 * len(u)), uint16(strs.Len())})
		binary.Write(&strs, binary.BigEndian, u)
	}
	var name bytes.Buffer
	binary.Write(&name, binary.BigEndian, []uint16{0, uint16(len(ids)), uint16(6 + recs.Len())})
	name.Write(recs.Bytes())
	name.Write(strs.Bytes())

	var f bytes.Buffer
	binary.Write(&f, binary.BigEndian, []uint32{0x00010000})
	binary.Write(&f, binary.BigEndian, []uint16{1, 0, 0, 0})
	f.WriteString("name")
	binary.Write(&f, binary.BigEndian, []uint32{0, 12 + 16, uint32(name.Len())})
	f.Write(name.Bytes())
	return f.Bytes()
}

func TestReadFont(t *testing.T) {
	cases := []struct {
		names map[uint16]string
		want  []string
	}{
		{map[uint16]string{1: "Gandhi Sans", 2: "Regular", 4: "Gandhi Sans Regular", 6: "GandhiSans-Regular"},
			[]string{"gandhi sans regular", "gandhi sans", "gandhisans-regular"}},
		// a bold face must not take the plain family from the regular one
		{map[uint16]string{1: "Gandhi Sans", 2: "Bold", 4: "Gandhi Sans Bold", 6: "GandhiSans-Bold"},
			[]string{"gandhi sans bold", "gandhisans-bold"}},
		// the typographic family groups weights the legacy one splits up
		{map[uint16]string{1: "Noto Sans SemiBold", 2: "Regular", 16: "Noto Sans", 17: "SemiBold"},
			[]string{"noto sans semibold", "noto sans semibold regular"}},
	}
	for _, c := range cases {
		if got := ReadFont(bytes.NewReader(sfnt(c.names))).Names; !slices.Equal(got, c.want) {
			t.Errorf("%v: %q, want %q", c.names, got, c.want)
		}
	}
	if got := ReadFont(bytes.NewReader([]byte("wOF2 not a font at all"))); got.Names != nil || got.Sum != "" {
		t.Errorf("WOFF2: %+v", got)
	}
	// the sum follows the content: the same font gives the same, a changed
	// table (its checksum in the directory) another
	a, b := sfnt(map[uint16]string{1: "A"}), sfnt(map[uint16]string{1: "A"})
	b[16] ^= 1
	sa, sb := ReadFont(bytes.NewReader(a)).Sum, ReadFont(bytes.NewReader(b)).Sum
	if sa == "" || sa != ReadFont(bytes.NewReader(sfnt(map[uint16]string{1: "A"}))).Sum || sa == sb {
		t.Errorf("sums %q %q", sa, sb)
	}
}

// Attachments finds every attached file's bytes in an ffmpeg-made Matroska file.
func TestAttachments(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	dir := t.TempDir()
	a, b := bytes.Repeat([]byte("font A "), 3000), sfnt(map[uint16]string{1: "B"})
	os.WriteFile(filepath.Join(dir, "a.ttf"), a, 0o600)
	os.WriteFile(filepath.Join(dir, "b.otf"), b, 0o600)
	out := filepath.Join(dir, "x.mkv")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=64x64:d=1", "-c:v", "libx264",
		"-attach", filepath.Join(dir, "a.ttf"), "-metadata:s:t:0", "mimetype=font/ttf",
		"-attach", filepath.Join(dir, "b.otf"), "-metadata:s:t:1", "mimetype=font/otf", out)
	if msg, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, msg)
	}
	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	got, err := Attachments(f, fi.Size())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		name, mime string
		data       []byte
	}{{"a.ttf", "font/ttf", a}, {"b.otf", "font/otf", b}}
	if len(got) != len(want) {
		t.Fatalf("%d attachments: %+v", len(got), got)
	}
	for i, w := range want {
		data := make([]byte, got[i].Len)
		f.ReadAt(data, got[i].Off)
		if got[i].Name != w.name || got[i].Mime != w.mime || !bytes.Equal(data, w.data) {
			t.Errorf("attachment %d: %s %s %d bytes", i, got[i].Name, got[i].Mime, len(data))
		}
	}
}
