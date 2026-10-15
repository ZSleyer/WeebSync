package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

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
}
