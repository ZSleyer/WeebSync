# ── frontend build ── (arch-independent JS, always native)
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS web
# the frontend keeps its place in the tree: @weebsync/design-system resolves to
# ../design-system/src, and index.css scans the same path for Tailwind classes
WORKDIR /src/frontend
COPY frontend/package.json frontend/yarn.lock frontend/.yarnrc.yml ./
COPY frontend/.yarn/releases/ .yarn/releases/
# node images stopped shipping yarn and corepack with node 25; the release
# checked in beside the lockfile is the one that runs
RUN ln -s /src/frontend/.yarn/releases/yarn-*.cjs /usr/local/bin/yarn
RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked yarn install --immutable
COPY design-system/ /src/design-system/
# the design system has no dependency tree of its own - it borrows the app's,
# the same symlink design-system/build.sh makes locally. Without it tsc cannot
# resolve React's types from design-system/src and every prop falls back to any.
RUN ln -sfn /src/frontend/node_modules /src/design-system/node_modules
COPY frontend/ ./
RUN yarn build

# ── backend build ── (native toolchain, cross-compiled to $TARGETARCH)
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine@sha256:85dc1069ac644ea3c527b177303a406eb3358192816cd7f9e5848eb658851673 AS build
ARG TARGETOS TARGETARCH
# build metadata surfaced on the About page (see internal/version)
ARG VERSION=dev CHANNEL=dev COMMIT= REPO=
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
COPY backend/third_party/ third_party/
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked go mod download
COPY backend/ ./
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w \
      -X github.com/ch4d1/weebsync/internal/version.Version=$VERSION \
      -X github.com/ch4d1/weebsync/internal/version.Channel=$CHANNEL \
      -X github.com/ch4d1/weebsync/internal/version.Commit=$COMMIT \
      -X github.com/ch4d1/weebsync/internal/version.Repo=$REPO" -o /weebsync . \
    && mkdir -p /data/downloads

# ── ffmpeg ── (Debian's own source package, a smaller configuration)
# Debian's ffmpeg package links every codec library it knows (x265, aom, flite,
# a speech synthesiser, an SVG renderer, ...): 220 MB of libraries for two
# programs that decode, run x264, burn ASS subtitles and drive a GPU. The same
# Debian source, patches included (so the archive's security fixes come with
# every build), is configured here for what the player uses: all native
# decoders/demuxers/filters, libx264, libass, libdav1d for AV1, VA-API, and the
# NVENC headers (the driver is loaded at run time from the host's runtime).
# Network is compiled in for exactly two protocols, http and tcp: a source on a
# remote server reaches ffmpeg as a URL on the player's own loopback listener
# (127.0.0.1, one unguessable 128-bit token per run), because the demuxers seek
# through it with Range requests (Matroska's index sits at the end of the file)
# and a pipe cannot. Every other network protocol stays out of the binary (no
# tls, udp, rtp, ftp, rtmp, ...; `ffmpeg -protocols` lists only the local ones
# plus http and tcp), and each run restricts itself further with
# -protocol_whitelist (file,pipe for a local file, http,tcp for a remote one).
# rtp and udp are named off because other protocols would pull them in as
# dependencies. See docs/development.md.
# Cross-compiled for arm64 from the build machine with the multiarch -dev
# packages. The Go binary needs no cross toolchain (CGO is off).
FROM --platform=$BUILDPLATFORM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS ffmpeg
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-linux-gnu > /triple; echo amd64 > /debarch ;; \
      arm64) echo aarch64-linux-gnu > /triple; echo arm64 > /debarch ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
    && dpkg --add-architecture "$(cat /debarch)" \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dpkg-dev make pkgconf nasm xz-utils gcc libc6-dev \
    && if [ "$(dpkg --print-architecture)" != "$(cat /debarch)" ]; then \
         apt-get install -y --no-install-recommends "gcc-$(tr _ - < /triple)" "libc6-dev-$(cat /debarch)-cross"; fi \
    && cd /tmp && apt-get source --download-only ffmpeg >/dev/null \
    && dpkg-source -x ffmpeg_*.dsc /src >/dev/null \
    && apt-get install -y --no-install-recommends \
         "libx264-dev:$(cat /debarch)" "libass-dev:$(cat /debarch)" "libdav1d-dev:$(cat /debarch)" \
         "libva-dev:$(cat /debarch)" libffmpeg-nvenc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN set -eu; triple="$(cat /triple)"; cross=""; \
    if [ "$(dpkg --print-architecture)" != "$(cat /debarch)" ]; then \
      cross="--enable-cross-compile --arch=aarch64 --target-os=linux --cross-prefix=${triple}-"; \
    fi; \
    export PKG_CONFIG_LIBDIR="/usr/lib/${triple}/pkgconfig:/usr/share/pkgconfig" PKG_CONFIG_ALLOW_SYSTEM_LIBS=1 PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1; \
    ./configure --prefix=/opt/ffmpeg $cross \
      --disable-debug --disable-doc --disable-ffplay --disable-autodetect --enable-network \
      --disable-protocols --enable-protocol=async,cache,concat,concatf,crypto,data,fd,file,hls,pipe,subfile,md5,tee,tcp,http \
      --disable-protocol=rtp,udp \
      --disable-indevs --enable-indev=lavfi --disable-outdevs \
      --enable-shared --disable-static --enable-pic \
      --enable-gpl --enable-libx264 --enable-libass --enable-libdav1d --enable-vaapi --enable-ffnvcodec --enable-nvenc \
      --extra-ldflags="-Wl,-rpath,/opt/ffmpeg/lib -Wl,-z,relro,-z,now -L/usr/lib/${triple}"; \
    make -j"$(nproc)"; make install; \
    cd /opt/ffmpeg; rm -rf include share lib/pkgconfig lib/*.so; \
    "${triple}-strip" bin/ffmpeg bin/ffprobe lib/*.so.*

# ── runtime files ── (target architecture)
# Installs the shared libraries ffmpeg links, plus the VA-API drivers on amd64,
# and copies exactly the files the player's programs can load into /rootfs:
# the dynamic-link closure of ffmpeg, ffprobe and every VA-API driver, the font
# configuration libass reads, the DRM id tables the AMD driver reads, and
# ldconfig (the NVIDIA container runtime refreshes the loader cache with it).
# The C library itself comes from the distroless base below, so it is left out.
# On amd64 the drivers are intel-media-va-driver for Intel and mesa's radeonsi
# for AMD (WEEBSYNC_HWACCEL). arm64 images stay without: a Raspberry Pi 5 has no
# H.264 encoder to drive.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS rootfs
ARG TARGETARCH
# --build-arg VAAPI_AMD=0 leaves mesa's radeonsi driver out of the amd64 image:
# it needs LLVM (130 MB) and is the reason the amd64 image is twice the size of
# the arm64 one. Intel (iHD) and NVIDIA (NVENC) are not affected.
ARG VAAPI_AMD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends libx264-164 libass9 libdav1d7 libva2 libva-drm2 \
    && if [ "$TARGETARCH" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; \
       if [ "$VAAPI_AMD" = 1 ]; then apt-get install -y --no-install-recommends mesa-va-drivers; fi; fi
COPY --from=ffmpeg /opt/ffmpeg /opt/ffmpeg
RUN <<'EOF'
set -eu
mkdir -p /rootfs/usr/local/bin /rootfs/usr/sbin
# mesa ships five names for one 40 MB file; only the AMD one and Intel's are wanted
drivers="$(find /usr/lib -path '*/dri/*' \( -name iHD_drv_video.so -o -name radeonsi_drv_video.so \) 2>/dev/null)"
loadable="/opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe $drivers"
# the base image has these (same Debian release); mixing versions is worse than leaving them out
skip='/(libc|libm|libdl|libpthread|librt|libresolv|libgcc_s|libstdc\+\+|libssl|libcrypto|ld-linux[^/]*)\.so'
for f in $loadable; do ldd "$f"; done | awk '/=> \//{print $3}' | sed -E 's#^/(lib|lib64)/#/usr/\1/#' | sort -u | grep -Ev "$skip" > /libs
if ldd /opt/ffmpeg/bin/ffmpeg | grep -q 'not found'; then ldd /opt/ffmpeg/bin/ffmpeg; exit 1; fi
cat /libs | xargs -I{} cp -L --parents {} /rootfs
[ -z "$drivers" ] || cp -L --parents $drivers /rootfs
cp -a --parents /opt/ffmpeg /rootfs
ln -s /opt/ffmpeg/bin/ffmpeg /rootfs/usr/local/bin/ffmpeg
ln -s /opt/ffmpeg/bin/ffprobe /rootfs/usr/local/bin/ffprobe
for d in /etc/fonts /usr/share/fonts /usr/share/fontconfig /usr/share/libdrm /usr/share/zoneinfo/Etc; do
  [ -e "$d" ] && cp -a --parents "$d" /rootfs || true
done
cp -a /usr/sbin/ldconfig /rootfs/usr/sbin/ldconfig
EOF

# ── runtime ──
# Distroless on glibc: no shell, no package manager, the C
# library, CA certificates and tzdata of Debian 13, and the user nonroot (uid
# 65532). Everything else is the /rootfs above, the Go binary and the frontend.
FROM gcr.io/distroless/cc-debian13@sha256:159783207c2cd44c2aa5715961d13c8612368ac9bd450f887e3f08fc8ea461e3
COPY --from=rootfs /rootfs/ /
COPY --from=build /weebsync /weebsync
# pre-owned data dir so the nonroot user can write the volume
COPY --from=build --chown=65532:65532 /data /data
COPY --from=web /src/frontend/dist /web
ENV WEEBSYNC_ADDR=:8080 \
    WEEBSYNC_DATA=/data \
    WEEBSYNC_WEB=/web
VOLUME /data
EXPOSE 8080
USER 65532:65532
# the binary probes its own /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/weebsync", "-healthcheck"]
ENTRYPOINT ["/weebsync"]
