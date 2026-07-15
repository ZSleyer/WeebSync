#!/usr/bin/env bash
# Seeds ./data from an index.json produced by backend/cmd/ftpindex.
# Files are created sparse (truncate) so they match real sizes at zero disk cost.
# index.json and data/ are gitignored — never commit them.
set -euo pipefail
cd "$(dirname "$0")"

idx="${1:-index.json}"
[ -f "$idx" ] || { echo "usage: $0 [index.json]" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

rm -rf data
mkdir -p data

jq -r '.entries[] | [(if .dir then "d" else "f" end), (.size // 0), .path] | @tsv' "$idx" |
while IFS=$'\t' read -r type size path; do
  # block only a real ".." path component, not filenames containing "..."
  case "/$path/" in */../*) echo "skip suspicious path: $path" >&2; continue;; esac
  target="data/${path#/}"
  if [ "$type" = d ]; then
    mkdir -p "$target"
  else
    mkdir -p "$(dirname "$target")"
    truncate -s "$size" "$target"
  fi
done

echo "seeded: $(find data -type f | wc -l) files, $(find data -type d | wc -l) dirs"
