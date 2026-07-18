#!/usr/bin/env bash
# Seeds ./data from an index.json produced by backend/cmd/ftpindex.
# Files are created sparse (truncate) so they cost zero disk. Sizes are capped
# at SFTP_TEST_MAX_SIZE bytes (default 4 MiB) so sync tests download in
# seconds instead of pulling GB-sized dummies; set it to 0 for real sizes.
# index.json and data/ are gitignored - never commit them.
set -euo pipefail
cd "$(dirname "$0")"

idx="${1:-index.json}"
[ -f "$idx" ] || { echo "usage: $0 [index.json]" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
max="${SFTP_TEST_MAX_SIZE:-4194304}"

# empty data/ instead of rm -rf: deleting the directory itself would break
# the running container's bind mount (stale inode -> empty /data)
mkdir -p data
find data -mindepth 1 -delete

jq -r '.entries[] | [(if .dir then "d" else "f" end), (.size // 0), .path] | @tsv' "$idx" |
while IFS=$'\t' read -r type size path; do
  # block only a real ".." path component, not filenames containing "..."
  case "/$path/" in */../*) echo "skip suspicious path: $path" >&2; continue;; esac
  target="data/${path#/}"
  if [ "$type" = d ]; then
    mkdir -p "$target"
  else
    mkdir -p "$(dirname "$target")"
    if [ "$max" -gt 0 ] && [ "$size" -gt "$max" ]; then size=$max; fi
    truncate -s "$size" "$target"
  fi
done

echo "seeded: $(find data -type f | wc -l) files, $(find data -type d | wc -l) dirs"
