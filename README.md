# WeebSync

Container-based web app for downloading and syncing anime folders from your own S/FTP servers - with an AniList/TMDB metadata catalog, a download manager with live speed throttling, and a rename engine.

> **Status: early, use at your own risk.** Not a mature or well-tested app. Expect rough edges and breaking changes.

Inspired by [BastianGanze/weebsync](https://github.com/BastianGanze/weebsync). This is a full ground-up reimplementation, built with heavy LLM assistance - it shares the idea, not the code.

## Features

- **SFTP / FTPS / FTP** - unified remote access, host keys via trust-on-first-use
- **Download manager** - parallel downloads, global + per-download speed limits (live), resume via `.part`, folder sync, SSE progress
- **Metadata catalog** - AniList + TMDB search/metadata, SQLite cache, rate-limit handling; remote folders auto-matched to titles (manually correctable)
- **Rename engine** - templates + free regex, AniList title override, always dry-run first
- **Auth** - email/password (argon2id) + generic OIDC; first user is admin, registration closable
- **PWA** - installable, web push on finished/failed downloads
- **i18n** - German/English · **Design** - dark/light, WCAG 2.2 AA, responsive to 320px

## Quickstart

```bash
docker compose up -d
# → http://localhost:8080 - first registered user becomes admin
```

### Image tags

| Tag | When | Use |
|---|---|---|
| `ghcr.io/zsleyer/weebsync:nightly` | daily (03:00 UTC) from green `main`, only if `main` moved | **recommended** - latest features, moves at most once a day |
| `:nightly-<sha>` | with each nightly | pin a specific nightly build |
| `:dev` | on every push to `main` that passes CI | follow development as it happens; moves several times a day |
| `:dev-<sha>` | with each `:dev` | pin a specific push |

The nightly image builds once a day instead of on every push, so an
auto-updater (e.g. the HA add-on tracking `:nightly`) updates at most daily.
`:dev` is the same code a few hours earlier, for testing a fix the moment it
lands. Versioned releases (`:vX.Y.Z`) are not planned yet: the project is at
an early stage and the schema still changes, so there is nothing to freeze.

### File ownership (UID/GID)

The container runs as the unprivileged user `nonroot` (uid/gid 65532) - no
root process, no `PUID`/`PGID` entrypoint that drops privileges later. Files
it writes belong to that uid, and a media mount owned by your host user is
read-only for it. To make it run as *your* user, hand Docker the ids
instead; the binary is static and needs nothing from `/etc/passwd`:

```yaml
services:
  weebsync:
    user: "1000:1000"   # $(id -u):$(id -g) of the media owner
    group_add:
      - "990"           # extra group(s) with write access to the mounts
```

Same thing on the CLI: `docker run --user 1000:1000 --group-add 990 …`.

Then the data dir must belong to that user as well: `./data` is created by
Docker as root when it does not exist, so `mkdir -p data && chown 1000:1000 data`
once before the first start. A named volume is initialised with the image's
owner (65532) and needs the same one-time `chown` from a helper container. The
Home Assistant add-on is not affected: the Supervisor runs it with the rights
it has on `/media` and `/config`.

## Configuration (env)

All optional. Env values **override** UI settings and lock the field.

| Variable | Default | Description |
|---|---|---|
| `WEEBSYNC_SECRET` | auto-generated | AES-GCM key for server passwords. Else `$WEEBSYNC_DATA/secret.key` (0600) on first start. **Back it up** - lost key = unreadable credentials |
| `WEEBSYNC_ADDR` | `:8080` | Listen address |
| `WEEBSYNC_DATA` | `/data` | SQLite DB + downloads |
| `WEEBSYNC_DOWNLOADS` | `$WEEBSYNC_DATA/downloads` | `:`-separated allowlist of local roots. The first is the default download dir; a sync target may live under any listed root. Mount your media wherever and list the mounts, e.g. `WEEBSYNC_DOWNLOADS=/media:/config` - only those paths are browsable/writable (no need to expose the whole container) |
| `WEEBSYNC_TRUSTED_PROXY` | `false` | Trust `X-Forwarded-*` only behind a proxy that overwrites them |
| `WEEBSYNC_FORCE_HTTPS` | `false` | Force `Secure` on all cookies (recommended behind a TLS proxy) |
| `ANILIST_TOKEN` / `OIDC_*` | - | Override their UI counterparts |

Runs **behind a TLS reverse proxy** (Traefik/Nginx/Caddy) - it does not terminate TLS itself. For public instances set `WEEBSYNC_TRUSTED_PROXY=true` + `WEEBSYNC_FORCE_HTTPS=true` and keep registration closed.

### Container hardening

The compose file drops every capability, forbids privilege gain
(`no-new-privileges`) and mounts the root filesystem read-only; the container
runs as `nonroot` anyway. Keep those lines when you adapt the file. Writes go
only to the `/data` volume and the media mounts, plus `tmpfs` on `/tmp` and
`/var/tmp` - SQLite and ffprobe need a writable temp dir and fail in odd ways
without one. On Debian/Ubuntu Docker also applies its default AppArmor
profile (`docker-default`); on Fedora/RHEL SELinux takes that role.

## Development

```bash
cd backend && go run .              # port 8080, key auto-generated at ./data/secret.key
cd frontend && yarn && yarn dev     # dev server proxies /api → backend

cd backend && go test ./...
cd frontend && yarn build
```

Stack: Go (stdlib `net/http`, `modernc.org/sqlite`, `pkg/sftp`, `jlaffaye/ftp`, `anitogo`) · React + TypeScript + Vite + Tailwind v4 + TanStack Query.

Home Assistant add-on: [ZSleyer/WeebSync-Addon](https://github.com/ZSleyer/WeebSync-Addon).

### Update check

The About page shows whether a newer image exists. It queries the public GitHub
API (latest release for a stable build, the tip of `main` for a dev build),
unauthenticated, cached ~6 h, sending no instance data beyond the request itself.
An admin can turn it off under **Settings → About**.

## License

[AGPL-3.0](LICENSE).
