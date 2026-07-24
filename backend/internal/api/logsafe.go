package api

import "strings"

// logSafe strips CR/LF so a media-server folder/title name cannot forge log
// lines. slog already quotes attribute values at runtime; this exists so
// CodeQL's go/log-injection dataflow sees an explicit barrier.
func logSafe(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}
