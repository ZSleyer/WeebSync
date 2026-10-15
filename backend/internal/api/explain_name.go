package api

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/relname"
	"github.com/ch4d1/weebsync/internal/rename"
)

// namePiece is one part of a release name and what it means. Start and End
// are UTF-16 offsets, so the browser can slice the string it sent; -1 when
// the value was read but its place in the name is not certain.
type namePiece struct {
	Kind  string `json:"kind" enums:"title,alt,season,final,movie,ova,year,episode,version,group,dub,sub,resolution,tag,extension"`
	Value string `json:"value"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// nameExplainRequest is the body of handleExplainName.
type nameExplainRequest struct {
	Name string `json:"name"`
}

// nameExplainResponse is a name split into its pieces, in name order, plus
// the parse the matcher works with.
type nameExplainResponse struct {
	Pieces []namePiece  `json:"pieces"`
	Parse  explainParse `json:"parse"`
}

// handleExplainName splits a file or folder name into what WeebSync reads
// from it. Text only: nothing is looked up, nothing touches a file system.
//
//	@Summary		Explain a release name
//	@Description	Split a file or folder name into title, season, episode, languages and tags, with positions.
//	@Tags			Catalog
//	@Accept			json
//	@Produce		json
//	@Param			body	body		nameExplainRequest	true	"Name, at most 1 KB"
//	@Success		200		{object}	nameExplainResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		413		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/explain/name [post]
func (s *Server) handleExplainName(w http.ResponseWriter, r *http.Request) {
	var in nameExplainRequest
	if !readJSONLimit(w, r, &in, 2048) {
		return
	}
	if in.Name == "" || len(in.Name) > 1024 || !utf8.ValidString(in.Name) {
		writeErr(w, http.StatusBadRequest, "name must be 1 to 1024 bytes of text")
		return
	}
	writeJSON(w, http.StatusOK, explainName(in.Name))
}

var (
	nameTokenRe = regexp.MustCompile(`[\[(]([^\])]*)[\])]`)
	extRe       = regexp.MustCompile(`\.([A-Za-z0-9]{2,4})$`)
	yearTokRe   = regexp.MustCompile(`^(?:19|20)\d{2}$`)
	sxeRe       = regexp.MustCompile(`(?i)\bS(\d{1,3})(E\d{1,4})(v\d+)?\b`)
)

// explainName does the work of handleExplainName; pure, so it is tested
// without a server.
func explainName(name string) nameExplainResponse {
	info := match.ParseName(name, GuessTitle(name), GuessAltTitle(name))
	out := nameExplainResponse{Parse: explainParse{Title: info.Title, Full: info.Full, Alt: info.Alt, Season: info.Season,
		Final: info.Final, Movie: info.Movie, OVA: info.OVA, Year: info.Year}}
	type span struct {
		kind, value string
		start, end  int // bytes, -1 unknown
	}
	var spans []span
	taken := func(a, b int) bool {
		for _, s := range spans {
			if s.start >= 0 && a < s.end && b > s.start {
				return true
			}
		}
		return false
	}
	put := func(kind, value string, a, b int) {
		// a span that does not cut the name on rune boundaries is kept as a
		// value without a place rather than sliced into broken text
		if a >= 0 && (a > b || b > len(name) || !utf8.ValidString(name[a:b])) {
			a, b = -1, -1
		}
		if a >= 0 && taken(a, b) {
			return
		}
		spans = append(spans, span{kind, value, a, b})
	}
	// bracket groups first: every comma token in them is a tag of some kind
	for _, g := range nameTokenRe.FindAllStringSubmatchIndex(name, -1) {
		inner, off := name[g[2]:g[3]], g[2]
		for _, tok := range strings.Split(inner, ",") {
			lead := len(tok) - len(strings.TrimLeft(tok, " "))
			t := strings.TrimSpace(tok)
			a := off + lead
			off += len(tok) + 1
			if t == "" {
				continue
			}
			dub, sub := rename.LangTags("[" + t + "]")
			switch {
			case dub != "":
				put("dub", dub, a, a+len(t))
			case sub != "":
				put("sub", sub, a, a+len(t))
			case rename.Resolution("["+t+"]") > 0:
				put("resolution", strconv.Itoa(rename.Resolution("["+t+"]")), a, a+len(t))
			case info.Alt != "" && t == info.Alt:
				put("alt", t, a, a+len(t))
			case yearTokRe.MatchString(t):
				put("year", t, a, a+len(t))
			default:
				put("tag", t, a, a+len(t))
			}
		}
	}
	for _, m := range match.Marks(name) {
		put(m.Kind, m.Value, m.Start, m.End)
	}
	p := relname.Read(name)
	if m := extRe.FindStringSubmatchIndex(name); m != nil && p.Ext != "" {
		put("extension", name[m[2]:m[3]], m[2], m[3])
	}
	if p.Group != "" {
		if i := strings.Index(name, "["+p.Group+"]"); i >= 0 {
			// the group's bracket was read as a plain tag above
			for k := range spans {
				if spans[k].start == i+1 && spans[k].kind == "tag" {
					spans[k].kind = "group"
				}
			}
		}
	}
	// "S03E01v2": season, episode and version in one word
	if m := sxeRe.FindStringSubmatchIndex(name); m != nil {
		n, _ := strconv.Atoi(name[m[2]:m[3]])
		put("season", strconv.Itoa(n), m[0], m[3])
		put("episode", strings.TrimLeft(name[m[4]+1:m[5]], "0"), m[4], m[5])
		if m[6] >= 0 {
			put("version", name[m[6]+1:m[7]], m[6], m[7])
		}
	} else if ep := p.Episode(); ep != "" {
		re := regexp.MustCompile(`(?i)(?:\bE|\bEP|\bEpisode\s?|\s-\s)0*` + regexp.QuoteMeta(strings.TrimLeft(ep, "0")) + `(v\d+)?\b`)
		if loc := re.FindStringSubmatchIndex(name); loc != nil {
			end := loc[1]
			if loc[2] >= 0 {
				end = loc[2]
				put("version", name[loc[2]+1:loc[3]], loc[2], loc[3])
			}
			start := loc[0]
			if name[start] == ' ' {
				start += 3 // " - 07": the dash is a separator, not the number
			}
			put("episode", ep, start, end)
		} else {
			put("episode", ep, -1, -1)
		}
	}
	if info.Title != "" {
		// case-blind search on the name itself: lowering both sides first can
		// change byte lengths ("İ") and the offsets would miss the original
		if loc := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(info.Title)).FindStringIndex(name); loc != nil {
			put("title", info.Title, loc[0], loc[1])
		} else {
			put("title", info.Title, -1, -1)
		}
	}
	if info.Alt != "" {
		if i := strings.Index(name, info.Alt); i >= 0 {
			put("alt", info.Alt, i, i+len(info.Alt))
		}
	}
	sort.SliceStable(spans, func(a, b int) bool {
		if (spans[a].start < 0) != (spans[b].start < 0) {
			return spans[a].start >= 0
		}
		return spans[a].start < spans[b].start
	})
	out.Pieces = make([]namePiece, 0, len(spans))
	for _, s := range spans {
		a, b := -1, -1
		if s.start >= 0 {
			a, b = u16(name, s.start), u16(name, s.end)
		}
		out.Pieces = append(out.Pieces, namePiece{Kind: s.kind, Value: s.value, Start: a, End: b})
	}
	return out
}

// u16 converts a byte offset in s to a UTF-16 offset, the unit JavaScript
// strings count in.
func u16(s string, byteOff int) int {
	return len(utf16.Encode([]rune(s[:byteOff])))
}
