#!/bin/sh
# The Debian packages behind the files of the image's /rootfs, for the
# About page and the license notices. Runs in the Dockerfile's rootfs stage,
# the last one with dpkg:
#
#   os-inventory.sh <rootfs> <out.json> [<ffmpeg source file>]
#
# - finds the package of every file under <rootfs> (dpkg -S),
# - copies each package's /usr/share/doc/<pkg>/copyright into <rootfs>,
# - writes <out.json>: [{name, version, license, url, source: "os"}], sorted.
#   license lists the License: fields of a machine-readable copyright file
#   (Debian's short names, not always SPDX), else points at the file.
# - adds ffmpeg, built from Debian's source package in the ffmpeg stage, from
#   the file that stage writes (name, version, configure flags).
set -eu

root="$1"
out="$2"
ffmpeg_src="${3:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# every regular file and link, as the path it has outside the rootfs
(cd "$root" && find . \( -type f -o -type l \) | sed 's#^\.##') >"$tmp/files"
# "pkg[:arch][, pkg2]: /path" -> one package name per line
xargs -r dpkg -S <"$tmp/files" 2>/dev/null \
  | grep -v '^diversion' \
  | sed 's/: \/.*$//' | tr ',' '\n' | sed 's/^ *//; s/:.*$//' \
  | grep -v '^$' | sort -u >"$tmp/pkgs" || true

esc() { sed 's/\\/\\\\/g; s/"/\\"/g'; }

licenses_of() {
  f="$1"
  if head -n 1 "$f" | grep -q '^Format:'; then
    l="$(sed -n 's/^License: *\([^ ].*\)$/\1/p' "$f" | sort -u | head -n 6 | paste -sd ',' - | sed 's/,/, /g')"
    [ "$(sed -n 's/^License: *\([^ ].*\)$/\1/p' "$f" | sort -u | wc -l)" -gt 6 ] && l="$l, ..."
    [ -n "$l" ] && { printf '%s' "$l"; return; }
  fi
  printf 'see /usr/share/doc/%s/copyright' "$2"
}

: >"$tmp/entries"
while read -r pkg; do
  line="$(dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\n' "$pkg" 2>/dev/null | head -n 1)" || continue
  [ -n "$line" ] || continue
  name="$(printf '%s' "$line" | cut -f1)"
  version="$(printf '%s' "$line" | cut -f2)"
  src="$(printf '%s' "$line" | cut -f3)"
  doc="/usr/share/doc/$name/copyright"
  license="no copyright file"
  if [ -r "$doc" ]; then
    mkdir -p "$root/usr/share/doc/$name"
    cp -L "$doc" "$root/usr/share/doc/$name/copyright"
    license="$(licenses_of "$doc" "$name")"
  fi
  printf '{"name":"%s","version":"%s","license":"%s","url":"https://tracker.debian.org/pkg/%s","source":"os"}\n' \
    "$(printf '%s' "$name" | esc)" "$(printf '%s' "$version" | esc)" \
    "$(printf '%s' "$license" | esc)" "$(printf '%s' "$src" | esc)" >>"$tmp/entries"
done <"$tmp/pkgs"

# ffmpeg: its exact Debian source, which is also the GPL source offer
if [ -n "$ffmpeg_src" ] && [ -r "$ffmpeg_src" ]; then
  v="$(sed -n 's/^Version: *//p' "$ffmpeg_src")"
  printf '{"name":"ffmpeg (built in the image from Debian source, see /usr/share/doc/ffmpeg)","version":"%s","license":"GPL-2.0-or-later","url":"https://snapshot.debian.org/package/ffmpeg/%s/","source":"os"}\n' \
    "$(printf '%s' "$v" | esc)" "$(printf '%s' "$v" | esc)" >>"$tmp/entries"
fi

{
  printf '['
  sort "$tmp/entries" | paste -sd ',' -
  printf ']\n'
} >"$out"
