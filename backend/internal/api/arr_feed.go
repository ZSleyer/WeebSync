package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/rename"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// arrFile is one remote video the catalog can place: the file and what its
// folder was matched to.
type arrFile struct {
	serverID int64
	path     string
	size     int64
	modTime  string
	folder   string
	season   int // the folder's season, 0 = unknown or a movie
	resRank  int // the folder's measured resolution, the fallback for the name
	showKey  string
	seriesID int64
	isMovie  bool
}

// arrRelease is a file as the feed shows it.
type arrRelease struct {
	arrFile
	guid    string
	title   string
	se, ep  int // the episode the title names; ep 0 for a movie
	absNum  int // absolute number when the title carries that instead of SxxEyy
	tvdbID  int // from the show key
	tmdbID  int // movies
	pubDate time.Time
}

// arrFiles lists the remote videos directly inside matched remote folders,
// newest first. where narrows the catalog_variants rows (alias cv).
//
// ponytail: direct children only - a show folder holding Season subfolders
// is reached through the season folders the catalog matched on their own
func (s *Server) arrFiles(where string, limit int, args ...any) []arrFile {
	q := `SELECT ri.server_id, ri.path, ri.size, ri.mod_time, cv.folder, cv.season, cv.res_rank, cv.show_key, cv.series_id, cv.is_movie
		FROM catalog_variants cv
		JOIN remote_index ri ON ri.server_id = cv.server_id AND ri.parent = cv.folder AND ri.is_dir = 0
		WHERE cv.server_id > 0 AND ` + where + `
		ORDER BY ri.mod_time DESC LIMIT ?`
	rows, err := s.DB.Query(q, append(args, limit)...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []arrFile
	for rows.Next() {
		var f arrFile
		if rows.Scan(&f.serverID, &f.path, &f.size, &f.modTime, &f.folder, &f.season, &f.resRank, &f.showKey, &f.seriesID, &f.isMovie) != nil {
			continue
		}
		if transfer.VideoExt[strings.ToLower(path.Ext(f.path))] {
			out = append(out, f)
		}
	}
	if rows.Err() != nil {
		return nil
	}
	return out
}

// arrSeriesTitle is the name the apps know a show by: the English title when
// the series has one, else its canonical title, else the folder's guess.
func (s *Server) arrSeriesTitle(seriesID int64, folder string) (title string, year int) {
	if seriesID > 0 {
		// a failed lookup falls through to the folder's guess below
		_ = s.DB.QueryRow(`SELECT title, year FROM series WHERE id = ?`, seriesID).Scan(&title, &year)
		var en string
		_ = s.DB.QueryRow(`SELECT title FROM series_titles WHERE series_id = ? AND locale = 'en' ORDER BY source LIMIT 1`, seriesID).Scan(&en)
		if en != "" {
			title = en
		}
	}
	if title == "" {
		title = match.GuessTitle(path.Base(folder))
	}
	return title, year
}

// langWords turns a dub tag ("GerJapDub") into the words the apps read
// languages from: "German DL" for a dub beside the original Japanese, else
// the languages by name. "" when the tag names none it knows.
func langWords(dub string) string {
	names := map[string]string{"Ger": "German", "Jap": "Japanese", "Jpn": "Japanese", "Eng": "English",
		"Fre": "French", "Fra": "French", "Spa": "Spanish", "Ita": "Italian", "Por": "Portuguese",
		"Rus": "Russian", "Kor": "Korean", "Chi": "Chinese"}
	var words []string
	jap := false
	for _, code := range langCodeRe.FindAllString(dub, -1) {
		n, ok := names[code]
		switch {
		case !ok:
		case n == "Japanese":
			jap = true
		default:
			words = append(words, n)
		}
	}
	switch {
	case len(words) == 0 && jap:
		return "Japanese"
	case len(words) == 1 && jap:
		return words[0] + " DL" // dual language: this one plus the original
	default:
		return strings.Join(words, " ")
	}
}

var langCodeRe = regexp.MustCompile(`[A-Z][a-z]+`)

// sceneLangRe finds the language words of scene-style names
// ("Movie.2001.GERMAN.DL.1080p"), which carry no [GerDub] tag.
var sceneLangRe = regexp.MustCompile(`(?i)(?:^|[ ._\[(-])(german|english|japanese)(?:[ ._](dl))?(?:[ ._\])-]|$)`)

func sceneLang(name string) string {
	m := sceneLangRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	word := strings.ToUpper(m[1][:1]) + strings.ToLower(m[1][1:])
	if m[2] != "" {
		word += " DL"
	}
	return word
}

// sourceWord guesses the release source from the remote path. Web releases
// are what such servers carry, so a name that says nothing is one.
func sourceWord(p string) string {
	l := strings.ToLower(p)
	switch {
	case strings.Contains(l, "bluray"), strings.Contains(l, "blu-ray"), strings.Contains(l, "bdrip"),
		strings.Contains(l, "[bd"), strings.Contains(l, "bd]"), strings.Contains(l, " bd "):
		return "BluRay"
	case strings.Contains(l, "dvd"):
		return "DVD"
	case strings.Contains(l, "hdtv"), strings.Contains(l, "tvrip"):
		return "HDTV"
	}
	return "WEB-DL"
}

var arrGroupRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._&]*$`)

// releaseGroup is the file's own group, which the apps keep for
// {Release Group}; WeebSync when the name has none, or one they would not
// read back as a group after the dash (spaces, dashes, several groups).
func releaseGroup(name string) string {
	if g := rename.Group(name); arrGroupRe.MatchString(g) {
		return g
	}
	return "WeebSync"
}

// arrReleaseOf names one remote file the way Sonarr/Radarr parse release
// titles: "<Show> S02E02 German DL GerEngSub 1080p WEB-DL-WeebSync", or for a
// movie "<Title> (2001) German DL 1080p WEB-DL-WeebSync". ok=false for a file
// it cannot place (no episode number, a fractional special).
//
// The raw names of anime releases do not work for this: "Show S2 - 02" reads
// as absolute episode 2, and their language tags as nothing at all.
func (s *Server) arrReleaseOf(f arrFile) (arrRelease, bool) {
	r := arrRelease{arrFile: f}
	name := path.Base(f.path)
	title, year := s.arrSeriesTitle(f.seriesID, f.folder)
	kind, id, _ := strings.Cut(f.showKey, ":")
	n, _ := strconv.Atoi(id)
	switch kind {
	case "tvdb":
		r.tvdbID = n
	case "tmdb":
		if f.isMovie {
			r.tmdbID = n
		}
	}

	var head string
	if f.isMovie {
		head = title
		if year > 0 {
			head += fmt.Sprintf(" (%d)", year)
		}
	} else {
		season := f.season
		if p := match.ParseName(path.Base(f.folder), "", "").Season; p > 0 {
			season = p // a folder that names its season is believed, as in folderTarget
		}
		if m := epSeasonRe.FindStringSubmatch(name); m != nil {
			r.se, _ = strconv.Atoi(m[1])
			r.ep, _ = strconv.Atoi(m[2])
		} else {
			tok := parseEpisodeToken(name)
			num, err := strconv.Atoi(tok)
			if err != nil || num <= 0 {
				return r, false // no number, or a ".5" special the apps cannot place
			}
			// ponytail: a long runner numbers its files absolutely (Conan 1187)
			// in a folder the catalog calls season 1; leave the mapping to the
			// app (anime series map absolute numbers themselves). A season
			// folder numbering absolutely below 100 is read as relative.
			if season <= 0 || (season == 1 && num >= 100) {
				r.absNum = num
			} else {
				r.se, r.ep = season, num
			}
		}
		if r.absNum > 0 {
			head = fmt.Sprintf("%s - %03d", title, r.absNum)
		} else {
			head = fmt.Sprintf("%s S%02dE%02d", title, r.se, r.ep)
		}
	}

	dub, sub := rename.PathLangTags(f.path)
	res := rename.Resolution(name)
	if res == 0 {
		res = f.resRank
	}
	lang := langWords(dub)
	if lang == "" {
		lang = sceneLang(name)
	}
	parts := []string{head, lang}
	if sub != "" {
		parts = append(parts, sub)
	}
	if res > 0 {
		parts = append(parts, strconv.Itoa(res)+"p")
	}
	parts = append(parts, sourceWord(f.path)+"-"+releaseGroup(name))
	var b strings.Builder
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(p)
		}
	}
	r.title = b.String()
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d\x00%s\x00%d", f.serverID, f.path, f.size)))
	r.guid = hex.EncodeToString(sum[:12])
	r.pubDate, _ = time.Parse(sqliteTime, f.modTime)
	if r.pubDate.IsZero() {
		r.pubDate = time.Now()
	}
	return r, true
}

// handleNewznab is the indexer: caps, TV search (by TVDB id, or the newest
// files as the RSS feed the apps poll), movie search by TMDB id, and the nzb
// a grab downloads. Mounted behind arrGate.
func (s *Server) handleNewznab(w http.ResponseWriter, r *http.Request) {
	switch r.FormValue("t") {
	case "caps":
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprint(w, newznabCaps)
	case "tvsearch":
		s.newznabFeed(w, r, false)
	case "search":
		// a plain search names no kind; the categories asked for do
		s.newznabFeed(w, r, movieCats(r.FormValue("cat")))
	case "movie":
		s.newznabFeed(w, r, true)
	case "get":
		s.newznabNzb(w, r)
	default:
		newznabError(w, 202, "no such function")
	}
}

const newznabCaps = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="WeebSync"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,tvdbid,season,ep"/>
    <movie-search available="yes" supportedParams="q,tmdbid"/>
  </searching>
  <categories>
    <category id="2000" name="Movies"/>
    <category id="5000" name="TV">
      <subcat id="5040" name="HD"/>
      <subcat id="5070" name="Anime"/>
    </category>
  </categories>
</caps>
`

// movieCats reports whether a category list asks for movies only (2xxx).
func movieCats(cat string) bool {
	if cat == "" {
		return false
	}
	for _, c := range strings.Split(cat, ",") {
		if !strings.HasPrefix(strings.TrimSpace(c), "2") {
			return false
		}
	}
	return true
}

func newznabError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><error code="%d" description="%s"/>`, code, xmlText(msg))
}

func xmlText(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

// newznabFeed answers a search. Without an id or a query it is the RSS sync:
// the newest files of every matched folder, paged by offset. A text query
// finds the shows whose title or folder carries its words; the app parses
// the synthetic names against the series it asked for, so a loose title
// match grabs nothing wrong.
func (s *Server) newznabFeed(w http.ResponseWriter, r *http.Request, movie bool) {
	limit := 100
	if l, err := strconv.Atoi(r.FormValue("limit")); err == nil && l > 0 && l < limit {
		limit = l
	}
	offset, _ := strconv.Atoi(r.FormValue("offset"))
	offset = min(max(offset, 0), 10000)
	wantSe, _ := strconv.Atoi(r.FormValue("season"))
	wantEp, _ := strconv.Atoi(r.FormValue("ep"))
	wantNum := 0
	var files []arrFile
	switch {
	case movie && r.FormValue("tmdbid") != "":
		id, _ := strconv.Atoi(r.FormValue("tmdbid"))
		files = s.arrFiles(`cv.is_movie = 1 AND (cv.show_key = ? OR (cv.series_id > 0 AND cv.series_id IN
			(SELECT series_id FROM series_provider WHERE source = 'tmdb:movie' AND media_id = ?)))`, limit, "tmdb:"+strconv.Itoa(id), id)
	case !movie && r.FormValue("tvdbid") != "":
		id, _ := strconv.Atoi(r.FormValue("tvdbid"))
		// a search for one episode reads every file of the show: the
		// episode is only known after naming, so the cap is generous
		files = s.arrFiles(`cv.is_movie = 0 AND (cv.show_key = ? OR (cv.series_id > 0 AND cv.series_id IN
			(SELECT series_id FROM series_provider WHERE source = 'tvdb' AND media_id = ?)))`, 2000, "tvdb:"+strconv.Itoa(id), id)
	case r.FormValue("q") != "":
		kind := "cv.is_movie = 0 AND "
		switch {
		case movie:
			kind = "cv.is_movie = 1 AND "
		case r.FormValue("t") == "search" && anyMovieCat(r.FormValue("cat")):
			kind = "" // a plain search over TV and movie categories wants both
		}
		byTitle := func(words []string) []arrFile {
			like := "%" + strings.Join(words, "%") + "%"
			return s.arrFiles(kind+`(cv.folder LIKE ? OR (cv.series_id > 0 AND (
				cv.series_id IN (SELECT id FROM series WHERE title LIKE ?) OR
				cv.series_id IN (SELECT series_id FROM series_titles WHERE title LIKE ?))))`, 2000+offset, like, like, like)
		}
		all, words, se, ep, num := splitArrQuery(r.FormValue("q"))
		// the whole query first: in "Mob Psycho 100" the number is the title
		if len(all) > 0 {
			files = byTitle(all)
		}
		if len(files) == 0 && len(words) < len(all) {
			files = byTitle(words)
			if se > 0 {
				wantSe, wantEp = se, ep
			}
			wantNum = num
		}
	case r.FormValue("imdbid") == "":
		// ponytail: twice the page, as files without an episode number drop
		// out after naming and a short page would end the app's paging
		n := 2 * (offset + limit)
		if movie {
			// every matched film, not only those with a TMDB id: Radarr reads
			// a film in the feed by title and year, and a new anime film is
			// matched long before the id lists carry its TMDB id
			files = s.arrFiles(`cv.is_movie = 1 AND cv.show_key != ''`, n)
		} else {
			files = s.arrFiles(`cv.is_movie = 0 AND cv.show_key LIKE 'tvdb:%'`, n)
		}
	}

	base := arrBaseURL(r)
	key := r.URL.Query().Get("apikey")
	var items strings.Builder
	n := 0
	for _, f := range files {
		rel, ok := s.arrReleaseOf(f)
		if !ok {
			continue
		}
		// an absolutely numbered release cannot be told apart here; the app
		// maps it and drops what it did not ask for
		if rel.absNum == 0 && ((wantSe > 0 && rel.se != wantSe) || (wantEp > 0 && rel.ep != wantEp)) {
			continue
		}
		// "Show 05" from an anime search names the absolute number or the
		// episode within the season; a film's number is its year
		if wantNum > 0 && !rel.isMovie && rel.absNum != wantNum && rel.ep != wantNum {
			continue
		}
		if n++; n > offset+limit {
			break
		}
		if n <= offset {
			continue
		}
		// only offer what can be looked up again: the grab names nothing but
		// the guid
		if _, err := s.DB.Exec(`INSERT INTO arr_releases (guid, server_id, remote_path, size, title) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(guid) DO UPDATE SET title = excluded.title, seen_at = datetime('now')`,
			rel.guid, rel.serverID, rel.path, rel.size, rel.title); err != nil {
			slog.Warn("arr release not recorded", "err", err)
			continue
		}
		writeNewznabItem(&items, rel, base, key)
	}
	// releases the feed has not shown for a month cannot still be grabbed
	// housekeeping: the next feed request prunes again
	_, _ = s.DB.Exec(`DELETE FROM arr_releases WHERE seen_at < datetime('now', '-30 days')`)

	w.Header().Set("Content-Type", "application/rss+xml")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel><title>WeebSync</title><description>WeebSync remote files</description>
<newznab:response offset="%d" total="%d"/>
%s</channel></rss>
`, offset, n, items.String())
}

var (
	arrQuerySeRe  = regexp.MustCompile(`^s(\d{1,2})(?:e(\d{1,4}))?$`)
	arrQueryNumRe = regexp.MustCompile(`^e?(\d{1,4})$`)
)

// splitArrQuery reads a text search the way the apps write one: the title
// words, lowercased, then an optional "S02", "S02E01" or bare episode number
// ("05"). all is every word, words the title without that tail. A lone number
// stays the title, there is a show called 86.
func splitArrQuery(q string) (all, words []string, se, ep, num int) {
	all = strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	if len(all) < 2 {
		return all, all, 0, 0, 0
	}
	last, head := all[len(all)-1], all[:len(all)-1]
	if m := arrQuerySeRe.FindStringSubmatch(last); m != nil {
		se, _ = strconv.Atoi(m[1])
		ep, _ = strconv.Atoi(m[2])
		return all, head, se, ep, 0
	}
	if m := arrQueryNumRe.FindStringSubmatch(last); m != nil {
		num, _ = strconv.Atoi(m[1])
		return all, head, 0, 0, num
	}
	return all, all, 0, 0, 0
}

// anyMovieCat reports whether a category list includes movies (2xxx); no
// list at all includes everything.
func anyMovieCat(cat string) bool {
	if cat == "" {
		return true
	}
	for _, c := range strings.Split(cat, ",") {
		if strings.HasPrefix(strings.TrimSpace(c), "2") {
			return true
		}
	}
	return false
}

func writeNewznabItem(b *strings.Builder, rel arrRelease, base, key string) {
	link := base + "/api/arr/newznab/api?t=get&id=" + rel.guid + "&apikey=" + url.QueryEscape(key)
	cats := []string{"5000", "5040", "5070"}
	if rel.isMovie {
		cats = []string{"2000"}
	}
	fmt.Fprintf(b, "<item><title>%s</title><guid isPermaLink=\"false\">%s</guid><link>%s</link><pubDate>%s</pubDate>",
		xmlText(rel.title), rel.guid, xmlText(link), rel.pubDate.UTC().Format(time.RFC1123Z))
	fmt.Fprintf(b, "<enclosure url=\"%s\" length=\"%d\" type=\"application/x-nzb\"/>", xmlText(link), rel.size)
	for _, c := range cats {
		fmt.Fprintf(b, "<category>%s</category><newznab:attr name=\"category\" value=\"%s\"/>", c, c)
	}
	attr := func(name string, v int) {
		if v > 0 {
			fmt.Fprintf(b, "<newznab:attr name=\"%s\" value=\"%d\"/>", name, v)
		}
	}
	fmt.Fprintf(b, "<newznab:attr name=\"size\" value=\"%d\"/>", rel.size)
	attr("tvdbid", rel.tvdbID)
	attr("tmdbid", rel.tmdbID)
	attr("season", rel.se)
	attr("episode", rel.ep)
	b.WriteString("</item>\n")
}

// arrBaseURL is how the app reached us, so the links it follows go back the
// same way (a LAN address, not the public base URL).
func arrBaseURL(r *http.Request) string {
	// the forwarded scheme counts only from a trusted proxy, like everywhere
	scheme := "http"
	if auth.ArrivedOverHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// newznabNzb hands out the nzb of a release: a stub carrying nothing but the
// guid, which the app passes on to the download client unread.
func (s *Server) newznabNzb(w http.ResponseWriter, r *http.Request) {
	guid := r.FormValue("id")
	var title string
	var size int64
	if err := s.DB.QueryRow(`SELECT title, size FROM arr_releases WHERE guid = ?`, guid).Scan(&title, &size); err == sql.ErrNoRows || title == "" {
		newznabError(w, 300, "no such release")
		return
	}
	w.Header().Set("Content-Type", "application/x-nzb")
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(title, `"`, "")+`.nzb"`)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
<head><meta type="name">%s</meta><meta type="weebsync-guid">%s</meta></head>
<file poster="WeebSync" date="%d" subject="%s"><groups><group>alt.binaries.weebsync</group></groups>
<segments><segment bytes="%d" number="1">%s@weebsync</segment></segments></file>
</nzb>
`, xmlText(title), guid, time.Now().Unix(), xmlText(title), size, guid)
}
