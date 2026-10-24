package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// An instance that already ran the 2026-10 overview refresh still holds TVDB
// records cached from a failed translation call (before the fix that stopped
// caching them); a FINISHED show's record is never fetched again by itself,
// so the refresh has to run once more and then stay done.
func TestRefreshProviderRecordsDropsRecordsCachedBeforeTranslationFix(t *testing.T) {
	s, _ := sizeTestServer(t)
	if err := db.SetSetting(s.DB, "provider_records", "2026-10-overviews-de-en"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('tvdb:media:42', '{"title":{"romaji":"Meitantei"}}')`); err != nil {
		t.Fatal(err)
	}
	s.RefreshProviderRecords()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE key = 'tvdb:media:42'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("a record cached under the previous refresh survived")
	}
	// once is enough: a record cached after the refresh stays
	if _, err := s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('tvdb:media:43', '{}')`); err != nil {
		t.Fatal(err)
	}
	s.RefreshProviderRecords()
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE key = 'tvdb:media:43'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("the refresh ran a second time")
	}
}
