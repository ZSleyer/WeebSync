// Package version holds build metadata, injected at link time via -ldflags
// (see Dockerfile). Local/dev builds keep the defaults below.
package version

var (
	Version = "dev" // semver tag on release, "nightly"/"dev" on CI builds, "dev" locally
	Channel = "dev" // "stable" (release) | "nightly" (daily CI) | "dev" (per-push CI and local)
	Commit  = ""    // full git sha the image was built from; empty marks a local build
	Repo    = ""    // "owner/name" for the update check; empty disables it
)
