# WeebSync

Container-based web app for downloading and syncing files and folders from your own S/FTP servers - with a metadata catalog, a download manager with live speed throttling, and a rename engine.

> **Status: early, use at your own risk.** Not a mature or well-tested app. Expect rough edges and breaking changes.

Inspired by [BastianGanze/weebsync](https://github.com/BastianGanze/weebsync). This is a full ground-up reimplementation, built with heavy LLM assistance - it shares the idea, not the code.

## Features

- **SFTP / FTPS / FTP** - unified remote access, host keys via trust-on-first-use
- **Download manager** - parallel downloads, global + per-download speed limits (live), resume via `.part`, folder sync, SSE progress
- **Auto-sync** - watch a series, new episodes are fetched as they appear; release calendar
- **Metadata catalog** - AniList / TMDB / TVDB search, SQLite cache; remote folders auto-matched to titles (manually correctable)
- **Rename engine** - templates + free regex, AniList title override, always dry-run first
- **Auth** - email/password (argon2id) + generic OIDC; first user is admin, registration closable
- **Notifications** - web push on finished/failed downloads, optional email
- **PWA** - installable · **i18n** - German/English · dark/light, WCAG 2.2 AA, responsive to 320px

## Quickstart

```bash
docker compose up -d
# → http://localhost:8080 - first registered user becomes admin
```

Runs **behind a TLS reverse proxy** (Traefik/Nginx/Caddy); it does not terminate TLS itself. For a public instance set `WEEBSYNC_TRUSTED_PROXY` + `WEEBSYNC_FORCE_HTTPS=true` and keep registration closed.

### Image tags

| Tag | When | Use |
|---|---|---|
| `ghcr.io/zsleyer/weebsync:nightly` | daily (03:00 UTC) from green `main` | **recommended** - moves at most once a day |
| `:dev` | every push to `main` that passes CI | the same code a few hours earlier |
| `:nightly-<sha>` / `:dev-<sha>` | with each build | pin an exact build |

No `:vX.Y.Z` releases yet - the schema still changes, so there is nothing to freeze.

### File ownership (UID/GID)

The container runs as `nonroot` (uid/gid 65532), no `PUID`/`PGID` entrypoint. To write your media with your own ids, hand them to Docker (the binary is static and needs nothing from `/etc/passwd`):

```yaml
services:
  weebsync:
    user: "1000:1000"   # $(id -u):$(id -g) of the media owner
    group_add: ["990"]  # extra group(s) with write access to the mounts
```

The data dir must belong to that user too: `mkdir -p data && chown 1000:1000 data` before the first start (Docker creates a missing bind dir as root, a named volume as 65532). The Home Assistant add-on is unaffected.

## Configuration (env)

All optional.

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone for log timestamps; any IANA name works (zone data is in the binary) |
| `WEEBSYNC_ADDR` | `:8080` | Listen address |
| `WEEBSYNC_DATA` | `/data` | SQLite DB + downloads |
| `WEEBSYNC_DOWNLOADS` | `$WEEBSYNC_DATA/downloads` | `:`-separated allowlist of local roots. The first is the default download dir. Mount your media wherever and list the mounts (`/media:/data/downloads`); only those paths are browsable and writable |
| `WEEBSYNC_SECRET` | auto-generated | AES-GCM key for stored credentials. Else `$WEEBSYNC_DATA/secret.key` (0600) on first start. **Back it up** - lost key = unreadable credentials |
| `WEEBSYNC_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |

### Settings that also exist in the UI

A set env var **overrides** the UI value and locks the field. Booleans accept `1`, `true`, `yes`.

| Variable | Description |
|---|---|
| `WEEBSYNC_BASE_URL` | Public origin of the instance, used for links in emails |
| `WEEBSYNC_TRUSTED_PROXY` | Comma-separated IPs/CIDRs whose `X-Forwarded-*` headers are believed (`true` trusts every peer). Only set it behind a proxy that overwrites those headers |
| `WEEBSYNC_FORCE_HTTPS` | Force `Secure` on all cookies (recommended behind a TLS proxy) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | Generic OIDC login (Authentik/Keycloak/…). Redirect URL is `<base>/api/auth/oidc/callback` |
| `OIDC_PROVIDER_NAME` | Label on the login button |
| `OIDC_CLAIM`, `OIDC_ADMIN_VALUES`, `OIDC_USER_VALUES` | Role mapping: claim to read (e.g. `groups`, requested as a scope) plus the comma-separated values granting admin / normal access. With admin values set, the IdP owns all roles and local role edits are refused |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Outgoing mail (password reset, notifications) |
| `SMTP_SECURITY` | `starttls` (default), `tls`, `none` |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` | Own AniList OAuth app; without it a public pin-flow client is used |
| `ANILIST_TOKEN` | Operator AniList token used for background matching instead of a linked account (no UI counterpart) |
| `TMDB_API_KEY`, `TVDB_API_KEY` | Movie/series metadata |
| `ANIMESCHEDULE_TOKEN` | Release dates for the calendar |
| `PLEX_URL`, `PLEX_TOKEN` | Plex server (read-only); its show libraries are matched against your series |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | OpenAI-compatible endpoint for the assistant |
| `AI_SEARCH_URL` | SearXNG instance the assistant may query |

### Container hardening

The compose file drops all capabilities, sets `no-new-privileges` and mounts the root filesystem read-only - keep those lines when adapting it. Writes go to `/data`, the media mounts and `tmpfs` on `/tmp` and `/var/tmp`; SQLite and ffprobe need a writable temp dir and fail in odd ways without one.

## Development

```bash
cd backend && go run .              # port 8080, key auto-generated at ./data/secret.key
cd frontend && yarn && yarn dev     # dev server proxies /api → backend

cd backend && go test ./...
cd frontend && yarn build
```

Stack: Go (stdlib `net/http`, `modernc.org/sqlite`, `pkg/sftp`, `jlaffaye/ftp`, `anitogo`) · React + TypeScript + Vite + Tailwind v4 + TanStack Query.

Home Assistant add-on: [ZSleyer/WeebSync-Addon](https://github.com/ZSleyer/WeebSync-Addon).

The About page checks GitHub's public API (unauthenticated, cached ~6 h, no instance data sent) for a newer image; admins can turn it off under **Settings → About**.

## License

[AGPL-3.0](LICENSE).
