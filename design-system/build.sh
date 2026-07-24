#!/usr/bin/env bash
# Build the design-system package from the app's own toolchain: no separate
# dependency tree, and styles.css is a byte copy of what the app ships, so a
# component can never render differently here than in WeebSync.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
FE="$SRC/../frontend"
BIN="$FE/node_modules/.bin"

[ -x "$BIN/vite" ] || { echo "run 'yarn install' in frontend/ first" >&2; exit 1; }

# no dependency tree of its own: borrow the app's, so versions can never drift
[ -e "$SRC/node_modules" ] || ln -s ../frontend/node_modules "$SRC/node_modules"

# 1. stylesheet: the current app build
CSS=$(ls -t "$FE/dist/assets/"index-*.css 2>/dev/null | head -1)
[ -n "$CSS" ] || { echo "no frontend build found - run 'cd frontend && yarn build' first" >&2; exit 1; }
cp "$CSS" "$SRC/styles.css"

# 2. components (react stays external - the host provides it)
rm -rf "$SRC/dist"
(cd "$SRC" && "$BIN/vite" build --logLevel warn)

# 3. types
"$BIN/tsc" -p "$SRC/tsconfig.json"

echo "design-system built: $(basename "$CSS") -> styles.css, $(wc -c < "$SRC/dist/index.js") B bundle"
