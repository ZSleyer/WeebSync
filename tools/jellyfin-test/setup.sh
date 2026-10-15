#!/usr/bin/env bash
# Starts a Jellyfin test server on the seeded media and configures it without
# the web wizard: admin Chisato (password lycoris), one library per manifest
# section with the same name and paths, an API key "weebsync" for WeebSync.
#
#   DATA=~/.local/share/weebsync-jellyfin-test ./setup.sh [image] [port]
#
# The config lives in $DATA/config: rerunning starts from scratch. With
# JF_TVDB="Animeserien" (comma-separated library names) the TheTVDB plugin is
# installed and made the first metadata source there, like a TVDB-ordered
# Plex library; without it Jellyfin orders every library by TMDB.
set -euo pipefail
[ -n "${JF_DEBUG:-}" ] && set -x
DATA="${DATA:-$HOME/.local/share/weebsync-jellyfin-test}"
IMG="${1:-jellyfin/jellyfin:12.2}"
PORT="${2:-8096}"
NAME=weebsync-jellyfin-test
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -d "$DATA/media" ] || { echo "seed $DATA/media first (seed.py)" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
rm -rf "$DATA/config" "$DATA/cache"
mkdir -p "$DATA/config" "$DATA/cache"
docker run -d --name "$NAME" --restart unless-stopped --user "$(id -u):$(id -g)" -p "$PORT:8096" \
  -v "$DATA/config:/config" -v "$DATA/cache:/cache" -v "$DATA/media:/media:ro" "$IMG" >/dev/null

J="http://localhost:$PORT"; H='Content-Type: application/json'
# the public info answers before the startup endpoints do; this GET also
# creates the first user, so the POST below finds it
for _ in $(seq 1 90); do curl -sf "$J/Startup/User" >/dev/null && break; sleep 2; done
curl -sf -XPOST "$J/Startup/Configuration" -H "$H" -d '{"UICulture":"de","MetadataCountryCode":"DE","PreferredMetadataLanguage":"de"}'
curl -sf -XPOST "$J/Startup/User" -H "$H" -d '{"Name":"Chisato","Password":"lycoris"}'
curl -sf -XPOST "$J/Startup/Complete"
curl -sf -XPOST "$J/Users/AuthenticateByName" -H "$H" \
  -H 'Authorization: MediaBrowser Client="setup", Device="cli", DeviceId="weebsync-test-setup", Version="1"' \
  -d '{"Username":"Chisato","Pw":"lycoris"}' >"$DATA/auth.json"
A="Authorization: MediaBrowser Token=\"$(jq -r .AccessToken "$DATA/auth.json")\""

# the container sees $DATA/media at /media, which is where the snapshot's paths start
jq -c '.sections[]' "$DATA/manifest.json" | while read -r s; do
  q="name=$(jq -rn --arg v "$(jq -r .title <<<"$s")" '$v|@uri')"
  q+="&collectionType=$(jq -r 'if .type=="show" then "tvshows" else "movies" end' <<<"$s")&refreshLibrary=false"
  q+=$(jq -r '[.locations[] | "&paths=" + (. | @uri)] | join("")' <<<"$s")
  curl -sf -XPOST "$J/Library/VirtualFolders?$q" -H "$A" -H "$H" -d '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'
done

if [ -n "${JF_TVDB:-}" ]; then
  guid=$(curl -sf "$J/Packages" -H "$A" | jq -r '.[] | select(.name=="TheTVDB") | .guid')
  ver=$(curl -sf "$J/Packages" -H "$A" | jq -r '.[] | select(.name=="TheTVDB") | .versions[0].version')
  curl -sf -XPOST "$J/Packages/Installed/TheTVDB?assemblyGuid=$guid&version=$ver" -H "$A"
  sleep 15
  curl -sf -XPOST "$J/System/Restart" -H "$A" || true
  sleep 5
  for _ in $(seq 1 90); do curl -sf "$J/System/Info/Public" >/dev/null && break; sleep 2; done
  fetchers='["TheTVDB","TheMovieDb"]'
  IFS=, read -ra libs <<<"$JF_TVDB"
  for lib in "${libs[@]}"; do
    curl -sf "$J/Library/VirtualFolders" -H "$A" | jq --arg n "$lib" --argjson f "$fetchers" '.[] | select(.Name==$n) |
      {Id: .ItemId, LibraryOptions: (.LibraryOptions | .TypeOptions = [("Series","Season","Episode") as $t |
        {Type: $t, MetadataFetchers: $f, MetadataFetcherOrder: $f, ImageFetchers: [], ImageFetcherOrder: []}])}' >"$DATA/libopts.json"
    curl -sf -XPOST "$J/Library/VirtualFolders/LibraryOptions" -H "$A" -H "$H" -d @"$DATA/libopts.json"
  done
fi

curl -sf -XPOST "$J/Auth/Keys?app=weebsync" -H "$A"
curl -sf "$J/Auth/Keys" -H "$A" | jq -r '.Items[] | select(.AppName=="weebsync") | .AccessToken' >"$DATA/apikey"
curl -sf -XPOST "$J/Library/Refresh" -H "$A"
echo "$NAME on $J, API key in $DATA/apikey; the first scan takes a while (Dashboard, Scheduled tasks)"
