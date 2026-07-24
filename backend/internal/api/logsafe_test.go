package api

import "testing"

func TestLogSafeStripsCRLF(t *testing.T) {
	if got := logSafe("a\r\nb\nc\rd"); got != "abcd" {
		t.Fatalf("logSafe = %q, want %q", got, "abcd")
	}
}
