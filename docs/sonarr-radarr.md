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

1. *Turn on (create key)*. The key is shown only once; it is the API key for
   the indexer and the download client in every app.
2. **Download folder**: where grabs land, one folder per release. It must be
   inside a download root (`WEEBSYNC_DOWNLOADS`) and visible to Sonarr/Radarr.
3. **Path mapping**, only when the apps see that folder under another path:
   one line `appPath => localPath`, e.g. `/downloads => /mnt/media/downloads`.

## In Sonarr and Radarr

**Indexer** → add → *Newznab* (custom):

| Field | Value |
| --- | --- |
| URL | `http://weebsync.example.com:8080/api/arr/newznab` |
| API Path | `/api` |
| API Key | the key from above |
| Categories | Sonarr `5000, 5040`, anime `5070`; Radarr `2000` |

**Download client** → add → *SABnzbd*:

| Field | Value |
| --- | --- |
| Host / Port | WeebSync's host and port |
| URL Base | `/api/arr/sab` |
| API Key | the key from above |
| Category | `tv` (Sonarr), `movies` (Radarr) |

Use the address the apps reach WeebSync under - in a Docker setup usually the
container name, not the public URL.

## In Prowlarr

Indexers → add → *Generic Newznab* with the same URL, API path and key.
Prowlarr hands it to Sonarr and Radarr like any other indexer; the download
client is still added in each app.

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
  newest files. Free-text search returns nothing, on purpose.

## Limits

- Only folders the catalog has matched to a show or movie appear; unmatched
  folders stay invisible.
- Files directly inside a matched folder are listed, not files in subfolders
  below it (those are matched as season folders of their own).
- Fractional specials (`1165.5`) are left out; the apps cannot place them.
- The release size is the real file size, so Sonarr/Radarr's minimum and
  maximum sizes per quality apply as usual.
