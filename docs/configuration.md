# Configuration

Everything here is optional - a bare `docker compose up -d` gives you a working instance. The [compose file](../docker-compose.yml) carries every variable below as a commented example.

## Reverse proxy

WeebSync does not terminate TLS. Bind it to loopback (the compose file does) and put a TLS proxy in front. For an instance reachable from the internet:

- set `WEEBSYNC_BASE_URL` to the public origin,
- set `WEEBSYNC_TRUSTED_PROXY` to the proxy's address so the real client IP is used,
- set `WEEBSYNC_FORCE_HTTPS=true`,
- and disable registration under **Settings → Security** once your accounts exist.

## Environment variables

### Runtime

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone for log timestamps, any IANA name |
| `WEEBSYNC_ADDR` | `:8080` | Listen address |
| `WEEBSYNC_DATA` | `/data` | SQLite database and default downloads |
| `WEEBSYNC_DOWNLOADS` | `$WEEBSYNC_DATA/downloads` | `:`-separated allowlist of local roots; the first is the default download dir. Mount your media anywhere and list the mounts (`/media:/data/downloads`) - only these paths are browsable and writable |
| `WEEBSYNC_SECRET` | auto-generated | Key for stored credentials. Without it, `$WEEBSYNC_DATA/secret.key` is created on first start. **Back it up** - a lost key makes stored passwords unreadable |
| `WEEBSYNC_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |

### Also settable in the UI

A variable that is set **overrides** the UI and locks the field. Booleans accept `1`, `true`, `yes`.

| Variable | Description |
|---|---|
| `WEEBSYNC_BASE_URL` | Public origin, used for links in emails |
| `WEEBSYNC_TRUSTED_PROXY` | Comma-separated IPs/CIDRs whose `X-Forwarded-*` headers are believed (`true` trusts every peer). Only behind a proxy that overwrites those headers |
| `WEEBSYNC_FORCE_HTTPS` | `Secure` on all cookies |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | Generic OIDC login (Authentik, Keycloak, ...). The redirect URL is `<base>/api/auth/oidc/callback` |
| `OIDC_PROVIDER_NAME` | Label on the login button |
| `OIDC_CLAIM`, `OIDC_ADMIN_VALUES`, `OIDC_USER_VALUES` | Role mapping: the claim to read (e.g. `groups`, requested as a scope) and the comma-separated values granting admin or user access. With admin values set, the IdP owns all roles |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Outgoing mail (password reset, notifications) |
| `SMTP_SECURITY` | `starttls` (default), `tls`, `none` |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` | Your own AniList OAuth app; without it a public pin-flow client is used |
| `ANILIST_TOKEN` | Operator token for background matching instead of a linked account (no UI counterpart) |
| `TMDB_API_KEY`, `TVDB_API_KEY` | Movie and series metadata |
| `ANIMESCHEDULE_TOKEN` | Release dates for the calendar |
| `PLEX_URL`, `PLEX_TOKEN` | Plex server; its libraries are matched against your series |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | OpenAI-compatible endpoint for the assistant |
| `AI_SEARCH_URL` | SearXNG instance the assistant may search |

## File ownership

The container runs as `nonroot` (uid/gid 65532) and has no `PUID`/`PGID` entrypoint. To write your media with your own ids, hand them to Docker:

```yaml
services:
  weebsync:
    user: "1000:1000"   # $(id -u):$(id -g) of the media owner
    group_add: ["990"]  # extra groups with write access to the mounts
```

The data dir must belong to that user too: `mkdir -p data && chown 1000:1000 data` before the first start (Docker creates a missing bind dir as root). The Home Assistant add-on is unaffected.

## Hardening

The compose file drops all capabilities, sets `no-new-privileges` and mounts the root filesystem read-only - keep those lines when you adapt it. Writes go to `/data`, the media mounts and a `tmpfs` on `/tmp` and `/var/tmp`; SQLite and ffprobe need a writable temp dir and fail in odd ways without one.

## Update check

**Settings → About** asks GitHub's public API whether a newer image exists for the channel you run (release, nightly or dev). It is unauthenticated, cached for six hours and sends nothing about your instance. Admins can turn it off on the same page.
