# ── frontend build ── (arch-independent JS, always native)
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /src
COPY frontend/package.json frontend/yarn.lock ./
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn yarn install --frozen-lockfile
COPY frontend/ ./
RUN yarn build

# ── backend build ── (native toolchain, cross-compiled to $TARGETARCH)
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
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
FROM alpine:3.21
RUN apk add --no-cache ffmpeg ca-certificates \
    && adduser -D -H -u 65532 nonroot
COPY --from=build /weebsync /weebsync
# pre-owned data dir so the nonroot user can write the volume
COPY --from=build --chown=nonroot:nonroot /data /data
COPY --from=web /src/dist /web
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
