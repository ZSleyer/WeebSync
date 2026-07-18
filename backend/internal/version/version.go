// Package version holds build metadata, injected at link time via -ldflags
// (see Dockerfile). Local/dev builds keep the defaults below.
package version

var (
	Version = "dev" // semver tag on release, "nightly" on CI builds, "dev" locally
	Channel = "dev" // "stable" (release) | "nightly" (CI) | "dev" (local); dev enables the OpenAPI docs
	Commit  = ""    // full git sha the image was built from
	Repo    = ""    // "owner/name" for the update check; empty disables it
)
