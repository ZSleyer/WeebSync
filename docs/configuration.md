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

## Parameters

The image's ports, volumes and settings in one table, in the style of the linuxserver.io images. `docker run` and compose take the same values.

| Parameter | Function |
|---|---|
| `-p 8080:8080` | The web interface and API (plain HTTP, see [Reverse proxy](#reverse-proxy)) |
| `-e PUID=1000` | User id that owns the files WeebSync writes |
| `-e PGID=1000` | Group id that owns them |
| `-e TZ=Etc/UTC` | Timezone, any [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) |
| `-e UMASK=022` | Permission mask for new files, optional |
| `-v /path/to/config:/config` | Database, secret key and default downloads. Earlier images used `/data`, which still works |
| `-e WEEBSYNC_DATA=/config` | Optional with the volume on `/config` (detected), needed by `docker exec` commands |
| `-v /path/to/media:/media` | A media library as a sync target, optional. List it in `WEEBSYNC_DOWNLOADS` |
| `-v /path/to/downloads:/downloads` | A download folder, optional, same rule |
| `--user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --cap-add SETUID --cap-add SETGID` | What PUID and PGID need: start as root, change ownership of `/config`, drop to your user. Without `--user 0:0` the container runs as 65532 and ignores both |
| `--read-only --tmpfs /tmp --tmpfs /var/tmp` | Supported and set in the compose file, see [Hardening](#hardening) |

```bash
docker run -d --name weebsync \
  --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true --read-only --tmpfs /tmp --tmpfs /var/tmp \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC -e WEEBSYNC_DATA=/config \
  -p 127.0.0.1:8080:8080 \
  -v /path/to/config:/config \
  --restart unless-stopped \
  ghcr.io/zsleyer/weebsync:latest
```

The image checks its own health (`/healthz`), and carries the usual `org.opencontainers.image.*` labels.

### Coming from the `/data` layout

A container started the old way (volume on `/data`, no `PUID`, no `user: "0:0"`) keeps running as 65532 on `/data`, so an image update alone changes nothing. The image switches to `/config` only when a volume is mounted there; if you mount both, `/config` wins.

To adopt the new layout:

1. Change the mount target from `/data` to `/config`; the host folder stays. The compose file's volume line is `./data:/config`.
2. Add the lines from the current compose file (`user: "0:0"`, `PUID`, `PGID`, `cap_add`, `WEEBSYNC_DATA`). Re-downloading the file overwrites your edits, so merge it.
3. `PUID` and `PGID` default to 65532 in the compose file, the owner your data already has, so the first start changes nothing for a setup that ran without `user:`. If you ran with `user: "1000:1000"` (or other ids) before, set `PUID` and `PGID` to those ids, otherwise the config folder is handed to 65532 and the app can no longer write the download folders owned by your user. Set them to the host user (`id -u`, `id -g`) if you want your own ids instead. The start-up then hands the config folder, and only that, to the new owner.
4. Download and media folders are never walked, so files WeebSync wrote there as 65532 keep that owner. After switching ids, run a one-time `chown -R PUID:PGID` on them on the host. Folders you list in `WEEBSYNC_DOWNLOADS` that sit on a mount of their own need the same.

## Environment variables

### Container

Read by the image's start-up, before the app runs. They follow the [linuxserver.io](https://docs.linuxserver.io/general/understanding-puid-and-pgid) conventions. The ports and volumes are in [Parameters](#parameters).

| Variable | Default | Description |
|---|---|---|
| `PUID` | `65532` | User id the app runs as. Takes effect when the container starts as root, which the [compose file](../docker-compose.yml) does (`user: "0:0"`); see [File ownership](#file-ownership) |
| `PGID` | `65532` | Group id the app runs as, same condition as `PUID` |
| `UMASK` | `022` (the container's own) | Octal permission mask for new files, for example `002` for group-writable media |
| `FILE__<NAME>` | - | Reads the value of `<NAME>` from the file this points to, for Docker secrets: `FILE__WEEBSYNC_SECRET=/run/secrets/weebsync_secret`. Works for every variable on this page |

### Runtime

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone for log timestamps, any IANA name |
| `WEEBSYNC_ADDR` | `:8080` | Listen address |
| `WEEBSYNC_DATA` | `/config` if a volume is mounted there, else `/data` | SQLite database, secret key and default downloads. Mount your volume on `/config` (the compose file does) or, as with earlier images, on `/data`. The image picks the one in use; set the variable to be explicit, which `docker exec` commands such as `reset-password` need for `/config` |
| `WEEBSYNC_DOWNLOADS` | `$WEEBSYNC_DATA/downloads` | `:`-separated allowlist of local roots; the first is the default download dir. Mount your media anywhere and list the mounts (`/media:/config/downloads`) - only these paths are browsable and writable |
| `WEEBSYNC_SECRET` | auto-generated | Key for stored credentials. Without it, `$WEEBSYNC_DATA/secret.key` is created on first start. **Back it up** - a lost key makes stored passwords unreadable |
| `WEEBSYNC_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `WEEBSYNC_SETUP_TOKEN` | random, logged | The code the setup wizard asks for while no account exists |
| `WEEBSYNC_HWACCEL` | `auto` | GPU encoder for the player's transcodes: `auto` tries NVENC, then VA-API on each `/dev/dri/renderD*`, and falls back to software; `nvenc`, `vaapi` or `none` pick one. A GPU writes 1080p, software 720p. The log says which one is used (`player transcodes on the GPU`), and so does Settings, Transfers. See [Hardware transcoding](#hardware-transcoding) |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | system roots | A CA bundle file or directory to trust for outgoing TLS (mail, FTPS, OIDC, Plex, Jellyfin, the AI endpoint) - for services with a certificate from your own CA. Certificates are always verified; there is no switch to skip that |

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
| `JELLYFIN_URL`, `JELLYFIN_TOKEN` | Jellyfin server, used for the same library features as Plex; the token is an API key from the Jellyfin dashboard. Easier from the UI, where Quick Connect signs in with a code. Jellyfin keeps no per-episode track choice, so the Plex audio/subtitle selection has no Jellyfin counterpart. TVDB episode order needs the TheTVDB plugin on the library |
| `MEDIA_SERVER` | `plex` or `jellyfin`: which one runs the library features when both are connected. Unset, the server connected first stays in use; two connected at once wait until one is chosen (Settings, Services) |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | OpenAI-compatible endpoint for the assistant; plain `http://` only for an address in your own network |
| `AI_SEARCH_URL` | SearXNG instance the assistant may search |

## Hardware transcoding

What the browser cannot play, the player transcodes. With a GPU that writes 1080p and leaves the CPU alone; in software it is 720p. `WEEBSYNC_HWACCEL` (default `auto`) picks the encoder, and the log says which one is used (`player transcodes on the GPU`).

- **Intel and AMD** (VA-API): the amd64 image carries the drivers. Pass the render nodes and the id of the host group that owns them (`getent group render`):

  ```yaml
  devices: ["/dev/dri:/dev/dri"]
  group_add: ["989"] # your render group id
  ```

  Building the image yourself, `--build-arg VAAPI_AMD=0` leaves out mesa's AMD driver (about 200 MB); Intel and NVIDIA are not affected.

- **NVIDIA** (NVENC): the image is Debian (glibc) with an ffmpeg that has `h264_nvenc`, so the NVIDIA container toolkit can inject the driver libraries. Install the toolkit on the host and give the container the GPU:

  ```yaml
  gpus: all   # or deploy.resources.reservations.devices with driver: nvidia
  ```

- **arm64** (Raspberry Pi): no hardware encoder; transcodes run in software.

**Check it in the app.** Settings, Transfers, "Hardware transcoding" (admins) shows the encoder in use and, for each candidate, whether it works and why not: no GPU passed in, a render node the server's user may not open (with the group id to add to `group_add`), a driver that fails its test encode (an NVIDIA card's render node is no VA-API device), or no NVIDIA GPU visible. "Test again" runs the probe on demand and replaces the choice made at the first transcode; `GET /api/admin/hwaccel` and `POST /api/admin/hwaccel/probe` return the same.

## File ownership

By default the app runs as `nonroot` (uid/gid 65532). To write your media with your own ids, give the container `PUID` and `PGID`, as on linuxserver.io images:

```yaml
services:
  weebsync:
    user: "0:0"          # start as root, only to switch user
    cap_add: [CHOWN, DAC_READ_SEARCH, SETUID, SETGID]
    environment:
      PUID: 1000         # `id -u` of the media owner, default 65532
      PGID: 1000         # `id -g`
    group_add: ["990"]   # extra groups with write access to the mounts, optional
```

Next to `cap_drop: [ALL]` from the compose file, that is all it takes. At start the container hands `/config` to `PUID:PGID` (only that folder; it never walks your media mounts, never crosses into another file system and does not descend into the folders listed in `WEEBSYNC_DOWNLOADS`, so a large library starts as fast as an empty one), drops root together with those capabilities and runs the app. Files that already sit in a download folder keep their owner. `group_add` groups are kept.

The other way works as before and needs no capabilities: run as the user directly with `user: "1000:1000"` (no `PUID`, no `cap_add`; `PUID`/`PGID` are then ignored and the log says so). `/config` must belong to that user: `mkdir -p data && chown 1000:1000 data` before the first start (Docker creates a missing bind dir as root). Use this if your setup forbids a container to start as root. The Home Assistant add-on is unaffected.

## Hardening

The compose file drops all capabilities except the four the start-up needs and loses them before the app runs, sets `no-new-privileges` and mounts the root filesystem read-only - keep those lines when you adapt it. With `user: "1000:1000"` instead of `PUID`, `cap_add` is not needed. Writes go to `/config`, the media mounts and a `tmpfs` on `/tmp` and `/var/tmp`; SQLite and ffprobe need a writable temp dir and fail in odd ways without one.

## Locked out

When nobody can sign in any more, set a new password from the shell where the data dir is:

```sh
docker compose exec -u 1000:1000 -it weebsync /weebsync reset-password admin@example.com
# plain docker (use your own PUID:PGID; 65532:65532 if you set none):
docker exec -u 1000:1000 -it weebsync /weebsync reset-password admin@example.com
```

Run it as the user the app runs as (`-u`, put in your `PUID:PGID`; the shell does not know the values from compose's `.env`): `exec` otherwise starts as root in a container that began as root, and the database it touches would change owner. The compose file sets `WEEBSYNC_DATA=/config`, which the command needs to find the database, because `exec` does not see what the start-up chose. With a plain `docker run`, pass `-e WEEBSYNC_DATA=/config` there too (or `-e WEEBSYNC_DATA=/data` if your volume is on `/data`).

It asks for the new password twice without showing it; piped in, it takes the first line. The account's sessions end and its address counts as verified. An admin can also set a password for any account under **Settings → Users**.

## Update check

**Settings → About** asks GitHub's public API whether a newer image exists for the channel you run (release, nightly or dev). It is unauthenticated, cached for six hours and sends nothing about your instance. Admins can turn it off on the same page.
