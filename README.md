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

Latest dev image: `ghcr.io/zsleyer/weebsync:dev` (published on every green `main` build; `:dev-<sha>` pins a specific commit).

## Configuration (env)

All optional. Env values **override** UI settings and lock the field.

| Variable | Default | Description |
|---|---|---|
| `WEEBSYNC_SECRET` | auto-generated | AES-GCM key for server passwords. Else `$WEEBSYNC_DATA/secret.key` (0600) on first start. **Back it up** - lost key = unreadable credentials |
| `WEEBSYNC_ADDR` | `:8080` | Listen address |
| `WEEBSYNC_DATA` | `/data` | SQLite DB + downloads |
| `WEEBSYNC_DOWNLOADS` | `$WEEBSYNC_DATA/downloads` | Download root (all local ops confined here) |
| `WEEBSYNC_TRUSTED_PROXY` | `false` | Trust `X-Forwarded-*` only behind a proxy that overwrites them |
| `WEEBSYNC_FORCE_HTTPS` | `false` | Force `Secure` on all cookies (recommended behind a TLS proxy) |
| `ANILIST_TOKEN` / `OIDC_*` | - | Override their UI counterparts |

Runs **behind a TLS reverse proxy** (Traefik/Nginx/Caddy) - it does not terminate TLS itself. For public instances set `WEEBSYNC_TRUSTED_PROXY=true` + `WEEBSYNC_FORCE_HTTPS=true` and keep registration closed.

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
