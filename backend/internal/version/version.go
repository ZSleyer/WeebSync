// Package version holds build metadata, injected at link time via -ldflags
// (see Dockerfile). Local/dev builds keep the defaults below.
package version

var (
	Version = "dev" // semver tag on release, "dev-<sha>" on main builds
	Channel = "dev" // "stable" | "dev"
	Commit  = ""    // full git sha the image was built from
	Repo    = ""    // "owner/name" for the update check; empty disables it
)
