package api

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// A match the rules refuse but that could not be rewritten is still filed
// under the wrong show; the rule set must not be stamped as applied, or no
// later start would look at it again.
func TestRevalidateMatchesRetriesWhenDropFails(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	m := anilist.Media{ID: 21, SeasonYear: 1999, Format: "TV", Status: "FINISHED", Schema: anilist.MediaSchema}
	m.Title.Romaji, m.Title.English = "One Piece", "One Piece"
	b, _ := json.Marshal(m)
	s.cacheSet(fmt.Sprintf("media:%d", 21), string(b))
	if err := s.persistMatch(1, "/x/One Piece (2022)", 21, false, "anilist"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`CREATE TRIGGER no_drop BEFORE INSERT ON catalog_matches
		WHEN NEW.media_id = 0 BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	s.RevalidateMatches()
	if db.Setting(s.DB, "match_rules") == matchRules {
		t.Fatal("rule set stamped although a stale match could not be dropped")
	}
	if _, err := s.DB.Exec(`DROP TRIGGER no_drop`); err != nil {
		t.Fatal(err)
	}
	s.RevalidateMatches()
	var id int
	if err := s.DB.QueryRow(`SELECT media_id FROM catalog_matches WHERE folder = '/x/One Piece (2022)'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id != 0 {
		t.Errorf("the retry left media %d", id)
	}
	if db.Setting(s.DB, "match_rules") != matchRules {
		t.Error("rule set not stamped after a clean pass")
	}
}

// A failed duplicate check must be reported, not read as "no duplicate".
func TestProposeWatchReportsDuplicateCheckFailure(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	ref := s.aiRefFor(1, 1, "/anime/Frieren")
	if _, err := s.DB.Exec(`ALTER TABLE watches RENAME TO watches_gone`); err != nil {
		t.Fatal(err)
	}
	_, reason := s.aiPropose(context.Background(), 1, "watch", ref, "Frieren", "", "")
	if reason != "db error" {
		t.Errorf("reason = %q, want db error", reason)
	}
}
