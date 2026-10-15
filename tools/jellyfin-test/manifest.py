"""Snapshot a Plex library's layout for the Jellyfin test instance.

Reads, never writes: every show and movie with its catalog ids, every file
path and season/episode number, and the audio/subtitle tracks of one file per
item. Usage (the token only via env, never in a file):

    PLEX_URL=http://plex.lan:32400 PLEX_TOKEN=... python3 -I manifest.py "$DATA/manifest.json"

The output names real paths and titles: it lives in the data directory, outside
the repository, and is never committed.
"""
import json
import os
import sys
import urllib.request

URL, TOKEN = os.environ['PLEX_URL'].rstrip('/'), os.environ['PLEX_TOKEN']


def get(path):
    sep = '&' if '?' in path else '?'
    req = urllib.request.Request(URL + path + sep + 'X-Plex-Token=' + TOKEN, headers={'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120))['MediaContainer']


def streams(md):
    out = []
    for s in md['Media'][0]['Part'][0].get('Stream', []):
        if s['streamType'] in (2, 3):
            out.append(dict(t=s['streamType'], lang=s.get('languageCode'), title=s.get('title'),
                            forced=bool(s.get('forced')), default=bool(s.get('default'))))
    return out


sections, items = [], []
for d in get('/library/sections').get('Directory', []):
    if d['type'] not in ('show', 'movie'):
        continue
    sections.append(dict(title=d['title'], type=d['type'], locations=[l['path'] for l in d['Location']]))
    for x in get(f"/library/sections/{d['key']}/all?includeGuids=1").get('Metadata', []):
        e = dict(section=d['title'], title=x['title'], year=x.get('year'), type=x['type'],
                 guids=[g['id'] for g in x.get('Guid', [])])
        if x['type'] == 'show':
            leaves = get(f"/library/metadata/{x['ratingKey']}/allLeaves").get('Metadata', [])
            e['files'] = [(l['Media'][0]['Part'][0]['file'], l.get('parentIndex'), l.get('index')) for l in leaves]
            if leaves:
                e['streams'] = streams(get(f"/library/metadata/{leaves[0]['ratingKey']}")['Metadata'][0])
        else:
            md = get(f"/library/metadata/{x['ratingKey']}")['Metadata'][0]
            e['files'] = [(md['Media'][0]['Part'][0]['file'], None, None)]
            e['streams'] = streams(md)
        items.append(e)
    print(d['title'], len(items), file=sys.stderr)
json.dump(dict(sections=sections, items=items), open(sys.argv[1], 'w'), ensure_ascii=False)
