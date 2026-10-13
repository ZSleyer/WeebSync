# Sonarr / Radarr / Prowlarr

Optional. WeebSync can act as a source for Sonarr and Radarr: it shows up there
as an **indexer** (Newznab) and a **download client** (SABnzbd). Both are
interfaces the apps support out of the box, so nothing has to be installed in
them. Sonarr and Radarr decide what to grab - quality profile, cutoff,
upgrades, custom formats, language - and WeebSync fetches the chosen release
from its server into a download folder the app imports from.

Nothing changes for an install that does not turn it on: the routes answer
404 and no background job runs. Auto-syncs, one-off syncs and everything else
work the same either way.

## Turn it on

Settings → Integrations → **Sonarr / Radarr**:

1. *Turn on (create key)*. The key stays visible on this page; it is the API
   key for the indexer and the download client in every app. *New key*
   revokes the old one, so every app has to get the new one.
2. **Download folder**: where grabs land, one folder per release. It must be
   inside a download root (`WEEBSYNC_DOWNLOADS`) and visible to Sonarr/Radarr.
   This is required: without it the download client test in the apps fails
   with "WeebSync has no download folder for Sonarr/Radarr yet".
3. **Path mapping**, only when the apps see that folder under another path:
   one line `appPath => localPath`, e.g. `/downloads => /mnt/media/downloads`.
   See [Docker: different paths](#docker-different-paths).

## In Sonarr and Radarr

**Indexer** → add → *Newznab* (custom):

| Field | Value |
| --- | --- |
| URL | `http://weebsync.example.com:8080/api/arr/newznab` |
| API Path | `/api` |
| API Key | the key from above |
| Categories | Sonarr `5000, 5040`; Radarr `2000` |
| Anime Categories (Sonarr) | `5070` |
| Anime Standard Format Search (Sonarr) | on |

Sonarr searches series of the type *Anime* by title and absolute number,
which WeebSync does not answer (it searches by TVDB id). With *Anime Standard
Format Search* on, Sonarr also asks by TVDB id, season and episode.

The indexer test asks for the newest releases. It fails with "Query
successful, but no results in the configured categories were returned" as
long as WeebSync has not matched any remote folder yet: let the remote index
and the catalog run first (Files → a server, or wait for the background
crawl), then add the indexer.

**Download client** → add → *SABnzbd*:

| Field | Value |
| --- | --- |
| Host / Port | WeebSync's host and port |
| URL Base | `/api/arr/sab` (or empty) |
| API Key | the key from above |
| Username / Password | empty |
| Category | `tv` (Sonarr), `movies` (Radarr) |

*URL Base* is an advanced setting: click *Show Advanced* to see it. Left empty
the app asks `/api`, which WeebSync answers as well.

Use the address the apps reach WeebSync under - in a Docker setup usually the
container name, not the public URL.

## Docker: different paths

WeebSync tells the app where a finished release lies, as a path on its own
side. If Sonarr/Radarr run in another container and mount that folder under
another path, Sonarr warns:

> You are using docker; download client WeebSync places downloads in
> /media/downloads/tv but this directory does not appear to exist inside the
> container. Review your remote path mappings and container volume settings.

Fix it in **one** of two places, not both:

- **In WeebSync**, field *Path mapping*: `appPath => localPath`, e.g.
  `/downloads => /media/downloads` when Sonarr mounts the folder as
  `/downloads`. WeebSync then reports paths the way Sonarr sees them.
- **In Sonarr/Radarr**, Settings → Download Clients → *Remote Path Mappings*
  (advanced): Host = the host entered for the WeebSync download client,
  Remote Path = the download folder as WeebSync sees it (`/media/downloads/`),
  Local Path = the same folder inside the Sonarr container (`/downloads/`).

A path like `/anime` or `/tv` in that warning (only the category, no folder in
front) means the download folder in WeebSync is not set.

## In Prowlarr

Indexers → add → *Generic Newznab* with the same URL, API path and key.
Prowlarr hands it to Sonarr and Radarr like any other indexer; the download
client is still added in each app. Prowlarr itself needs no download client
for this - only for grabbing from Prowlarr's own search page.

## What the apps see

Every video in a remote folder the catalog has matched becomes a release:

```
Frieren: Beyond Journey's End S02E02 German DL GerEngSub 1080p WEB-DL-WeebSync
Detective Conan - 1187 GerSub 1080p WEB-DL-WeebSync
Spirited Away (2001) German DL 1080p BluRay-WeebSync
```

- The title is the show's English name, the episode SxxEyy from the folder's
  season and the file's number. Long runners numbered absolutely (1187 in a
  season 1 folder) keep the absolute number; Sonarr maps it for anime series.
- Languages come from the dub tag (`GerJapDub` → *German DL*, i.e. German plus
  the original) or scene words (`GERMAN.DL`); the sub tag stays as written.
- Resolution from the name, else the folder's measured one; the source from
  the name (`BluRay`, `DVD`, `HDTV`), else *WEB-DL*.
- Search works by TVDB id (series) and TMDB id (movies); the RSS feed lists the
  newest files, and for movies every matched film, also one the id lists do
  not know yet (Radarr reads it by title and year). The feed pages by
  `offset`, so Prowlarr's *Load more* goes past the first 100. A text search
  matches any title the catalog knows for a show (English, Romaji, German ...)
  or its folder name; a trailing `S02E01`, `S02` or episode number (Sonarr's
  anime search sends `Title 05`) narrows it to that episode.
- Radarr's indexer test asks for the newest films. On a server whose season
  folders hold almost none, mark the folder the films live in, or the test
  finds nothing.

## Limits

- Only folders the catalog has matched to a show or movie appear; unmatched
  folders stay invisible. The catalog matches the titles inside a folder
  marked in its catalog view (Anime, TV, Movies ...). A server that adds a
  folder per broadcast season needs each new one marked: tick *Mark new
  folders like this one automatically* on a marked season folder, and new
  folders beside it whose name differs only in numbers and the season
  (`2026-4 Fall` after `2026-3 Summer`) are marked on their own. The dashboard
  points out unmarked folders that look like marked ones; the rules are listed
  under Settings → Servers.
- Files directly inside a matched folder are listed, not files in subfolders
  below it (those are matched as season folders of their own).
- Fractional specials (`1165.5`) are left out; the apps cannot place them.
- The release size is the real file size, so Sonarr/Radarr's minimum and
  maximum sizes per quality apply as usual.
