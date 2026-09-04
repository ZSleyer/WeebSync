package api

import "testing"

// oneLine guards the text/plain mail part: a CR/LF in a file name, error note
// or catalog title must not become a real line break in the message.
func TestOneLine(t *testing.T) {
	cases := map[string]string{
		"Episode 01.mkv":                       "Episode 01.mkv",
		"ep.mkv\r\nWeebSync: your token is X":  "ep.mkv WeebSync: your token is X",
		"a\nb\rc":                              "a b c",
		"\r\n\r\nleading and trailing\r\n":     "leading and trailing",
		"connection refused\nby remote server": "connection refused by remote server",
	}
	for in, want := range cases {
		if got := oneLine(in); got != want {
			t.Errorf("oneLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOriginDropsPathAndRejectsCredentials(t *testing.T) {
	if o, ok := origin(" https://weebsync.example.com/api/auth/oidc/callback "); !ok || o != "https://weebsync.example.com" {
		t.Fatalf("got %q %v", o, ok)
	}
	for _, bad := range []string{"", "weebsync.example.com", "ftp://x", "https://user:pw@x"} {
		if _, ok := origin(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
}
