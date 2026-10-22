<p align="center">
  <img src="frontend/public/favicon.svg" alt="" width="88">
</p>

<h1 align="center">WeebSync</h1>

<p align="center">
  Download and sync anime and series from your own SFTP and FTPS servers - with a catalog, auto-sync and a rename engine.
</p>

<p align="center">
  <a href="https://github.com/ZSleyer/WeebSync/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/ZSleyer/WeebSync"></a>
  <a href="https://github.com/ZSleyer/WeebSync/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZSleyer/WeebSync/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/ZSleyer/WeebSync"></a>
</p>

## Features

- **Your servers** - SFTP and FTPS (explicit or implicit TLS) behind one file browser, host keys pinned on first use
- **Download manager** - parallel downloads, live speed limits, resume, a trash for replaced copies
- **Auto-sync** - watch a folder and new episodes arrive on their own, with dub/sub filters and a release calendar
- **Catalog** - AniList, TMDB and TVDB metadata, folders matched to titles, suggestions for what is missing
- **Rename engine** - templates or regex, season folders, episode offsets, always previewed first
- **Player** - watch local and remote videos in the browser, subtitles included
- **Integrations** - Plex or Jellyfin, Home Assistant, web push and email, an optional assistant on any OpenAI-compatible endpoint
- **Accounts** - password, passkeys, TOTP and OIDC
- **App** - installable PWA, German and English, dark and light, works down to 320 px

## Quickstart

```bash
curl -O https://raw.githubusercontent.com/ZSleyer/WeebSync/main/docker-compose.yml
docker compose up -d
```

Open `http://localhost:8080` and enter the setup code the server writes to its log (`docker compose logs weebsync | grep setup_token`) - the first account you register becomes the admin. Accounts that sign themselves up later wait for an admin to approve them.

## Parameters

| Parameter | Function |
|---|---|
| `-p 8080:8080` | Web interface and API (plain HTTP) |
| `-e PUID=1000` / `-e PGID=1000` | User and group id that own the files WeebSync writes (default 65532; the container starts as root only to switch to them) |
| `-e TZ=Etc/UTC` | Timezone |
| `-e UMASK=022` | Permission mask for new files, optional |
| `-v /path/to/config:/config` | Database, secret key and default downloads |
| `-v /path/to/media:/media` | Media library as a sync target, optional - list it in `WEEBSYNC_DOWNLOADS` |

The compose file sets all of this, with the capabilities PUID/PGID need. Setups from before this layout (volume on `/data`, no `PUID`) keep running unchanged as user 65532. Every variable, `docker run`, `FILE__` secrets and the migration are in [docs/configuration.md](docs/configuration.md#parameters).

On Windows with Docker Desktop, see [docs/windows.md](docs/windows.md) for the PowerShell commands and the settings that differ.

WeebSync speaks plain HTTP; put it behind a TLS reverse proxy (Traefik, Caddy, Nginx). Everything else - media folders, OIDC, mail, metadata keys - is in [docs/configuration.md](docs/configuration.md).

Running Home Assistant? There is an add-on: [ZSleyer/WeebSync-Addon](https://github.com/ZSleyer/WeebSync-Addon).

## Image tags

| Tag | Moves |
|---|---|
| `ghcr.io/zsleyer/weebsync:latest` | with each release - **recommended** |
| `:2026.10` | with the fixes of that month's release |
| `:2026.10.1` | never - one exact release |
| `:nightly` | once a day from `main` |
| `:dev` | with every green push to `main` |

## Documentation

- [Configuration](docs/configuration.md) - environment variables, reverse proxy, file ownership, hardening
- [Windows](docs/windows.md) - Docker Desktop or Docker Engine in WSL 2: volumes, media drives, GPU
- [Home Assistant](docs/home-assistant.md) - sensors, triggers and events
- [Sonarr / Radarr / Prowlarr](docs/sonarr-radarr.md) - optional: WeebSync as indexer and download client
- [Development](docs/development.md) - local setup, stack, releases
- [Security policy](SECURITY.md)

## Credits

Inspired by [BastianGanze/weebsync](https://github.com/BastianGanze/weebsync). This is a ground-up reimplementation - it shares the idea, not the code. A spare-time project, used at your own risk.

## License

[AGPL-3.0](LICENSE)
