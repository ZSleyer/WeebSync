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

var placeholderRe = regexp.MustCompile(`\{(\w+)(?::(\d+))?\}`)

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
	vars := map[string]string{
		"title":      parsed.AnimeTitle,
		"season":     first(parsed.AnimeSeason),
		"episode":    first(parsed.EpisodeNumber),
		"year":       parsed.AnimeYear,
		"group":      parsed.ReleaseGroup,
		"resolution": parsed.VideoResolution,
		"ext":        parsed.FileExtension,
	}
	if vars["season"] == "" {
		vars["season"] = "1" // no season marker in the name → season 1
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
		if g[2] != "" { // zero padding, numeric values only
			if n, err := strconv.Atoi(val); err == nil {
				width, _ := strconv.Atoi(g[2])
				return fmt.Sprintf("%0*d", width, n)
			}
		}
		return val
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
