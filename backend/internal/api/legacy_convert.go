package api

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Conversion of a config file from the original Node weebsync
// (BastianGanze/weebsync) into this app's model: one server plus one watch per
// syncMap. Everything here is pure - the plan is built first, shown to the user
// as a dry run, and only then written.

// legacyConfig mirrors the old `weebsync.config.json` (shared/types.d.ts).
// Pointers mark optional keys so an absent flag can be told from a false one.
type legacyConfig struct {
	SyncOnStart               *bool `json:"syncOnStart"`
	AutoSyncIntervalInMinutes *int  `json:"autoSyncIntervalInMinutes"`
	DebugFileNames            *bool `json:"debugFileNames"`
	StartAsTray               *bool `json:"startAsTray"`
	Server                    struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		User     string `json:"user"`
		Password string `json:"password"`
	} `json:"server"`
	SyncMaps []legacySyncMap `json:"syncMaps"`
}

type legacySyncMap struct {
	ID                 string `json:"id"`
	OriginFolder       string `json:"originFolder"`
	DestinationFolder  string `json:"destinationFolder"`
	FileRegex          string `json:"fileRegex"`
	FileRenameTemplate string `json:"fileRenameTemplate"`
	Rename             *bool  `json:"rename"` // absent in old files, then derived
}

// LegacyServerPlan is the server suggested from the old config. The old app
// spoke plain FTP only, so the suggestion is always sftp on 22 - the original
// port is carried along purely so the UI can explain the change.
type LegacyServerPlan struct {
	Name        string `json:"name"`
	Protocol    string `json:"protocol"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	OldPort     int    `json:"oldPort"`
	HasPassword bool   `json:"hasPassword"`
}

// LegacyWatchPlan is one converted syncMap. Warnings are i18n keys; a non-empty
// Error means the row cannot be imported as is.
type LegacyWatchPlan struct {
	ID            string   `json:"id"` // old syncMap id, also the UI row key
	RemotePath    string   `json:"remotePath"`
	LocalPath     string   `json:"localPath"`
	Mode          string   `json:"mode"`
	Template      string   `json:"template"`
	TitleOverride string   `json:"titleOverride"`
	Pattern       string   `json:"pattern"`
	Replacement   string   `json:"replacement"`
	FromEpisode   int      `json:"fromEpisode"`
	Offset        int      `json:"offset"` // renumber offset found, 0 = none
	Warnings      []string `json:"warnings"`
	Error         string   `json:"error"`
}

// LegacyPlan is the full dry-run preview.
type LegacyPlan struct {
	Server      LegacyServerPlan  `json:"server"`
	Watches     []LegacyWatchPlan `json:"watches"`
	IntervalMin int               `json:"intervalMin"`
	Warnings    []string          `json:"warnings"`
	Dropped     []string          `json:"dropped"` // old settings without an equivalent
}

var (
	// {{ ... }} - the old templates were Handlebars
	hbRe = regexp.MustCompile(`\{\{\s*([^{}]*?)\s*\}\}`)
	// renumber $1 13 [pad] - subtracts and zero-pads, exactly our {episode-13:02}.
	// A fractional offset is matched too, only to be rejected: our placeholders
	// count in whole episodes.
	renumberRe = regexp.MustCompile(`^renumber\s+\$(\d+)\s+(-?\d+(?:\.\d+)?)(?:\s+(\d+))?$`)
	groupRe    = regexp.MustCompile(`^\$(\d+)$`)
	// any Handlebars block helper ({{#whatever}}then{{else}}otherwise{{/whatever}}).
	// Only the "otherwise" branch survives - see stripConditionals.
	blockRe = regexp.MustCompile(`(?s)\{\{#[^{}]*\}\}.*?\{\{else\}\}(.*?)\{\{/[^{}]*\}\}`)
	// a block without an else branch keeps its body
	blockPlainRe = regexp.MustCompile(`(?s)\{\{#[^{}]*\}\}(.*?)\{\{/[^{}]*\}\}`)
	// trailing literal extension in a template; ours appends the original one
	tmplExtRe  = regexp.MustCompile(`\.[A-Za-z0-9]{1,9}$`)
	winDriveRe = regexp.MustCompile(`^[A-Za-z]:`)
	// leftovers after a capture group was dropped: empty bracket pairs, then
	// runs of separators, then separators at either end
	emptyPairRe = regexp.MustCompile(`\(\s*\)|\[\s*\]|\{\s*\}`)
	// only a doubled separator is collapsed - a deliberate "_-_" must survive
	sepRunRe  = regexp.MustCompile(`_{2,}|-{2,}|\.{2,}| {2,}`)
	sepEdgeRe = regexp.MustCompile(`^[_\-. ]+|[_\-. ]+$`)
)

// convertLegacy turns an old config into an import plan. localRoot is the
// target directory the destination folders are remapped onto; empty keeps the
// original paths (which will usually fail the root allowlist).
func convertLegacy(cfg legacyConfig, localRoot string) LegacyPlan {
	p := LegacyPlan{
		Server: LegacyServerPlan{
			Name:        firstNonEmpty(cfg.Server.Host, "weebsync"),
			Protocol:    "sftp", // never carry the old plaintext FTP over silently
			Host:        cfg.Server.Host,
			Port:        22,
			Username:    cfg.Server.User,
			OldPort:     cfg.Server.Port,
			HasPassword: cfg.Server.Password != "",
		},
		IntervalMin: 30,
		Warnings:    []string{"legacyWarnFtp"},
	}
	if cfg.AutoSyncIntervalInMinutes != nil {
		p.IntervalMin = min(max(*cfg.AutoSyncIntervalInMinutes, 5), 1440)
	}
	for _, d := range []struct {
		key string
		set bool
	}{
		{"syncOnStart", cfg.SyncOnStart != nil},
		{"debugFileNames", cfg.DebugFileNames != nil},
		{"startAsTray", cfg.StartAsTray != nil},
	} {
		if d.set {
			p.Dropped = append(p.Dropped, d.key)
		}
	}

	dests := make([]string, len(cfg.SyncMaps))
	for i, m := range cfg.SyncMaps {
		dests[i] = cleanLegacyPath(m.DestinationFolder, m.ID)
	}
	prefix := commonDirPrefix(dests)
	for i, m := range cfg.SyncMaps {
		w := convertSyncMap(m)
		w.LocalPath = remapLocal(dests[i], prefix, localRoot)
		if w.LocalPath == "" {
			w.Error = "legacyErrNoLocalPath"
		}
		if w.RemotePath == "" {
			w.Error = "legacyErrNoRemotePath"
		}
		p.Watches = append(p.Watches, w)
	}
	return p
}

// convertSyncMap maps one syncMap onto a watch, without the local path (which
// needs the whole set to find a common prefix).
func convertSyncMap(m legacySyncMap) LegacyWatchPlan {
	w := LegacyWatchPlan{ID: m.ID, RemotePath: strings.TrimRight(m.OriginFolder, "/")}

	rename := m.FileRegex != "" || m.FileRenameTemplate != ""
	if m.Rename != nil {
		rename = *m.Rename
	}
	if !rename {
		// empty template = keep the original name (see watchNameFn)
		w.Mode = "template"
		return w
	}

	tmpl, hadBlock := stripConditionals(m.FileRenameTemplate)
	exprs := hbRe.FindAllStringSubmatch(tmpl, -1)
	offset, pad, ok := findRenumber(exprs)
	if ok {
		// The old renumber helper is our {episode-N:0W}, so this rule keeps
		// working on names our parser understands - no regex needed.
		w.Mode = "template"
		w.TitleOverride = m.ID
		w.Offset = offset
		var dropped []string
		w.Template = hbRe.ReplaceAllStringFunc(tmpl, func(s string) string {
			expr := hbRe.FindStringSubmatch(s)[1]
			switch {
			case expr == "$syncName":
				return "{title}"
			case renumberRe.MatchString(expr):
				return fmt.Sprintf("{episode%s:%02d}", signedOffset(offset), pad)
			default:
				dropped = append(dropped, expr)
				return ""
			}
		})
		w.Template = tidyTemplate(w.Template, true)
		if hadBlock {
			w.Warnings = append(w.Warnings, "legacyWarnConditional")
		}
		if len(dropped) > 0 {
			// e.g. a "{{$3}}" metadata tail: our template has no equivalent
			w.Warnings = append(w.Warnings, "legacyWarnDroppedGroups")
		}
		if m.FileRegex != "" {
			w.Warnings = append(w.Warnings, "legacyWarnFilterDropped")
		}
		return w
	}

	// No renumber: keep the regex, translate the capture references.
	w.Mode = "regex"
	w.Pattern = m.FileRegex
	w.Replacement = hbRe.ReplaceAllStringFunc(tmpl, func(s string) string {
		expr := hbRe.FindStringSubmatch(s)[1]
		switch {
		case expr == "$syncName":
			return m.ID
		case groupRe.MatchString(expr):
			return "${" + groupRe.FindStringSubmatch(expr)[1] + "}"
		default:
			return ""
		}
	})
	w.Replacement = tidyTemplate(w.Replacement, false)
	if hadBlock {
		w.Warnings = append(w.Warnings, "legacyWarnConditional")
	}
	if w.Pattern == "" {
		w.Warnings = append(w.Warnings, "legacyWarnNoPattern")
	} else if _, err := regexp.Compile(w.Pattern); err != nil {
		// JS regexes may use lookarounds/backreferences, which RE2 rejects
		w.Error = "legacyErrBadRegex"
	}
	return w
}

// stripConditionals reduces a Handlebars block helper to its "otherwise"
// branch. Blocks come from forks of the old app (the original only shipped
// `renumber`), so there is nothing general to translate them into: keeping the
// branch for the ordinary case and flagging the rule beats emitting a template
// with the branch keywords baked in as literals.
func stripConditionals(tmpl string) (string, bool) {
	out := blockRe.ReplaceAllString(tmpl, "$1")
	out = blockPlainRe.ReplaceAllString(out, "$1")
	return out, out != tmpl
}

// tidyTemplate cleans up after dropped placeholders: a removed capture group
// leaves its brackets and separators behind ("_()[][]"), which would otherwise
// end up in every file name. stripExt only applies to the template mode, where
// the engine appends the original extension itself; a regex replacement is the
// whole new name and has to keep it.
func tidyTemplate(s string, stripExt bool) string {
	// repeat: "[[]]"-style nesting only collapses one layer per pass
	for {
		next := emptyPairRe.ReplaceAllString(s, "")
		if next == s {
			break
		}
		s = next
	}
	if stripExt {
		s = tmplExtRe.ReplaceAllString(s, "")
	}
	s = sepRunRe.ReplaceAllStringFunc(s, func(run string) string { return run[:1] })
	return sepEdgeRe.ReplaceAllString(s, "")
}

// findRenumber reports the offset and zero-pad width of the single renumber
// call in the template. More than one is not expressible in one placeholder,
// and neither is a fractional offset - our placeholders count whole episodes.
func findRenumber(exprs [][]string) (offset, pad int, ok bool) {
	pad = 2
	for _, e := range exprs {
		m := renumberRe.FindStringSubmatch(e[1])
		if m == nil {
			continue
		}
		n, err := strconv.Atoi(m[2])
		if ok || err != nil {
			return 0, 0, false
		}
		offset = n
		if m[3] != "" {
			pad, _ = strconv.Atoi(m[3])
		}
		ok = true
	}
	return offset, pad, ok
}

// signedOffset renders the offset the way our placeholder wants it: the old
// helper subtracts, so "renumber $1 13" becomes "{episode-13}".
func signedOffset(off int) string {
	switch {
	case off > 0:
		return "-" + strconv.Itoa(off)
	case off < 0:
		return "+" + strconv.Itoa(-off)
	}
	return ""
}

// cleanLegacyPath normalises a Windows-flavoured destination folder and
// substitutes the one template variable the old app allowed in it.
func cleanLegacyPath(p, syncName string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = hbRe.ReplaceAllStringFunc(p, func(s string) string {
		if hbRe.FindStringSubmatch(s)[1] == "$syncName" {
			return syncName
		}
		return ""
	})
	p = winDriveRe.ReplaceAllString(p, "")
	return strings.TrimRight(strings.TrimSpace(p), "/")
}

// commonDirPrefix returns the longest shared directory prefix of the cleaned
// destination folders. With a single entry that is its parent, so the folder
// name itself always survives the remap.
func commonDirPrefix(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	if len(paths) == 1 {
		return path.Dir(paths[0])
	}
	segs := strings.Split(paths[0], "/")
	for _, p := range paths[1:] {
		other := strings.Split(p, "/")
		if len(other) < len(segs) {
			segs = segs[:len(other)]
		}
		for i := range segs {
			if segs[i] != other[i] {
				segs = segs[:i]
				break
			}
		}
	}
	return strings.Join(segs, "/")
}

// remapLocal rebases an old destination folder onto the chosen local root,
// keeping the structure below the shared prefix.
func remapLocal(dest, prefix, root string) string {
	if dest == "" {
		return ""
	}
	if root == "" {
		return dest
	}
	rel := strings.Trim(strings.TrimPrefix(dest, prefix), "/")
	if rel == "" {
		rel = path.Base(dest)
	}
	return path.Join(root, rel)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
