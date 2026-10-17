package auth

import (
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/secret"
)

// The proof the first OIDC sign-in needs is the server's own: a cookie it
// set passes, a forged or altered one does not, and none at all does not.
func TestSetupProof(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	if err := SetSetupProof(rec, httptest.NewRequest("POST", "/", nil)); err != nil {
		t.Fatal(err)
	}
	c := rec.Result().Cookies()[0]
	with := func(v string) bool {
		r := httptest.NewRequest("GET", "/api/auth/oidc/callback", nil)
		if v != "" {
			r.AddCookie(&http.Cookie{Name: setupProofCookie, Value: v})
		}
		return validSetupProof(r)
	}
	if !with(c.Value) {
		t.Error("the server's own proof was refused")
	}
	if with(c.Value[:len(c.Value)-2] + "00") {
		t.Error("an altered proof passed")
	}
	if with("deadbeef.00") || with("") {
		t.Error("a forged or missing proof passed")
	}
	// rightly signed, but older than ten minutes
	at := strconv.FormatInt(time.Now().Add(-11*time.Minute).Unix(), 10)
	mac, _ := secret.MAC("oidc-setup|" + at + "|abc")
	if with(at + ".abc." + hex.EncodeToString(mac)) {
		t.Error("an expired proof passed")
	}
	// stamped in the future: never ages out, so it is refused beyond the skew
	for off, want := range map[time.Duration]bool{30 * time.Second: true, 2 * time.Minute: false, 24 * time.Hour: false} {
		at := strconv.FormatInt(time.Now().Add(off).Unix(), 10)
		mac, _ := secret.MAC("oidc-setup|" + at + "|abc")
		if got := with(at + ".abc." + hex.EncodeToString(mac)); got != want {
			t.Errorf("proof stamped %s ahead: got %v, want %v", off, got, want)
		}
	}
}
