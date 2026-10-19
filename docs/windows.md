# Windows with Docker Desktop

WeebSync ships as a Linux container, so on Windows it runs through Docker Desktop. Use the WSL 2 backend (Settings → General → *Use the WSL 2 based engine*); Windows 10 and 11 are supported. There is no native Windows build. If you would rather not install Docker Desktop, [Docker Engine inside a WSL 2 distribution](#without-docker-desktop) works too.

WSL 2 needs hardware virtualization with second-level address translation (SLAT). Running Windows itself in a VM? Then the VM needs nested virtualization: a KVM guest worked, a VirtualBox guest failed to start WSL 2 with `HCS_E_HYPERV_NOT_INSTALLED` because VirtualBox does not pass SLAT through.

## Install

Open PowerShell in an empty folder, for example `C:\weebsync`, and fetch the compose file. In Windows PowerShell 5.1 `curl` is an alias of `Invoke-WebRequest` and does not understand `-O`, so name the program or use the cmdlet:

```powershell
curl.exe -O https://raw.githubusercontent.com/ZSleyer/WeebSync/main/docker-compose.yml
# or
Invoke-WebRequest https://raw.githubusercontent.com/ZSleyer/WeebSync/main/docker-compose.yml -OutFile docker-compose.yml
```

The file as shipped works, but two lines want a change on Windows (below): the `/data` volume and your media mount. The [example at the end](#complete-example) has both. Then:

```powershell
docker compose up -d
docker compose logs weebsync | Select-String setup_token
```

Open `http://localhost:8080` and enter the setup code from the log. The first account you register becomes the admin. (`findstr setup_token` instead of `Select-String` works too.)

## Keep /data in a named volume

`/data` holds the SQLite database (in WAL mode) and the key that encrypts your stored passwords. A bind mount of a Windows folder (`./data` under `C:\...`) goes through Docker Desktop's file sharing, which is slower and less reliable for a database. Docker's own advice for WSL 2 is that bind mounts perform much better from the Linux file system than from Windows paths.

Use a named volume instead:

```yaml
    volumes:
      - weebsync-data:/data

volumes:
  weebsync-data:
    name: weebsync-data
```

The image creates `/data` owned by its unprivileged user (uid 65532), so a fresh named volume is writable without further steps. The `name:` line keeps the volume called `weebsync-data` instead of getting the folder name as a prefix.

Keeping the whole project in the WSL file system (`\\wsl$\<distro>\home\you\weebsync`, with `./data` next to the compose file) works as well. In that case `./data` must be writable by uid 65532.

### Backup

The image has no shell and no `tar`, so back the volume up with a separate image. Stop WeebSync first so the database is not copied mid-write:

```powershell
docker compose stop weebsync
docker run --rm -v weebsync-data:/data:ro -v "${PWD}:/backup" alpine tar czf /backup/weebsync-data.tgz -C /data .
docker compose start weebsync
```

The archive includes `secret.key`. Without it the stored passwords are unreadable, so keep the archive somewhere safe (it holds the key next to the data it protects). Restore into an empty volume with `tar xzf /backup/weebsync-data.tgz -C /data` in the same kind of `docker run`, then `chown -R 65532:65532 /data`.

## Media drives

Mount a Windows folder into the container and list the mount in `WEEBSYNC_DOWNLOADS`, the `:`-separated allowlist of local roots (the first entry is the default download folder, see [Configuration](configuration.md)):

```yaml
    volumes:
      - type: bind
        source: D:/Anime
        target: /media
    environment:
      WEEBSYNC_DOWNLOADS: /media:/data/downloads
```

Use forward slashes in the path. In WeebSync, the folder then shows up as `/media` in the file browser and in the targets of watches.

Leave `user:` and `group_add:` out. Those set Linux file ownership, which a Windows drive does not have; the container's default user writes through Docker Desktop's file sharing. See [File ownership](configuration.md#file-ownership) for Linux hosts.

### Files added from Windows

WeebSync notices changes to local folders with inotify. Docker Desktop shows a bind-mounted Windows drive to the container as a 9p file system, and files created from the Windows side raise no inotify event inside the container. WeebSync therefore treats such a folder as not watchable and reads it again every 5 minutes: files you copy into `D:\Anime` with Explorer or another program show up within about 5 minutes. Files that WeebSync writes itself are seen at once, because writes through the container's own mount do raise events.

## GPU

The player transcodes what the browser cannot play. In software that is 720p; a GPU writes 1080p. **Settings → Transfers** shows which encoder is in use and why another is not.

- **NVIDIA** works with Docker Desktop on the WSL 2 backend. Docker's requirements: current NVIDIA drivers with WSL 2 support, an up-to-date WSL 2 kernel (`wsl --update`) and Windows kept up to date. Add `gpus: all` to the service.
- **Intel and AMD** (VA-API through `/dev/dri`) are not available on Docker Desktop with WSL 2 (there is no `/dev/dri` render node to pass in). The player falls back to software.

## Timezone

Log timestamps use `TZ`, `UTC` by default. Put an IANA name in a file called `.env` next to the compose file (the compose file reads it):

```
TZ=Europe/Berlin
```

## Network access

The compose file binds `127.0.0.1:8080`, so only the PC itself can reach WeebSync. To use it from other devices, put a TLS reverse proxy in front as described under [Reverse proxy](configuration.md#reverse-proxy). Publishing `"8080:8080"` instead serves plain HTTP to everything that can reach the PC, so do that only on a network you trust. Windows Defender Firewall may then ask whether to allow Docker Desktop, or you add an inbound rule for TCP 8080 yourself.

## Updates

```powershell
docker compose pull
docker compose up -d
```

Your data lives in the volume and survives. The image tags are listed in the [README](../README.md#image-tags).

## Start with Windows

`restart: unless-stopped` brings WeebSync back whenever Docker Desktop starts, but Docker Desktop itself only starts when you sign in. Turn on **Settings → General → Start Docker Desktop when you sign in to your computer** so WeebSync is up after a reboot. Keep the hardening lines (`cap_drop`, `read_only`, `tmpfs`) - they work on Docker Desktop.

## Without Docker Desktop

Docker Engine runs fine inside a WSL 2 distribution, no Docker Desktop needed. The steps below were run on Windows 11 with Debian 13.

1. Install the distribution from PowerShell: `wsl --install -d Debian`.
2. Enable systemd. In the distribution, put this in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows and open the distribution again:

   ```ini
   [boot]
   systemd=true
   ```

3. Install Docker and the compose plugin. Debian's own packages are enough (`docker.io` 26.1, `docker-compose` 2.26, and `docker compose` works):

   ```bash
   sudo apt install docker.io docker-compose
   sudo usermod -aG docker $USER
   ```

   Docker's own apt repository gives a newer engine. Log out of the distribution and back in so the group applies.
4. Fetch the compose file inside the distribution (`curl -O` with the URL from [Install](#install)) and edit it as in the [complete example](#complete-example).

Differences from Docker Desktop:

- **Media drives.** Windows drives appear in WSL under `/mnt/c`, `/mnt/d` and so on, so the media mount becomes `source: /mnt/d/Anime`. It is the same 9p file system (`mountinfo` shows `9p ... aname=drvfs`), so the 5 minute re-read from [Files added from Windows](#files-added-from-windows) applies here too.
- **Project and data.** Keep the compose project and the named volume inside the WSL file system, not under `/mnt`.
- **Reaching WeebSync.** Microsoft documents that WSL forwards localhost ports by default, so a port published in WSL is reachable from Windows as `http://localhost:8080`.
- **Start with Windows.** WSL does not start at Windows sign-in by itself. The distribution has to be started, for example by opening it once or with a scheduled task running `wsl.exe -d Debian`. With systemd the docker service starts with it, and `restart: unless-stopped` brings WeebSync up.
- **GPU.** NVIDIA in WSL 2 needs the NVIDIA Container Toolkit installed inside the distribution (a requirement, not tested here). Intel and AMD are not available, as with Docker Desktop.

## Complete example

`docker-compose.yml` with the hardening kept, a named volume and one media mount. Adjust the drive and the timezone. This file was run unchanged under Docker Desktop (with `C:/anime` as the source): the container became healthy, the log showed the setup code, `http://localhost:8080` answered, and the named volume held `weebsync.db`, `secret.key` and `downloads` owned by uid 65532. Under WSL 2 without Docker Desktop, use `/mnt/d/Anime` as the source.

```yaml
services:
  weebsync:
    image: ghcr.io/zsleyer/weebsync:latest
    # NVIDIA GPU for the player (see "GPU"):
    # gpus: all
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - weebsync-data:/data
      - type: bind
        source: D:/Anime
        target: /media
    environment:
      TZ: ${TZ:-UTC}
      WEEBSYNC_DOWNLOADS: /media:/data/downloads
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    read_only: true
    tmpfs: [/tmp, /var/tmp]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  weebsync-data:
    name: weebsync-data
```
