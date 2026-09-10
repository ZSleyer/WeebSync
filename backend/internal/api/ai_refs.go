package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
)

// The model never sees a server id, a remote path or a local mount. Every
// folder a tool hands it travels as an opaque ref plus the folder's own name
// (the last path segment - that is the title the search matched on, and the
// only part that means anything to the model), and propose resolves the ref
// back to the server and path here. A path the model made up cannot be
// resolved, so nothing the model says can point the app at a folder a tool
// never showed it.

// aiRefKey is the ref one folder gets for one user; pure, so a caller can
// name a ref before it exists.
func aiRefKey(userID, serverID int64, p string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d|%d|%s", userID, serverID, p)))
	return "f" + hex.EncodeToString(sum[:5])
}

// aiRefFor mints (or re-uses) the ref of one folder for this user.
func (s *Server) aiRefFor(userID, serverID int64, p string) string {
	ref := aiRefKey(userID, serverID, p)
	// ponytail: one row per folder ever surfaced, never swept; the catalog
	// bounds it. Add a created_at sweep if the table ever matters.
	s.DB.Exec(`INSERT OR IGNORE INTO ai_refs (ref, user_id, server_id, path) VALUES (?, ?, ?, ?)`, ref, userID, serverID, p)
	return ref
}

// aiDeref resolves a ref the user's tools handed out; false for anything else.
func (s *Server) aiDeref(userID int64, ref string) (serverID int64, p string, ok bool) {
	if err := s.DB.QueryRow(`SELECT server_id, path FROM ai_refs WHERE ref = ? AND user_id = ?`, ref, userID).Scan(&serverID, &p); err != nil {
		return 0, "", false
	}
	return serverID, p, true
}

// aiName is what the model gets to see of a path.
func aiName(p string) string { return path.Base(p) }

// aiLocalName is the same for a library folder, whose last segment is often
// just "Season 1": the show's folder above it comes along, nothing more.
func aiLocalName(p string) string {
	if dir := path.Dir(p); dir != "/" && dir != "." {
		return path.Base(dir) + "/" + path.Base(p)
	}
	return path.Base(p)
}
