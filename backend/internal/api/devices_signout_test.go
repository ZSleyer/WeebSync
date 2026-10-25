package api

import (
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
)

// "Sign out everywhere" includes the paired devices: a new password (own or
// set by an admin) and ending the other sessions revoke the account's device
// tokens and its approved pairings; another account's devices stay.
func TestDeviceTokensEndWithTheSessions(t *testing.T) {
	cases := []struct {
		name string
		end  func(dt *deviceTest)
	}{
		{"own password change", func(dt *deviceTest) {
			rec := dt.do("PUT", "/api/auth/password", `{"current":"first horse battery staple","new":"second horse battery staple"}`, dt.alice, "", dt.freshIP())
			if rec.Code != http.StatusOK {
				dt.t.Fatalf("password change: %d %s", rec.Code, rec.Body)
			}
		}},
		{"admin sets the password", func(dt *deviceTest) {
			rec := dt.do("PUT", "/api/users/1/password", `{"password":"third horse battery staple"}`, dt.admin, "", dt.freshIP())
			if rec.Code != http.StatusOK {
				dt.t.Fatalf("admin password set: %d %s", rec.Code, rec.Body)
			}
		}},
		{"end other sessions", func(dt *deviceTest) {
			rec := dt.do("DELETE", "/api/auth/sessions/others", "", dt.alice, "", "")
			if rec.Code != http.StatusOK {
				dt.t.Fatalf("end others: %d %s", rec.Code, rec.Body)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dt := newDeviceTest(t)
			// alice has a password to change, set while her session stays
			if err := auth.SetPassword(dt.s.DB, 1, "first horse battery staple", dt.alice.Value); err != nil {
				t.Fatal(err)
			}
			aliceTok := dt.link(dt.alice, "Alice TV")
			bobTok := dt.link(dt.bob, "Bob TV")
			// an approval of alice's waiting for its poll
			p := dt.pair("")
			if rec := dt.approve(dt.alice, p.UserCode, ""); rec.Code != http.StatusOK {
				t.Fatal(rec.Code)
			}
			c.end(dt)
			if rec := dt.do("GET", "/api/tv/calendar", "", nil, aliceTok, ""); rec.Code != http.StatusUnauthorized {
				t.Errorf("alice's device token after %s: %d, want 401", c.name, rec.Code)
			}
			if code, out := dt.poll(p.DeviceCode); out.Token != "" || code == http.StatusOK {
				t.Errorf("approved pairing still hands out a token: %d %+v", code, out)
			}
			if rec := dt.do("GET", "/api/tv/calendar", "", nil, bobTok, ""); rec.Code != http.StatusOK {
				t.Errorf("bob's device token: %d, want it untouched", rec.Code)
			}
		})
	}
}
