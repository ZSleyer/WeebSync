package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// failSettingWrites makes every write of the named setting fail, the way a
// full disk or a locked database would.
func failSettingWrites(t *testing.T, s *Server, key string) {
	t.Helper()
	for _, ev := range []string{"INSERT", "UPDATE"} {
		if _, err := s.DB.Exec(`CREATE TRIGGER fail_` + ev + ` BEFORE ` + ev + ` ON settings WHEN NEW.key = '` + key + `'
			BEGIN SELECT RAISE(ABORT, 'disk full'); END`); err != nil {
			t.Fatal(err)
		}
	}
}

// Switching the arr source off clears two settings; saying "ok" while the
// plaintext key stayed behind left the old key readable on the settings page.
func TestArrKeyDeleteReportsStoreFailure(t *testing.T) {
	s, _ := sizeTestServer(t)
	failSettingWrites(t, s, "arr_key")
	w := httptest.NewRecorder()
	s.handleArrKeyDelete(w, httptest.NewRequest(http.MethodDelete, "/api/settings/arr-key", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", w.Code)
	}
}

// The toggle answered with the state the user asked for even when it was
// not stored, so the switch snapped back on the next load.
func TestUpdateCheckToggleReportsStoreFailure(t *testing.T) {
	s, _ := sizeTestServer(t)
	failSettingWrites(t, s, "update_check")
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/version/update-check", strings.NewReader(`{"enabled":true}`))
	r.Header.Set("Content-Type", "application/json")
	s.handleUpdateCheckToggle(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", w.Code)
	}
}

// An unreadable credential table must not read as "no security key": the
// sign-in would skip the second factor.
func TestHasSecurityKeyReportsReadFailure(t *testing.T) {
	s, _ := sizeTestServer(t)
	if _, err := s.DB.Exec(`DROP TABLE webauthn_credentials`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.hasSecurityKey(1); err == nil {
		t.Fatal("a failed read was reported as a clean answer")
	}
}

// An empty column means the user cleared every axis; a failed read must
// not be taken for that and switch all upgrade suggestions off.
func TestUpgradeDimsForKeepsDefaultsOnReadFailure(t *testing.T) {
	s, _ := sizeTestServer(t)
	if _, err := s.DB.Exec(`ALTER TABLE users DROP COLUMN upgrade_dims`); err != nil {
		t.Fatal(err)
	}
	if got := s.upgradeDimsFor(1); len(got.Order) != len(upgradeAxes) {
		t.Fatalf("axes %v, want the defaults %v", got.Order, upgradeAxes)
	}
}

// A grab for a server that does not exist stays an owner of 0; a database
// failure is reported instead of enqueueing the file under user 0.
func TestServerOwnerSeparatesMissingFromFailure(t *testing.T) {
	s, _ := sizeTestServer(t)
	if uid, err := s.serverOwner(1); err != nil || uid != 1 {
		t.Fatalf("owner %d, %v; want 1", uid, err)
	}
	if uid, err := s.serverOwner(99); err != nil || uid != 0 {
		t.Fatalf("missing server: %d, %v; want 0, nil", uid, err)
	}
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.serverOwner(1); err == nil {
		t.Fatal("a failed lookup was reported as a clean answer")
	}
}
