// Package rename builds new file names from relname-parsed metadata via
// templates, or from user regexes.
package rename

import (
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/relname"
)

// Options for one rename run.
type Options struct {
	Mode string `json:"mode"` // "template" | "regex"

	// template mode
	Template      string `json:"template"`      // e.g. "{title} - S{season:02}E{episode:02}"
	Separator     string `json:"separator"`     // replaces spaces in the result; "" keeps spaces
	TitleOverride string `json:"titleOverride"` // e.g. AniList title instead of the parsed one

	// regex mode
	Pattern     string `json:"pattern"`
	Replacement string `json:"replacement"` // Go syntax: $1, ${name}

	// aired-order override (template mode): when set, these win over the
	// season/episode parsed from the name. Used to place a file into its real
	// broadcast season (e.g. absolute 1187 → S34E01) instead of a fixed season
	// or a flat arithmetic offset. nil = no override.
	SeasonOverride  *int `json:"-"`
	EpisodeOverride *int `json:"-"`
}

// MaxPattern is the longest regex pattern a rename rule may carry, in bytes.
const MaxPattern = 4096

// {name}, {name:0W} (zero-pad width W), {name+N}/{name-N} (numeric offset),
// and both combined as {name-N:0W} - e.g. {episode-1155:02} turns an absolute
// One Piece "E1156" into a season-relative "01".
var placeholderRe = regexp.MustCompile(`\{(\w+)([+-]\d+)?(?::(\d+))?\}`)

// Generic patterns only, never real release-group or provider names:
// language tags are composed language prefixes ending in Dub/Sub
// (GerDub, JapDub, GerEngSub, GerJapDub, ...), plus resolution and
// common tech terms. Anything matching these is metadata, not a group.
var (
	langRe = regexp.MustCompile(`(?i)^(?:Ger|Eng|Jap|Chi|Kor|Fre|Spa|Ita|Por|Rus|Tur|Ara|Hin|De|En|Ja)+(Dub|Sub)$`)
	// codeRe pulls the individual language prefixes out of a composed tag
	// ("GerJapDub" -> Ger, Jap). Longest alternatives first so "Ger" wins
	// over "En"-style short codes when both could match a substring.
	codeRe  = regexp.MustCompile(`(?i)Ger|Eng|Jap|Chi|Kor|Fre|Spa|Ita|Por|Rus|Tur|Ara|Hin|De|En|Ja`)
	resRe   = regexp.MustCompile(`(?i)^(?:\d{3,4}p|[48]k)$`)
	techRe  = regexp.MustCompile(`(?i)^(?:aac|e?ac3|dts|flac|opus|mp3|x\.?26[45]|h\.?26[45]|hevc|av1|avc|web-?(?:dl|rip)?|dl|bd(?:rip)?|blu-?ray|dvd(?:rip)?|hdtv|vhs|hdr(?:10)?|10bit|8bit|remux|uncensored)$`)
	tokenRe = regexp.MustCompile(`[\[\(]([^\]\)]*)[\]\)]`)
)

// LangTags scans all bracket/paren token groups of a name and returns the
// first ...Dub and ...Sub language tag (e.g. "GerJapDub", "GerEngSub").
func LangTags(name string) (dub, sub string) {
	for _, g := range tokenRe.FindAllStringSubmatch(name, -1) {
		for _, tok := range strings.Split(g[1], ",") {
			tok = strings.TrimSpace(tok)
			m := langRe.FindStringSubmatch(tok)
			if m == nil {
				continue
			}
			if strings.EqualFold(m[1], "dub") && dub == "" {
				dub = tok
			}
			if strings.EqualFold(m[1], "sub") && sub == "" {
				sub = tok
			}
		}
	}
	return dub, sub
}

// Codes splits a composed language tag ("GerJapDub") into its individual
// prefix codes ("Ger", "Jap"), preserving each tag's original casing.
// Used to enumerate the languages actually present in a server's index.
func Codes(tag string) []string {
	return codeRe.FindAllString(tag, -1)
}

// resHeightRe pulls a video height out of a resolution token in any of the
// forms that show up in release names: "1080p", "1920x1080", "4K", "8k".
var resHeightRe = regexp.MustCompile(`(?i)^(?:(\d{3,4})p|\d{3,4}x(\d{3,4})|([48])k)$`)

// Resolution scans a name (the parsed resolution plus every bracket/paren token) and
// returns the highest video height it can read, or 0 when none is present.
// "4K" folds to 2160, "8K" to 4320. Used to rank quality variants of a folder.
func Resolution(name string) int {
	best := 0
	consider := func(tok string) {
		tok = strings.TrimSpace(tok)
		m := resHeightRe.FindStringSubmatch(tok)
		if m == nil {
			return
		}
		h := 0
		switch {
		case m[1] != "": // "1080p"
			h, _ = strconv.Atoi(m[1])
		case m[2] != "": // "1920x1080"
			h, _ = strconv.Atoi(m[2])
		case m[3] == "4":
			h = 2160
		case m[3] == "8":
			h = 4320
		}
		if h > best {
			best = h
		}
	}
	consider(relname.Read(name).Resolution)
	for _, g := range tokenRe.FindAllStringSubmatch(name, -1) {
		for _, tok := range strings.Split(g[1], ",") {
			consider(tok)
		}
	}
	return best
}

// LangMatch reports whether name satisfies the wanted dub/sub languages.
// An empty want is no constraint; a non-empty want requires the matching tag to
// carry that exact language code (case-insensitive). A name with no tag for a
// wanted dimension never matches. Exact-code (not substring) so e.g. "En" does
// not spuriously match "Eng".
func LangMatch(name, wantDub, wantSub string) bool {
	dub, sub := LangTags(name)
	return tagsMatch(dub, sub, wantDub, wantSub)
}

// PathLangTags reads a remote path's language tags file first: the file's
// own tag wins, and only a dimension its name leaves open falls back to the
// nearest folder that carries one. A season folder is labeled with where it
// is heading ([GerJapDub]) while its newest files are still [JapDub];
// scanning the whole path found the folder's tag first and let every one of
// them through a GerDub filter.
func PathLangTags(p string) (dub, sub string) {
	for p != "" && p != "/" && p != "." {
		d, s := LangTags(path.Base(p))
		if dub == "" {
			dub = d
		}
		if sub == "" {
			sub = s
		}
		if dub != "" && sub != "" {
			break
		}
		p = path.Dir(p)
	}
	return dub, sub
}

// PathLangMatch is LangMatch over PathLangTags.
func PathLangMatch(p, wantDub, wantSub string) bool {
	dub, sub := PathLangTags(p)
	return tagsMatch(dub, sub, wantDub, wantSub)
}

func tagsMatch(dub, sub, wantDub, wantSub string) bool {
	if wantDub != "" && !hasCode(dub, wantDub) {
		return false
	}
	if wantSub != "" && !hasCode(sub, wantSub) {
		return false
	}
	return true
}

// hasCode reports whether a composed tag ("GerJapDub") contains the exact
// language code ("Ger"), case-insensitively.
func hasCode(tag, want string) bool {
	for _, c := range Codes(tag) {
		if strings.EqualFold(c, want) {
			return true
		}
	}
	return false
}

// cleanGroup strips language/resolution/tech tokens from a release group:
// a comma list ("SubCrew, GerSub") keeps only its group-ish parts (possibly
// none).
func cleanGroup(group string) string {
	var kept []string
	for _, tok := range strings.Split(group, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" || langRe.MatchString(tok) || resRe.MatchString(tok) || techRe.MatchString(tok) {
			continue
		}
		kept = append(kept, tok)
	}
	return strings.Join(kept, ",")
}

// Group is the release group a file name names, "" when none is
// recognisable.
func Group(name string) string {
	return cleanGroup(relname.Read(name).Group)
}

// New returns the new filename for name, or "" when the name cannot be
// processed (e.g. no episode parsed and the template needs one).
func New(name string, o Options) (string, error) {
	switch o.Mode {
	case "regex":
		if len(o.Pattern) > MaxPattern {
			return "", fmt.Errorf("invalid pattern: longer than %d bytes", MaxPattern)
		}
		re, err := regexp.Compile(o.Pattern)
		if err != nil {
			return "", fmt.Errorf("invalid pattern: %w", err)
		}
		return re.ReplaceAllString(name, o.Replacement), nil
	case "template":
		return templateName(name, o)
	default:
		return "", fmt.Errorf("unknown mode %q", o.Mode)
	}
}

func templateName(name string, o Options) (string, error) {
	parsed := relname.Read(name)
	dub, sub := LangTags(name)
	// a subtitle sidecar keeps its language/flag tags: "ger.forced.srt"
	ext := parsed.Ext
	if parsed.Sidecar != "" {
		ext = parsed.Sidecar
	}
	vars := map[string]string{
		"title":      parsed.Title,
		"season":     "1", // no season marker in the name → season 1
		"episode":    parsed.Episode(),
		"year":       num(parsed.Year),
		"group":      cleanGroup(parsed.Group),
		"resolution": parsed.Resolution,
		"dub":        dub,
		"sub":        sub,
		"ext":        ext,
	}
	if parsed.HasSeason { // "S00E04" keeps its specials season
		vars["season"] = strconv.Itoa(parsed.Season)
	}
	if vars["resolution"] == "" { // none parsed: a resolution further inside a tag list
	groups:
		for _, g := range tokenRe.FindAllStringSubmatch(name, -1) {
			for _, tok := range strings.Split(g[1], ",") {
				if tok = strings.TrimSpace(tok); resRe.MatchString(tok) {
					vars["resolution"] = tok
					break groups // the first one wins
				}
			}
		}
	}
	if o.TitleOverride != "" {
		vars["title"] = o.TitleOverride
	}
	// aired-order override replaces both season and episode, so a
	// {season}/{episode:02} template lands the file in its real broadcast
	// season. Only meaningful together, so require both to be set.
	if o.SeasonOverride != nil && o.EpisodeOverride != nil {
		vars["season"] = strconv.Itoa(*o.SeasonOverride)
		vars["episode"] = strconv.Itoa(*o.EpisodeOverride)
	}
	// clean each substituted value so a title like "Fate/stay night" never
	// introduces a "/" - only the template literals may carry folder
	// separators (e.g. an aired-order "Season {season:02}/..." template).
	for k, v := range vars {
		vars[k] = sanitizeSegment(v)
	}

	missing, negative := "", ""
	out := placeholderRe.ReplaceAllStringFunc(o.Template, func(m string) string {
		g := placeholderRe.FindStringSubmatch(m)
		val, ok := vars[g[1]]
		if !ok || val == "" {
			missing = g[1]
			return m
		}
		// offset and zero-pad apply to integer values only; a fractional
		// episode (e.g. a "1163.5" special) passes through untouched.
		n, err := strconv.Atoi(val)
		if err != nil {
			return val
		}
		if g[2] != "" { // signed offset, e.g. -1155
			off, _ := strconv.Atoi(g[2])
			n += off
			// an offset made for later episodes (e.g. -1147 for a season that
			// starts at 1148) would name an earlier file "E-1146"; clamping to
			// 0 would file every such episode under the same E00, so the name
			// fails and the file keeps its original one instead
			if n < 0 {
				negative = g[1]
				return m
			}
		}
		if g[3] != "" { // zero-pad width
			width, _ := strconv.Atoi(g[3])
			return fmt.Sprintf("%0*d", width, n)
		}
		return strconv.Itoa(n)
	})
	if missing != "" {
		return "", fmt.Errorf("no %q found in %q", missing, name)
	}
	if negative != "" {
		return "", fmt.Errorf("offset takes %q of %q below zero", negative, name)
	}

	if o.Separator != "" && o.Separator != " " {
		out = strings.ReplaceAll(out, " ", o.Separator)
	}
	// keep the original extension unless the template already set one
	if !strings.Contains(o.Template, "{ext}") {
		if parsed.Sidecar != "" {
			out += "." + parsed.Sidecar
		} else if e := filepath.Ext(name); e != "" {
			out += e
		}
	}
	return sanitize(out), nil
}

// num renders a parsed number, "" for the zero that means "not in the name".
func num(n int) string {
	if n == 0 {
		return ""
	}
	return strconv.Itoa(n)
}

// sanitize cleans a name that may carry a "/"-separated folder structure
// (e.g. "Season 34/Title - S34E01.mkv" from an aired-order template). Each
// segment is cleaned individually so the "/" separators survive while every
// other invalid character - including a stray "\" or "." traversal - is
// stripped per segment. Empty segments are dropped, so a leading/duplicate "/"
// can't escape the target directory.
func sanitize(name string) string {
	var kept []string
	for _, seg := range strings.Split(name, "/") {
		seg = strings.Trim(sanitizeSegment(seg), " .")
		if seg != "" {
			kept = append(kept, seg)
		}
	}
	return strings.Join(kept, "/")
}

// sanitizeSegment strips characters invalid in a single path component.
func sanitizeSegment(seg string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return -1
		}
		return r
	}, seg)
}
