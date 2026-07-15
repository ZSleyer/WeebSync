# ── frontend build ──
FROM node:24-alpine AS web
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── backend build ──
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /weebsync . \
    && mkdir -p /data/downloads

# ── runtime ──
FROM gcr.io/distroless/static-debian12:nonroot
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
ENTRYPOINT ["/weebsync"]
