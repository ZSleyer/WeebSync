package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/rename"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// iso639 maps the language tags ffprobe reports (ISO 639-2/T, sometimes 639-1)
// to the app's short code style (Ger/Eng/Jap...). Unknown tags fall through to
// a title-cased three letters.
var iso639 = map[string]string{
	"ger": "Ger", "deu": "Ger", "de": "Ger",
	"eng": "Eng", "en": "Eng",
	"jpn": "Jap", "jap": "Jap", "ja": "Jap",
	"fre": "Fre", "fra": "Fre", "fr": "Fre",
	"spa": "Spa", "es": "Spa",
	"ita": "Ita", "it": "Ita",
	"por": "Por", "pt": "Por",
	"rus": "Rus", "ru": "Rus",
	"chi": "Chi", "zho": "Chi", "zh": "Chi",
	"kor": "Kor", "ko": "Kor",
	"ara": "Ara", "ar": "Ara",
	"hin": "Hin", "hi": "Hin",
}

// undLang marks a track whose language could not be read: an audio or subtitle
// stream the muxer left untagged, or tagged "und".
//
// It exists because dropping such a track is what makes a complete local copy
// look like it is missing a language. ffprobe reports an untagged German dub as
// "und", langCode turns that into "", and the stream used to vanish - so the
// local set said "no German" about a file that has it, and every remote copy
// whose NAME claims German looked like an upgrade.
//
// Recorded as a language of its own, the hole stays visible: strictSuperset can
// no longer find the remote set to be a strict superset, because no name-derived
// set ever contains Und. The gain is refused until something can actually read
// the track. Everything that counts languages has to ignore it - that is what
// realLangs is for.
const undLang = "Und"

// notALanguage are the tags that name no single language. Reading one as a
// language invents one: "gem" (Germanic languages) became "Gem" and sat in a
// copy's subtitle set next to the real "Ger", where nothing could ever match it.
//
// They are unreadable rather than absent, so langOrUnd turns them into the
// undLang hole - the honest answer, since a family code really does leave the
// language of that track unknown.
//
// ponytail: only the collective codes that have actually turned up. ISO 639-2
// has some fifty family codes (sla, roa, cel, ine ...); add them if one appears.
var notALanguage = map[string]bool{
	"und": true, // undetermined
	"mul": true, // multiple languages
	"mis": true, // uncoded
	"zxx": true, // no linguistic content
	"gem": true, // Germanic languages - a family, not a language
}

func langCode(tag string) string {
	t := strings.ToLower(strings.TrimSpace(tag))
	if t == "" || notALanguage[t] {
		return ""
	}
	if c, ok := iso639[t]; ok {
		return c
	}
	if len(t) >= 3 {
		t = t[:3]
	}
	return canonCode(t)
}

// probeQuality reads the true resolution and audio/subtitle languages of a local
// folder by running ffprobe over a few representative video files. Filenames
// often lack the tokens (especially locally), so the container streams are the
// honest source. Returns ok=false when ffprobe is unavailable or nothing in the
// folder would answer, so the caller can fall back to filename parsing.
func (s *Server) probeQuality(dir string) (q FolderQuality, ok bool) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return q, false
	}
	local, err := s.openLocal(dir)
	if err != nil {
		return q, false
	}
	defer local.Close()
	var videos, names []string
	var files int
	var total, newest int64
	fs.WalkDir(local.Root.FS(), filepath.ToSlash(local.Name), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if transfer.VideoExt[strings.ToLower(filepath.Ext(p))] {
			videos = append(videos, p)
		}
		names = append(names, d.Name())
		// the signature is built from the walk that has to happen anyway, so
		// the cache costs a stat per file and saves three ffprobe processes
		files++
		if fi, ferr := d.Info(); ferr == nil {
			total += fi.Size()
			if m := fi.ModTime().Unix(); m > newest {
				newest = m
			}
		}
		return nil
	})
	if len(videos) == 0 {
		return q, false
	}
	sig := fmt.Sprintf("%d:%d:%d", files, total, newest)
	if cached, hit := s.probeCacheGet(dir, sig); hit {
		return cached, true
	}
	q, ok = probeFilesWith(videos, func(ctx context.Context, name string) ([]probeStream, bool) {
		file, err := local.Root.Open(filepath.FromSlash(name))
		if err != nil {
			return nil, false
		}
		defer file.Close()
		return ffprobeOpenFile(ctx, file)
	})
	if !ok {
		return q, false
	}
	// the subtitle files beside the video are the other half of the answer, and
	// the walk has already seen them
	sc, any := sidecarSubs(names)
	q = withSidecars(q, sc, any)
	// what the names claim on top of that: a language the release advertises
	// and the container does not carry is a burned-in subtitle, and the only
	// way to see it is to compare the two
	q.Sub = keysSorted(unionSets(toSet(q.Sub), nameSubClaims(names)))
	s.probeCachePut(dir, sig, q)
	return q, true
}

// probeCacheGet answers a folder whose contents have not changed since it was
// last measured. A miss - no row, a different signature, or unreadable JSON -
// falls through to a real probe, so a damaged cache costs time and never a
// wrong answer.
func (s *Server) probeCacheGet(dir, sig string) (q FolderQuality, ok bool) {
	if s == nil || s.DB == nil {
		return q, false
	}
	var stored, blob string
	if err := s.DB.QueryRow(`SELECT sig, quality FROM probe_cache WHERE dir = ?`, dir).Scan(&stored, &blob); err != nil {
		return q, false
	}
	if stored != sig {
		return q, false
	}
	if json.Unmarshal([]byte(blob), &q) != nil {
		return q, false
	}
	return q, true
}

// probeCachePut records a measurement under the folder's current signature.
// Failures are ignored: the cache is an accelerator, and a library that cannot
// be written to should still answer, just slowly.
func (s *Server) probeCachePut(dir, sig string, q FolderQuality) {
	if s == nil || s.DB == nil {
		return
	}
	blob, err := json.Marshal(q)
	if err != nil {
		return
	}
	s.DB.Exec(`INSERT INTO probe_cache (dir, sig, quality, probed_at) VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT(dir) DO UPDATE SET sig = excluded.sig, quality = excluded.quality, probed_at = excluded.probed_at`,
		dir, sig, string(blob))
}

// withSidecars folds a folder's sidecar subtitles into a measured quality: they
// are subtitles the copy has (Sub) AND subtitles it can hand over as a track
// (Soft). An unlabelled one names no language but still proves the copy is not
// hardsubbed, so it records the hole rather than nothing.
func withSidecars(q FolderQuality, sc map[string]bool, any bool) FolderQuality {
	soft := toSet(q.Sub) // every subtitle STREAM is selectable by definition
	for c := range sc {
		soft[c] = true
	}
	if any && len(sc) == 0 {
		soft[undLang] = true
	}
	q.Sub, q.Soft = keysSorted(soft), keysSorted(soft)
	return q
}

// nameSubClaims is what the file names in a folder advertise as subtitles.
func nameSubClaims(names []string) map[string]bool {
	claims := map[string]bool{}
	for _, n := range names {
		_, st := rename.LangTags(n)
		for _, c := range rename.Codes(st) {
			claims[canonCode(c)] = true
		}
	}
	return claims
}

func unionSets(a, b map[string]bool) map[string]bool {
	for k := range b {
		a[k] = true
	}
	return a
}

// probeFiles measures a folder from a sample of its video files and merges what
// they report.
//
// It reads more than one file because a season is not uniform: the German dub
// commonly arrives late, so the language sits on the later episodes and not on
// the first - and reading only the first is what reported a season as missing a
// track it holds. First, middle and last cover that shape at three ffprobe calls
// per folder.
//
// ponytail: three files per folder. A folder that mixes releases still reflects
// only what those three carry; the upgrade path is every file behind a
// (path, size, mtime) memo.
func probeFilesWith(videos []string, probe func(context.Context, string) ([]probeStream, bool)) (q FolderQuality, ok bool) {
	slices.Sort(videos)
	pick := map[int]bool{0: true, len(videos) / 2: true, len(videos) - 1: true}
	dub, sub := map[string]bool{}, map[string]bool{}
	for i := range videos {
		if !pick[i] {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		streams, sok := probe(ctx, videos[i])
		cancel()
		if !sok {
			continue
		}
		ok = true
		fq := streamsQuality(streams)
		if fq.ResRank > q.ResRank {
			q.ResRank = fq.ResRank
		}
		for _, c := range fq.Dub {
			dub[c] = true
		}
		for _, c := range fq.Sub {
			sub[c] = true
		}
	}
	if !ok {
		return FolderQuality{}, false
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q, true
}

// signsWords name a subtitle track that carries signs, on-screen text and song
// lyrics rather than a translation of the dialogue.
var signsWords = map[string]bool{
	"type": true, "types": true, "typeset": true, "typesetting": true,
	"signs": true, "schilder": true,
}

// signsOnlyTitle reports whether a subtitle track's name says it is signs and
// typesetting. Such a track belongs with the forced ones: it is not a
// translation, so a copy carrying it does not "have subtitles in that language".
// A German release commonly ships a full track next to a "Type" one, and
// counting the second made the copy look like it offered a language twice.
//
// This lives here and NOT in plex.ForcedTitle, which the playback selection also
// uses. There the same words are read only when a forced track is what was asked
// for, because "Signs" is a plausible name for a full track too and demoting one
// would take away the track the user wanted. Here the asymmetry runs the other
// way: the expensive mistake is claiming a translation the copy does not have.
// "Songs" alone is deliberately absent - on its own it is too weak, and the
// usual "Signs & Songs" is caught by the first word.
func signsOnlyTitle(title string) bool {
	for _, w := range strings.FieldsFunc(strings.ToLower(title), func(r rune) bool {
		return !unicode.IsLetter(r)
	}) {
		if signsWords[w] {
			return true
		}
	}
	return false
}

// sidecarLang reads what a subtitle file sitting next to a video announces:
// the language, and whether it is a forced track.
//
// The convention is a dot-separated suffix chain - "Show - 01.ger.ass",
// "Show - 01.de.forced.srt". Only a segment the iso639 table knows counts:
// langCode falls back to title-casing any three letters it is handed, so
// running it over an arbitrary part of a title would invent languages. An
// unknown segment is skipped instead of guessed at, which leaves the file
// untagged - and untagged is a state the caller handles.
func sidecarLang(name string) (code string, forced bool) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	parts := strings.Split(base, ".")
	for _, p := range parts[1:] { // never the stem itself
		p = strings.TrimSpace(p)
		if plex.ForcedTitle(p) {
			forced = true
			continue
		}
		if c, ok := iso639[strings.ToLower(p)]; ok && code == "" {
			code = c
		}
	}
	return code, forced
}

// sidecarSubs folds a folder's file names into the subtitle languages its
// sidecar files offer, and whether any sidecar exists at all.
//
// The second answer matters on its own: a sidecar nobody labelled - which is
// exactly what this app's own rename produces, it keeps only the extension -
// names no language, but it is still proof that the copy carries selectable
// subtitles. Without it such a folder would read like a release with the
// subtitles burned into the picture.
func sidecarSubs(names []string) (langs map[string]bool, any bool) {
	langs = map[string]bool{}
	for _, n := range names {
		if !transfer.SubExt[strings.ToLower(filepath.Ext(n))] {
			continue
		}
		code, forced := sidecarLang(n)
		if forced {
			continue // signs and foreign dialogue, not a translation
		}
		any = true
		if code != "" {
			langs[code] = true
		}
	}
	return langs, any
}

// probeStream is one ffprobe stream, flattened to what we care about.
type probeStream struct {
	CodecType string
	Height    int
	Lang      string
}

// ffprobeFile runs ffprobe on a file and returns its streams. extra args are
// passed before the file (e.g. bigger -probesize for a truncated header).
// ok=false when ffprobe is missing or fails.
func ffprobeFile(ctx context.Context, file string, extra ...string) ([]probeStream, bool) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return nil, false
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	return ffprobeOpenFile(ctx, f, extra...)
}

func ffprobeOpenFile(ctx context.Context, file *os.File, extra ...string) ([]probeStream, bool) {
	args := append([]string{"-v", "quiet", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_streams"}, extra...)
	args = append(args, "/proc/self/fd/3")
	cmd := exec.CommandContext(ctx, "ffprobe", args...)
	cmd.ExtraFiles = []*os.File{file}
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	var probed struct {
		Streams []struct {
			CodecType   string `json:"codec_type"`
			Height      int    `json:"height"`
			Disposition struct {
				Forced int `json:"forced"`
			} `json:"disposition"`
			Tags struct {
				Language string `json:"language"`
				Title    string `json:"title"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if json.Unmarshal(out, &probed) != nil {
		return nil, false
	}
	out2 := make([]probeStream, 0, len(probed.Streams))
	for _, st := range probed.Streams {
		// A forced subtitle track carries signs and foreign dialogue, not a
		// translation, so it must not count as "this copy has that language" -
		// that is what made a remote copy with real subtitles look like no
		// improvement. The disposition is the container's own answer; the title
		// covers the muxers that never set it.
		if st.CodecType == "subtitle" && (st.Disposition.Forced == 1 || plex.ForcedTitle(st.Tags.Title) || signsOnlyTitle(st.Tags.Title)) {
			continue
		}
		out2 = append(out2, probeStream{st.CodecType, st.Height, st.Tags.Language})
	}
	return out2, true
}

// localFilenameQuality is the ffprobe-less fallback: walk the folder and read
// quality from the file names, same tokenizers as the remote path uses.
//
// An axis no file name says anything about ends up as undLang rather than
// empty. Empty would read as "this copy has no subtitles", which a file name
// cannot establish - it only ever states what a release advertises.
func localFilenameQuality(dir string) FolderQuality {
	q := FolderQuality{}
	var names []string
	dub, sub := map[string]bool{}, map[string]bool{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		names = append(names, name)
		if r := rename.Resolution(name); r > q.ResRank {
			q.ResRank = r
		}
		dt, st := rename.LangTags(name)
		for _, c := range rename.Codes(dt) {
			dub[canonCode(c)] = true
		}
		for _, c := range rename.Codes(st) {
			sub[canonCode(c)] = true
		}
		return nil
	})
	// a sidecar is readable without ffprobe, so it is the one selectable
	// subtitle this branch can still establish
	soft, any := sidecarSubs(names)
	if any && len(soft) == 0 {
		soft[undLang] = true
	}
	if len(dub) == 0 {
		dub[undLang] = true
	}
	if len(sub) == 0 && len(soft) == 0 {
		sub[undLang] = true
	}
	q.Dub = keysSorted(dub)
	q.Sub = keysSorted(unionSets(sub, soft))
	q.Soft = keysSorted(soft)
	return q
}
