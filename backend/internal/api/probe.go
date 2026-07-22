package api

import (
	"context"
	"encoding/json"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

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

func langCode(tag string) string {
	t := strings.ToLower(strings.TrimSpace(tag))
	if t == "" || t == "und" {
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
// folder by running ffprobe on one representative video file. Filenames often
// lack the tokens (especially locally), so the container streams are the honest
// source. Returns ok=false when ffprobe is unavailable or no video is found, so
// the caller can fall back to filename parsing.
//
// ponytail: probes a single (the first) video file per folder - representative
// for a season folder; a mixed-quality folder would only reflect that one file.
func probeQuality(dir string) (q FolderQuality, ok bool) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return q, false
	}
	var video string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if transfer.VideoExt[strings.ToLower(filepath.Ext(p))] {
			video = p
			return filepath.SkipAll
		}
		return nil
	})
	if video == "" {
		return q, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "quiet",
		"-print_format", "json", "-show_streams", video).Output()
	if err != nil {
		return q, false
	}
	var probed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Height    int    `json:"height"`
			Tags      struct {
				Language string `json:"language"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if json.Unmarshal(out, &probed) != nil {
		return q, false
	}
	dub, sub := map[string]bool{}, map[string]bool{}
	for _, st := range probed.Streams {
		switch st.CodecType {
		case "video":
			if st.Height > q.ResRank {
				q.ResRank = st.Height
			}
		case "audio":
			if c := langCode(st.Tags.Language); c != "" {
				dub[c] = true
			}
		case "subtitle":
			if c := langCode(st.Tags.Language); c != "" {
				sub[c] = true
			}
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q, true
}

// localFilenameQuality is the ffprobe-less fallback: walk the folder and read
// quality from the file names, same tokenizers as the remote path uses.
func localFilenameQuality(dir string) FolderQuality {
	q := FolderQuality{}
	dub, sub := map[string]bool{}, map[string]bool{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
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
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q
}
