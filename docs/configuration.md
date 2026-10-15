# Configuration

Everything here is optional - a bare `docker compose up -d` gives you a working instance. The [compose file](../docker-compose.yml) carries every variable below as a commented example.

## Reverse proxy

WeebSync does not terminate TLS. Bind it to loopback (the compose file does) and put a TLS proxy in front. For an instance reachable from the internet:

- set `WEEBSYNC_BASE_URL` to the public origin,
- set `WEEBSYNC_TRUSTED_PROXY` to the proxy's address so the real client IP is used,
- set `WEEBSYNC_FORCE_HTTPS=true`,
- and disable registration under **Settings → Security** once your accounts exist (accounts that sign themselves up wait for an admin's approval either way).

**Settings → Security** opens with a review of the setup: it names what is still missing (HTTPS, the trusted proxy, an admin without a second factor, mail or integrations reached in clear text, ...) and what to do about it. Its transport checks describe the way you reached it, so open it through the proxy.

A fresh instance takes its first account only with the setup code it writes to the log at startup (`setup_token`), so nobody who reaches it before you can claim it. Set `WEEBSYNC_SETUP_TOKEN` to choose the code up front.

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
| `WEEBSYNC_SETUP_TOKEN` | random, logged | The code the setup wizard asks for while no account exists |
| `WEEBSYNC_HWACCEL` | `auto` | GPU encoder for the player's transcodes: `auto` tries NVENC, then VA-API on each `/dev/dri/renderD*`, and falls back to software; `nvenc`, `vaapi` or `none` pick one. A GPU writes 1080p, software 720p. The log says which one is used (`player transcodes on the GPU`). See [Hardware transcoding](#hardware-transcoding) |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | system roots | A CA bundle file or directory to trust for outgoing TLS (mail, FTPS, OIDC, Plex, the AI endpoint) - for services with a certificate from your own CA. Certificates are always verified; there is no switch to skip that |

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
| `SMTP_SECURITY` | `starttls` (default, port 587), `tls` (port 465), `none` (port 25; no login unless the relay runs on the same machine) |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` | Your own AniList OAuth app; without it a public pin-flow client is used |
| `ANILIST_TOKEN` | Operator token for background matching instead of a linked account (no UI counterpart) |
| `TMDB_API_KEY`, `TVDB_API_KEY` | Movie and series metadata |
| `ANIMESCHEDULE_TOKEN` | Release dates for the calendar |
| `PLEX_URL`, `PLEX_TOKEN` | Plex server; its libraries are matched against your series. Plain `http://` only for an address in your own network - from outside use the server's `https://…plex.direct` address |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | OpenAI-compatible endpoint for the assistant; plain `http://` only for an address in your own network |
| `AI_SEARCH_URL` | SearXNG instance the assistant may search |

## Hardware transcoding

What the browser cannot play, the player transcodes. With a GPU that writes 1080p and leaves the CPU alone; in software it is 720p. `WEEBSYNC_HWACCEL` (default `auto`) picks the encoder, and the log says which one is used (`player transcodes on the GPU`).

- **Intel and AMD** (VA-API): the amd64 image carries the drivers. Pass the render nodes and the id of the host group that owns them (`getent group render`):

  ```yaml
  devices: ["/dev/dri:/dev/dri"]
  group_add: ["989"] # your render group id
  ```

- **NVIDIA** (NVENC): only where WeebSync runs outside the container with an ffmpeg built with NVENC. The image is Alpine (musl) and cannot load NVIDIA's driver libraries.
- **arm64** (Raspberry Pi): no hardware encoder; transcodes run in software.

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

## Locked out

When nobody can sign in any more, set a new password from the shell where the data dir is:

```sh
docker compose exec -it weebsync /weebsync reset-password admin@example.com
```

It asks for the new password twice without showing it; piped in, it takes the first line. The account's sessions end and its address counts as verified. An admin can also set a password for any account under **Settings → Users**.

## Update check

**Settings → About** asks GitHub's public API whether a newer image exists for the channel you run (release, nightly or dev). It is unauthenticated, cached for six hours and sends nothing about your instance. Admins can turn it off on the same page.
