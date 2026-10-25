#!/bin/sh
# Prints the versions of Debian's ffmpeg source package that the Dockerfile's
# ffmpeg stage would fetch right now. CI passes them as FFMPEG_SRC_KEY, so the
# build cache reuses a compiled ffmpeg only while Debian offers the same
# source, and a security update of it rebuilds the stage on the next build.
# Run from the repository root; needs docker.
set -eu
img="$(grep -m1 -o 'debian:trixie-slim@sha256:[0-9a-f]*' Dockerfile)"
docker run --rm "$img" sh -c "
  sed -i 's/^Types: deb\$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
  apt-get update -qq >/dev/null
  apt-cache showsrc ffmpeg | sed -n 's/^Version: //p' | sort -u | paste -sd ' ' -
"
