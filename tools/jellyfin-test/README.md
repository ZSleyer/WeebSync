# Jellyfin test server

A Jellyfin instance whose libraries copy the layout of a real Plex library:
the same library names and folder paths, every episode file (as a tiny mkv
with the original's audio and subtitle tracks) and the catalog ids, so the
media-server features can be compared between Plex and Jellyfin on the same
library.

Nothing here holds real data. The snapshot, the media tree and the server's
config live in `$DATA`, outside the repository
(default `~/.local/share/weebsync-jellyfin-test`). Never copy them in here.

## Build it

Needs Docker, ffmpeg, jq and python3.

```sh
export DATA=~/.local/share/weebsync-jellyfin-test
mkdir -p "$DATA"
# 1. snapshot the Plex library (read-only, the token only via env)
PLEX_URL=http://plex.lan:32400 PLEX_TOKEN=... python3 -I manifest.py "$DATA/manifest.json"
# 2. tiny mkv files in the same layout, with .nfo ids
python3 -I seed.py "$DATA/manifest.json" "$DATA/media"
# 3. server, admin, libraries, API key; JF_TVDB names the TVDB-ordered libraries
JF_TVDB="Animeserien" ./setup.sh jellyfin/jellyfin:12.2 8096
```

Admin login: `Chisato` / `lycoris`. The API key `weebsync` is in `$DATA/apikey`.
The first scan fetches metadata online and takes a while; the ids come from the
`.nfo` files either way.

## Connect WeebSync

Settings, Services, Jellyfin: URL `http://localhost:8096` (or the host's
address when WeebSync runs in a container), then Quick Connect and enter the
code in Jellyfin as Chisato (Settings, Quick Connect), or paste the API key.
With Plex connected as well, choose the server in use under Settings, Services, Media server.

## Notes

- Use Jellyfin 12.x. 10.11.0 returned empty episode listings for every show.
- Jellyfin makes one series per folder. A show Plex files under two folders
  (a dub kept apart, say) comes back as two series sharing a TVDB id; WeebSync
  bundles them into one show like Plex does.
- Quick Connect tokens are device sessions: removing the WeebSync device in
  Jellyfin's dashboard signs WeebSync out.
