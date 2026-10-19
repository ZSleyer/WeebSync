package api

import (
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// Title collections: an unmarked folder whose subfolders are single titles
// (one show or film each) is what a mark is for, and nothing says so until
// someone marks it. The detection reads the remote index only and judges the
// CHILDREN with the checks the matcher itself applies, so a category root, a
// container of containers, a music or software folder is never suggested.
// Nothing is marked by it.
const (
	collMinChildren = 5  // subfolders a collection has at least
	collTitleShare  = 70 // percent of them that must look like single titles
	collSeasonShare = 50 // percent of season/extras folders that make it a title itself
	collTTL         = 10 * time.Minute
)

// collectionCandidate is one folder the structure speaks for.
type collectionCandidate struct {
	Path    string
	Name    string
	Titles  int
	Total   int
	AltKind string // "anime" when the titles carry anime tags
}

// collectionCache keeps the structural result per server; marks are applied
// when a request reads it, so a new mark takes effect at once.
type collectionCache struct {
	mu sync.Mutex
	by map[int64]collectionEntry
}

type collectionEntry struct {
	at    time.Time
	found []collectionCandidate
}

// indexEntry is one row of a folder's listing in the remote index.
type indexEntry struct {
	name string
	dir  bool
}

// titleDirOK reports whether a folder, by its name and its listing, looks like
// one show or film: a name that can be a title, not a container of several
// other folders, and contents of a title (a season folder, or video files).
func titleDirOK(name string, entries []indexEntry) bool {
	if isHelperDir(name) || seasonDirNameRe.MatchString(name) || hintSeasonDirRe.MatchString(name) {
		return false
	}
	if match.NonTitle(match.ParseName(name, GuessTitle(name), GuessAltTitle(name))) {
		return false
	}
	// the container rule of the matcher (isContainerFolder), on the listing
	titled, videos, season := 0, 0, false
	for _, e := range entries {
		switch {
		case e.dir && seasonSubdirRe.MatchString(e.name):
			season = true
		case e.dir:
			if !hintSeasonDirRe.MatchString(e.name) && !isHelperDir(e.name) {
				titled++
			}
		case transfer.VideoExt[strings.ToLower(path.Ext(e.name))]:
			videos++
		}
	}
	return titled < 3 && (season || videos >= 1)
}

// judgeCollection decides one folder from the names of its subfolders and
// their listings. ok is false when it is not a collection.
func judgeCollection(kids []string, listing map[string][]indexEntry) (titles, total int, anime, ok bool) {
	seasonish := 0
	var titleNames []string
	for _, k := range kids {
		if isHelperDir(k) {
			continue
		}
		total++
		if hintSeasonDirRe.MatchString(k) || seasonDirNameRe.MatchString(k) {
			seasonish++
			continue
		}
		if titleDirOK(k, listing[k]) {
			titles++
			titleNames = append(titleNames, k)
		}
	}
	// its children are its seasons: a title, not a collection
	if total < collMinChildren || seasonish*100 >= total*collSeasonShare || titles*100 < total*collTitleShare {
		return titles, total, false, false
	}
	japanese := 0
	for _, k := range titleNames {
		if hintTierOf(k) == match.HintStrict || hasAnimeSource(k) {
			japanese++
		}
	}
	return titles, total, japanese*100 >= titles*collTitleShare, true
}

// collectionScan finds the folders of a server whose subfolders are titles,
// whatever the marks say (they are applied by the caller).
func (s *Server) collectionScan(serverID int64) ([]collectionCandidate, error) {
	// folders with enough subfolders; the rest cannot be a collection
	dirs, err := s.wideFolders(serverID)
	if err != nil {
		return nil, err
	}

	var out []collectionCandidate
	for _, d := range dirs {
		kids, listing, err := s.collectionListing(serverID, d)
		if err != nil {
			return nil, err
		}
		// a folder that says it holds music, software or notes holds no titles
		if isHelperDir(path.Base(d)) || match.NonVideoFolder(match.ParseName(path.Base(d), GuessTitle(path.Base(d)), GuessAltTitle(path.Base(d)))) {
			continue
		}
		if titles, total, anime, ok := judgeCollection(kids, listing); ok {
			cand := collectionCandidate{Path: d, Name: path.Base(d), Titles: titles, Total: total}
			if anime {
				cand.AltKind = "anime"
			}
			out = append(out, cand)
		}
	}
	return out, nil
}

// wideFolders are the folders with enough subfolders to be a collection, in
// path order; deeper than the crawl goes, nothing below them is listed.
func (s *Server) wideFolders(serverID int64) (dirs []string, err error) {
	rows, err := s.DB.Query(`SELECT parent FROM remote_index WHERE server_id = ? AND is_dir = 1
		GROUP BY parent HAVING COUNT(*) >= ?`, serverID, collMinChildren)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		if strings.Count(p, "/") < crawlMaxDepth {
			dirs = append(dirs, p)
		}
	}
	sort.Strings(dirs)
	return dirs, rows.Err()
}

// collectionListing reads the subfolders of a folder and what each holds.
func (s *Server) collectionListing(serverID int64, dir string) (kids []string, listing map[string][]indexEntry, err error) {
	rows, err := s.DB.Query(`SELECT c.name, g.name, g.is_dir FROM remote_index c
		LEFT JOIN remote_index g ON g.server_id = c.server_id AND g.parent = c.path
		WHERE c.server_id = ? AND c.parent = ? AND c.is_dir = 1`, serverID, dir)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	listing = map[string][]indexEntry{}
	for rows.Next() {
		var c string
		var gn *string
		var gd *int
		if err := rows.Scan(&c, &gn, &gd); err != nil {
			return nil, nil, err
		}
		if _, seen := listing[c]; !seen {
			listing[c] = nil
			kids = append(kids, c)
		}
		if gn != nil && gd != nil {
			listing[c] = append(listing[c], indexEntry{*gn, *gd != 0})
		}
	}
	return kids, listing, rows.Err()
}

// collections is the cached scan of one server.
func (s *Server) collections(serverID int64) ([]collectionCandidate, error) {
	c := &s.collCache
	c.mu.Lock()
	if e, ok := c.by[serverID]; ok && time.Since(e.at) < collTTL {
		c.mu.Unlock()
		return e.found, nil
	}
	c.mu.Unlock()
	found, err := s.collectionScan(serverID)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.by == nil {
		c.by = map[int64]collectionEntry{}
	}
	c.by[serverID] = collectionEntry{time.Now(), found}
	c.mu.Unlock()
	return found, nil
}

// collectionHints lists the user's unmarked folders that look like title
// collections: no row of their own (a stored "none" is a dismissal), no rule,
// and none of the folders above them marked (a mark's titles are matched, what
// lies under them is seasons).
func (s *Server) collectionHints(userID int64) ([]scopeHint, error) {
	list, err := s.userServers(userID)
	if err != nil {
		return nil, err
	}
	out := []scopeHint{}
	for _, v := range list {
		found, err := s.collections(v.id)
		if err != nil {
			return nil, err
		}
		if len(found) == 0 {
			continue
		}
		stored, active, err := s.storedScopes(v.id)
		if err != nil {
			return nil, err
		}
		for _, c := range found {
			if stored[c.Path] || markedAbove(active, c.Path) {
				continue
			}
			if id, _ := s.ruleScope(v.id, c.Path); id != 0 {
				continue
			}
			out = append(out, scopeHint{ServerID: v.id, ServerName: v.name, Path: c.Path, Name: c.Name,
				Kind: scopeAuto, Reason: "collection", Titles: c.Titles, Total: c.Total, AltKind: c.AltKind})
		}
	}
	return out, nil
}

type userServer struct {
	id   int64
	name string
}

func (s *Server) userServers(userID int64) (list []userServer, err error) {
	rows, err := s.DB.Query(`SELECT id, name FROM servers WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v userServer
		if err := rows.Scan(&v.id, &v.name); err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	return list, rows.Err()
}

// storedScopes are the paths with a row in catalog_scopes (a mark or a
// dismissal) and the ones among them that really mark.
func (s *Server) storedScopes(serverID int64) (stored, active map[string]bool, err error) {
	rows, err := s.DB.Query(`SELECT path, kind FROM catalog_scopes WHERE server_id = ?`, serverID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	stored, active = map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var p, k string
		if err := rows.Scan(&p, &k); err != nil {
			return nil, nil, err
		}
		stored[p] = true
		if k != scopeNone {
			active[p] = true
		}
	}
	return stored, active, rows.Err()
}

// markedAbove reports whether a folder lies inside a marked one.
func markedAbove(marks map[string]bool, p string) bool {
	for d := path.Dir(p); d != p; p, d = d, path.Dir(d) {
		if marks[d] {
			return true
		}
	}
	return false
}
