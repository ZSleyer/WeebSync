package api

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/match"
)

// Automatic marks. Two things say a folder wants a mark before anyone has
// marked it: its subfolders are single titles (collection_hints.go), or it
// has the name shape of marked siblings, a new season folder beside last
// season's. WeebSync marks such a folder itself, in the background, and the
// user steps in only when it is wrong: any change, "none" or removal of the
// mark is the user's decision and is never written over (detected_marks.go).
//
// The marks the user made stay as they are. Nothing is marked inside a marked
// folder (its subfolders are seasons or versions of one title), nor above one
// (a mark below already speaks for that part of the tree), nor where a row
// exists at all: a stored "none" is the user's "not this one".

// autoMarkBatch caps the marks one run sets per server. Every mark queues the
// matching of its subfolders, which the providers' rate limits then pace.
const autoMarkBatch = 5

// markCandidate is a folder the structure speaks for.
type markCandidate struct {
	Path   string
	Name   string
	Kind   string // the mark it would get: the sibling's, "auto" for a collection
	Reason string // "sibling" | "collection"
}

// markState is the marks of one server, kept current while a run sets several.
type markState struct {
	stored map[string]bool // paths with a row: a mark or a "none"
	active map[string]bool // paths with a real mark
}

// blocks reports whether a folder may not be marked: it has a row, lies in a
// marked folder, or has a marked folder below.
func (m markState) blocks(p string) bool {
	if m.stored[p] || markedAbove(m.active, p) {
		return true
	}
	below := strings.TrimSuffix(p, "/") + "/"
	for a := range m.active {
		if strings.HasPrefix(a, below) {
			return true
		}
	}
	return false
}

func (m markState) add(p string) {
	m.stored[p] = true
	m.active[p] = true
}

// siblingCandidates are the unmarked folders whose name has the shape of a
// marked sibling's (numbers and season names vary), not covered by a scope
// rule. Siblings that disagree on the kind give no guess.
func (s *Server) siblingCandidates(serverID int64) ([]markCandidate, error) {
	rows, err := s.DB.Query(`SELECT path, kind FROM catalog_scopes WHERE server_id = ? AND kind != ?`, serverID, scopeNone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type mark struct{ kind string }
	byParent := map[string]map[string]mark{} // parent -> shape -> mark; "" kind = siblings disagree
	for rows.Next() {
		var p, kind string
		if err := rows.Scan(&p, &kind); err != nil {
			return nil, err
		}
		parent, shape := path.Dir(p), folderShape(path.Base(p))
		if parent == p || !shapeVaries(shape) {
			continue
		}
		if byParent[parent] == nil {
			byParent[parent] = map[string]mark{}
		}
		if m, ok := byParent[parent][shape]; ok && m.kind != kind {
			byParent[parent][shape] = mark{}
		} else if !ok {
			byParent[parent][shape] = mark{kind}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []markCandidate
	for parent, shapes := range byParent {
		kids, err := s.unmarkedChildren(serverID, parent)
		if err != nil {
			return nil, err
		}
		for _, k := range kids {
			m, ok := shapes[folderShape(k.name)]
			if !ok || m.kind == "" || isHelperDir(k.name) || match.NonVideoFolder(match.ParseName(k.name, GuessTitle(k.name), GuessAltTitle(k.name))) {
				continue
			}
			if id, _ := s.ruleScope(serverID, k.path); id != 0 {
				continue
			}
			out = append(out, markCandidate{Path: k.path, Name: k.name, Kind: m.kind, Reason: "sibling"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// unmarkedChildren are the indexed subfolders of a folder without a row in
// catalog_scopes, by name.
func (s *Server) unmarkedChildren(serverID int64, parent string) (out []sweepChild, err error) {
	rows, err := s.DB.Query(`SELECT ri.path, ri.name FROM remote_index ri
		WHERE ri.server_id = ? AND ri.parent = ? AND ri.is_dir = 1
		  AND NOT EXISTS (SELECT 1 FROM catalog_scopes cs WHERE cs.server_id = ri.server_id AND cs.path = ri.path)
		ORDER BY ri.name`, serverID, parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c sweepChild
		if err := rows.Scan(&c.path, &c.name); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// selectAutoMarks lists the folders of a server that get a mark now, at most
// limit (0 = all), siblings of marked folders before collections, each in path
// order. A folder picked counts as marked for the ones after it.
func (s *Server) selectAutoMarks(serverID int64, limit int) ([]markCandidate, error) {
	siblings, err := s.siblingCandidates(serverID)
	if err != nil {
		return nil, err
	}
	found, err := s.collections(serverID)
	if err != nil {
		return nil, err
	}
	cands := siblings
	for _, c := range found {
		cands = append(cands, markCandidate{Path: c.Path, Name: c.Name, Kind: scopeAuto, Reason: "collection"})
	}
	stored, active, err := s.storedScopes(serverID)
	if err != nil {
		return nil, err
	}
	state := markState{stored, active}
	var out []markCandidate
	for _, c := range cands {
		if state.blocks(c.Path) {
			continue
		}
		if id, _ := s.ruleScope(serverID, c.Path); id != 0 {
			continue
		}
		state.add(c.Path)
		out = append(out, c)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

// detectMarks marks the folders of one server the structure speaks for and
// queues the matching of their subfolders, as a mark set by hand does. Where a
// row appeared in the meantime (the user was faster) nothing is written.
// Reports the folders marked and the subfolders queued for matching.
func (s *Server) detectMarks(ctx context.Context, serverID int64) (marked, queued int) {
	if serverID == localServerID || s.matchingOff() {
		return 0, 0 // the local library has no index; with matching off a mark does nothing
	}
	picks, err := s.selectAutoMarks(serverID, autoMarkBatch)
	if err != nil {
		slog.Warn("auto marks: reading the index failed", "server", serverID, "err", err)
		return 0, 0
	}
	for _, c := range picks {
		if ctx.Err() != nil {
			return marked, queued
		}
		res, err := s.DB.Exec(`INSERT OR IGNORE INTO catalog_scopes (server_id, path, kind, detected_at) VALUES (?, ?, ?, ?)`,
			serverID, c.Path, c.Kind, time.Now().UnixMilli())
		if err != nil {
			slog.Warn("auto marks: storing a mark failed", "server", serverID, "path", logSafe(c.Path), "err", err)
			return marked, queued
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		n := s.queueScopeChildren(serverID, c.Path, c.Kind)
		marked++
		queued += n
		slog.Info("auto marks: marked a folder", "server", serverID, "path", logSafe(c.Path),
			"kind", c.Kind, "reason", c.Reason, "queued", n)
	}
	return marked, queued
}

// detectMarksJob starts the detection for a server as a background job, one
// at a time per server.
func (s *Server) detectMarksJob(serverID int64) {
	s.runJob(fmt.Sprintf("marks:detect:%d", serverID), func(ctx context.Context) { _, _ = s.detectMarks(ctx, serverID) })
}
