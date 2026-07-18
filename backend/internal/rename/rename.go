// Package rename builds new file names from anitogo-parsed metadata via
// templates, or from user regexes.
package rename

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/nssteinbrenner/anitogo"
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
}

// {name}, {name:0W} (zero-pad width W), {name+N}/{name-N} (numeric offset),
// and both combined as {name-N:0W} — e.g. {episode-1155:02} turns an absolute
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
	techRe  = regexp.MustCompile(`(?i)^(?:aac|e?ac3|dts|flac|opus|mp3|x\.?26[45]|h\.?26[45]|hevc|av1|avc|web-?(?:dl|rip)?|bd(?:rip)?|blu-?ray|dvd(?:rip)?|hdtv|vhs|hdr(?:10)?|10bit|8bit|remux|uncensored)$`)
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

// LangMatch reports whether name satisfies the wanted dub/sub languages.
// An empty want is no constraint; a non-empty want requires the matching
// tag to be present and to contain that code (case-insensitive). A name
// with no tag for a wanted dimension never matches.
// ponytail: substring-match; exakte Code-Tokenisierung nur falls false positives auftreten
func LangMatch(name, wantDub, wantSub string) bool {
	dub, sub := LangTags(name)
	if wantDub != "" && !strings.Contains(strings.ToLower(dub), strings.ToLower(wantDub)) {
		return false
	}
	if wantSub != "" && !strings.Contains(strings.ToLower(sub), strings.ToLower(wantSub)) {
		return false
	}
	return true
}

// cleanGroup strips language/resolution/tech tokens from anitogo's
// ReleaseGroup guess. Names like "Show E01 [JapDub][GerEngSub]" make
// anitogo report the language tag as the release group; after cleaning
// only real group-ish tokens survive (possibly none).
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

// New returns the new filename for name, or "" when the name cannot be
// processed (e.g. no episode parsed and the template needs one).
func New(name string, o Options) (string, error) {
	switch o.Mode {
	case "regex":
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
	parsed := anitogo.Parse(name, anitogo.DefaultOptions)
	dub, sub := LangTags(name)
	vars := map[string]string{
		"title":      parsed.AnimeTitle,
		"season":     first(parsed.AnimeSeason),
		"episode":    first(parsed.EpisodeNumber),
		"year":       parsed.AnimeYear,
		"group":      cleanGroup(parsed.ReleaseGroup),
		"resolution": parsed.VideoResolution,
		"dub":        dub,
		"sub":        sub,
		"ext":        parsed.FileExtension,
	}
	if vars["season"] == "" {
		vars["season"] = "1" // no season marker in the name → season 1
	}
	if vars["resolution"] == "" { // anitogo missed it, e.g. resolution inside a tag list
		for _, g := range tokenRe.FindAllStringSubmatch(name, -1) {
			for _, tok := range strings.Split(g[1], ",") {
				if tok = strings.TrimSpace(tok); resRe.MatchString(tok) {
					vars["resolution"] = tok
					break
				}
			}
		}
	}
	if o.TitleOverride != "" {
		vars["title"] = o.TitleOverride
	}

	missing := ""
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

	if o.Separator != "" && o.Separator != " " {
		out = strings.ReplaceAll(out, " ", o.Separator)
	}
	// keep the original extension unless the template already set one
	if ext := filepath.Ext(name); ext != "" && !strings.Contains(o.Template, "{ext}") {
		out += ext
	}
	return sanitize(out), nil
}

func first(s []string) string {
	if len(s) > 0 {
		return s[0]
	}
	return ""
}

// sanitize strips path separators and other characters invalid in filenames.
func sanitize(name string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return -1
		}
		return r
	}, name)
}
