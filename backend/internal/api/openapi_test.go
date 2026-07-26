package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/version"
)

// The interactive docs must never ship. Since CI publishes a :dev image the
// add-on follows, the channel name no longer separates "local" from "shipped" -
// the build metadata does.
func TestDevDocsOnlyOnLocalBuilds(t *testing.T) {
	orig := version.Commit
	t.Cleanup(func() { version.Commit = orig })

	version.Commit = ""
	if !devDocsEnabled() {
		t.Error("a local build (no commit stamped) should serve the docs")
	}
	version.Commit = "0123456789abcdef"
	if devDocsEnabled() {
		t.Error("a stamped build is a shipped one and must not serve the docs")
	}
}
