package ai

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// A provider answering in Japanese (three bytes a character) must not have
// its message cut inside a character: the error reaches the log and the chat.
func TestHttpErrCutsWholeCharacters(t *testing.T) {
	resp := &http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader("x" + strings.Repeat("モデルが見つかりません", 60)))}
	msg := httpErr(resp).Error()
	if !utf8.ValidString(msg) {
		t.Fatalf("error message split a character: %q", msg)
	}
	if n := utf8.RuneCountInString(strings.TrimPrefix(msg, "ai: HTTP 400: ")); n != 300 {
		t.Errorf("kept %d characters, want 300", n)
	}
}
