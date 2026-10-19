package api

import (
	"encoding/json"
	"log/slog"
	"time"
)

// plexPathNotesKey is where the media-server index leaves, per pseudo folder
// ("plex:{ratingKey}:s{N}"), the path the server reported for a copy this
// instance cannot reach. The sync plan reads it to say WHICH path needs a
// mapping. The key sits under the "plex:" cache prefix, so a media-server
// reset drops it and the next index writes it again.
const plexPathNotesKey = "plex:pathnotes:v1"

// plexPathNote is what the index learned about a copy it could not read from
// disk: the folder the media server reports, and whether a path mapping was
// applied to it already (then the mapping points at a folder that is not
// there, rather than being absent).
type plexPathNote struct {
	Path   string `json:"path"`
	Mapped bool   `json:"mapped,omitempty"`
}

// planNotes turns an empty SyncPlan into an explained one. The zero value
// explains nothing beyond the reason code the plan already carries.
type planNotes struct {
	m     map[string]plexPathNote
	admin bool
}

// planNotesFor loads the recorded notes for one viewer. Only admins get the
// path itself: they are the ones who can change the mapping, and the path is
// infrastructure detail nobody else needs.
func (s *Server) planNotesFor(userID int64) planNotes {
	var admin bool
	// a failed read means not admin: the path stays hidden
	_ = s.DB.QueryRow(`SELECT is_admin FROM users WHERE id = ?`, userID).Scan(&admin)
	n := planNotes{admin: admin}
	if raw, ok := s.cacheGet(plexPathNotesKey, 365*24*time.Hour); ok {
		if err := json.Unmarshal([]byte(raw), &n.m); err != nil {
			slog.Warn("media server path notes unreadable", "err", err)
			n.m = nil
		}
	}
	return n
}

// storePlexPathNotes replaces the recorded paths with those of a complete index run.
func (s *Server) storePlexPathNotes(m map[string]plexPathNote) {
	if m == nil {
		m = map[string]plexPathNote{}
	}
	b, err := json.Marshal(m)
	if err != nil {
		slog.Warn("media server path notes not saved", "err", err)
		return
	}
	s.cacheSet(plexPathNotesKey, string(b))
}

// explain adds to an empty plan what is known about the copy in folder: the
// reason refined to "not_found" when a mapping applies, and (for admins) the
// path the media server reports.
func (n planNotes) explain(p SyncPlan, folder string) SyncPlan {
	if p.LocalPath != "" || p.Missing != planMissingUnmapped {
		return p
	}
	if note, ok := n.m[folder]; ok {
		if n.admin {
			p.ServerPath = note.Path
		}
		if note.Mapped {
			p.Missing = planMissingNotFound
		}
	}
	return p
}
