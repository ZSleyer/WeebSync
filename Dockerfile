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
RUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable
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
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w \
      -X github.com/ch4d1/weebsync/internal/version.Version=$VERSION \
      -X github.com/ch4d1/weebsync/internal/version.Channel=$CHANNEL \
      -X github.com/ch4d1/weebsync/internal/version.Commit=$COMMIT \
      -X github.com/ch4d1/weebsync/internal/version.Repo=$REPO" -o /weebsync . \
    && mkdir -p /data/downloads

# ── runtime ──
# alpine (not distroless) so ffprobe is available for reading the true
# resolution / audio / subtitle tracks of local files, whose names often lack
# those tokens. ca-certificates for provider HTTPS; nonroot uid matches the
# distroless one we used before.
#
# On amd64 the VA-API drivers come along so the player can transcode on an
# Intel or AMD GPU (see WEEBSYNC_HWACCEL): intel-media-driver for Intel,
# mesa's radeonsi for AMD (the larger of the two, it pulls in LLVM). arm64
# images stay without: a Raspberry Pi 5 has no H.264 encoder to drive.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
ARG TARGETARCH
RUN apk upgrade --no-cache \
    && apk add --no-cache ffmpeg ca-certificates \
    && if [ "$TARGETARCH" = amd64 ]; then apk add --no-cache intel-media-driver mesa-va-gallium; fi \
    && adduser -D -H -u 65532 nonroot
COPY --from=build /weebsync /weebsync
# pre-owned data dir so the nonroot user can write the volume
COPY --from=build --chown=nonroot:nonroot /data /data
COPY --from=web /src/frontend/dist /web
ENV WEEBSYNC_ADDR=:8080 \
    WEEBSYNC_DATA=/data \
    WEEBSYNC_WEB=/web
VOLUME /data
EXPOSE 8080
USER nonroot
# the binary probes its own /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/weebsync", "-healthcheck"]
ENTRYPOINT ["/weebsync"]
