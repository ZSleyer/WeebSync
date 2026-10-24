package api

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// swag v2.0.0-rc5 wrote CookieAuth as an Authorization header, so a client
// generated from the spec sent the session where the server never reads it.
// gen-docs.sh writes the scheme as the session cookie it is.
func TestSwaggerCookieAuthIsTheSessionCookie(t *testing.T) {
	raw, err := os.ReadFile("../../docs/swagger.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			SecuritySchemes map[string]struct {
				Type        string `json:"type"`
				In          string `json:"in"`
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"securitySchemes"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	c := spec.Components.SecuritySchemes["CookieAuth"]
	if c.Type != "apiKey" || c.In != "cookie" || c.Name != "weebsync_session" {
		t.Errorf("CookieAuth = %+v, want an apiKey in the cookie weebsync_session", c)
	}
	if !strings.Contains(c.Description, "__Host-weebsync_session") {
		t.Errorf("CookieAuth does not name the HTTPS cookie: %q", c.Description)
	}
	if b := spec.Components.SecuritySchemes["BearerAuth"]; b.In != "header" || b.Name != "Authorization" {
		t.Errorf("BearerAuth = %+v", b)
	}
}
