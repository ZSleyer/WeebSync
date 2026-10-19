package api

import (
	"database/sql"
	"errors"
)

// Detected marks: a folder mark WeebSync sets itself because the structure
// speaks for it (auto_marks.go). It is an ordinary row of catalog_scopes with
// detected_at set; every write by a user goes through handleCatalogScope, which
// stores a row with detected_at 0, so what a user decided is never mistaken
// for a detection and detection never writes over an existing row.

// detectedAt is when WeebSync marked a folder, in Unix milliseconds; 0 when
// the folder has no row or the mark is a user's.
func (s *Server) detectedAt(serverID int64, p string) (int64, error) {
	var at int64
	err := s.DB.QueryRow(`SELECT detected_at FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, p).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return at, err
}
