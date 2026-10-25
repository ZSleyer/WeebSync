#!/bin/bash
# Regenerates the third-party license inventory the About page shows:
# frontend/src/licenses/inventory.json and texts.json. Commit both.
#
#   tools/licenses/generate.sh          regenerate, then run the allowlist check
#   tools/licenses/generate.sh --check  only the allowlist check
#
# Needs Go and the frontend's node_modules (yarn install). The frontend part
# is a production build into a temporary directory: only packages that end
# up in the bundle are listed. CI runs this and fails on a diff.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/frontend/scripts/licenses.mjs"

if [ "${1:-}" != --check ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # Go: every package linked into the binary (linux/amd64, what the image
  # ships), minus the app's own module. The Go toolchain itself is a static
  # entry in data.json, go-licenses does not list the standard library.
  (cd "$root/backend" && GOOS=linux GOARCH=amd64 \
    go run github.com/google/go-licenses/v2@v2.0.1 report ./... \
      --ignore github.com/ch4d1/weebsync \
      --template "$root/tools/licenses/go.tpl" >"$tmp/go.tsv" 2>"$tmp/go.log") \
    || { cat "$tmp/go.log" >&2; exit 1; }
  # the packages linked into the binary: a notice go-overrides.json skips
  # for a package that is not linked must not become one silently
  (cd "$root/backend" && GOOS=linux GOARCH=amd64 go list -deps ./... >"$tmp/go-deps.txt")

  # npm: the packages of the production bundle, read by the Vite plugin
  (cd "$root/frontend" && WEEBSYNC_LICENSES_NPM="$tmp/npm.json" \
    node_modules/.bin/vite build --outDir "$tmp/dist" --emptyOutDir --logLevel warn)

  node "$script" merge --go "$tmp/go.tsv" --npm "$tmp/npm.json" --deps "$tmp/go-deps.txt"
fi

node "$script" check
