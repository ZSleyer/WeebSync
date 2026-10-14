package api

import "testing"

// A URL that carries a credential may be plain http:// only inside the
// operator's own network.
func TestCheckSecretURL(t *testing.T) {
	for raw, ok := range map[string]bool{
		"":                                true,
		"https://203.0.113.9/v1":          true,
		"http://127.0.0.1:4000":           true,
		"http://192.168.1.20:32400":       true,
		"http://[fd00::12]:8123/api":      true,
		"http://203.0.113.9:4000":         false,
		"http://[2001:db8::1]:4000":       false,
		"ftp://192.168.1.20/":             false,
		"http://169.254.169.254/metadata": false,
	} {
		if err := checkSecretURL(raw); (err == nil) != ok {
			t.Errorf("checkSecretURL(%q) = %v, want ok=%v", raw, err, ok)
		}
	}
}
