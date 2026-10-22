package api

import (
	"strings"
	"testing"
)

// TestEmailHTMLStructure pins the mail-client rules of the layout: lang with
// an "en" fallback, an escaped one-line preheader, presentation tables, a
// single h1, the Fluid Lycoris palette, and an escaped button.
func TestEmailHTMLStructure(t *testing.T) {
	for locale, want := range map[string]string{"de": `<html lang="de">`, "xx": `<html lang="en">`, "": `<html lang="en">`} {
		if !strings.Contains(emailHTML(locale, "p", "T", "", "", ""), want) {
			t.Errorf("locale %q: missing %s", locale, want)
		}
	}
	out := emailHTML("en", "<b>x</b>\r\ny", "T", "", emailButton(`https://x/?a="1"&b=<2>`, `<i>Go</i>`, "0"), "https://x/m")
	if !strings.Contains(out, "&lt;b&gt;x&lt;/b&gt; y") {
		t.Error("preheader not escaped onto one line")
	}
	if i := strings.Index(out, "mso-hide:all"); i < 0 || strings.ContainsAny(out[i:i+strings.Index(out[i:], "</div>")], "\r\n") {
		t.Error("preheader block missing or spans lines")
	}
	if n, p := strings.Count(out, "<table"), strings.Count(out, `<table role="presentation"`); n == 0 || n != p {
		t.Errorf("%d tables, %d with role=presentation", n, p)
	}
	if n := strings.Count(out, "<h1"); n != 1 {
		t.Errorf("%d h1 elements", n)
	}
	for _, old := range []string{"#a685f0", "#0d1117", "#161b22"} {
		if strings.Contains(out, old) {
			t.Errorf("old palette colour %s still present", old)
		}
	}
	if !strings.Contains(out, `href="https://x/?a=&#34;1&#34;&amp;b=&lt;2&gt;"`) || !strings.Contains(out, "&lt;i&gt;Go&lt;/i&gt;") || strings.Contains(out, "<i>") {
		t.Error("button href/label not escaped")
	}
}

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
