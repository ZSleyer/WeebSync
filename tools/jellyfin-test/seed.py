"""Mirror a manifest.json into a media tree Jellyfin can scan.

Every file of the snapshot becomes a two-second mkv with the same audio and
subtitle tracks (language, title, default/forced flags) as the original, so the
quality read and the track logic see what the real library holds. One file is
encoded per distinct track set and the rest are hard links, so ~11k episodes
cost a few MB. Each show folder gets a tvshow.nfo and each movie a .nfo with
the snapshot's tvdb/tmdb/imdb ids: Jellyfin matches deterministically, with or
without internet.

    python3 -I seed.py "$DATA/manifest.json" "$DATA/media"

Paths keep their layout below the first component (/media/... -> MEDIA/...),
so the container mounts MEDIA at /media and reports the same paths Plex does.
"""
import hashlib
import html
import json
import os
import subprocess
import sys

man = json.load(open(sys.argv[1]))
ROOT = sys.argv[2]
TPL = os.path.join(ROOT, '.tpl')
os.makedirs(TPL, exist_ok=True)
L3 = {'deu': 'ger', None: 'und'}  # ffmpeg writes ISO 639-2/B


def lang(s):
    return L3.get(s.get('lang'), s.get('lang') or 'und')


def template(streams):
    key = hashlib.md5(json.dumps(streams, sort_keys=True).encode()).hexdigest()[:10]
    out = f'{TPL}/{key}.mkv'
    if os.path.exists(out):
        return out
    audio = [s for s in streams if s['t'] == 2] or [dict(lang='jpn', title=None, default=True)]
    subs = [s for s in streams if s['t'] == 3]
    srt = f'{TPL}/s.srt'
    with open(srt, 'w') as f:
        f.write('1\n00:00:00,000 --> 00:00:01,000\nx\n')
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=2:r=5']
    cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono'] * len(audio)
    for _ in subs:
        cmd += ['-i', srt]
    cmd += ['-map', '0:v']
    cmd += [x for i in range(len(audio)) for x in ('-map', f'{1 + i}:a')]
    cmd += [x for i in range(len(subs)) for x in ('-map', f'{1 + len(audio) + i}:s')]
    cmd += ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '8k', '-c:s', 'srt', '-t', '2']
    for i, s in enumerate(audio):
        cmd += [f'-metadata:s:a:{i}', f'language={lang(s)}', f'-disposition:a:{i}', 'default' if s.get('default') else '0']
        if s.get('title'):
            cmd += [f'-metadata:s:a:{i}', f"title={s['title']}"]
    for i, s in enumerate(subs):
        flags = '+'.join(f for f in ('default' if s.get('default') else '', 'forced' if s.get('forced') else '') if f) or '0'
        cmd += [f'-metadata:s:s:{i}', f'language={lang(s)}', f'-disposition:s:{i}', flags]
        if s.get('title'):
            cmd += [f'-metadata:s:s:{i}', f"title={s['title']}"]
    subprocess.run(cmd + [out], check=True)
    return out


def nfo(path, kind, item):
    ids = dict(g.split('://', 1) for g in item['guids'])
    body = f"<title>{html.escape(item['title'])}</title><year>{item.get('year') or ''}</year>"
    for k, tag in (('tvdb', 'tvdbid'), ('tmdb', 'tmdbid'), ('imdb', 'imdbid')):
        if k in ids:
            default = ' default="true"' if k == 'tvdb' else ''
            body += f'<{tag}>{ids[k]}</{tag}><uniqueid type="{k}"{default}>{ids[k]}</uniqueid>'
    with open(path, 'w') as f:
        f.write(f'<?xml version="1.0" encoding="UTF-8"?><{kind}>{body}</{kind}>')


def local(p):
    return os.path.join(ROOT, p.lstrip('/').split('/', 1)[1])


roots = [loc for s in man['sections'] for loc in s['locations']]
for item in man['items']:
    tpl = template(item.get('streams', []))
    shows = set()
    for f, _, _ in item['files']:
        dst = local(f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            os.link(tpl, dst)
        if item['type'] == 'movie':
            nfo(os.path.splitext(dst)[0] + '.nfo', 'movie', item)
            continue
        # the show folder is the first component below its library root
        root = max((r for r in roots if f.startswith(r + '/')), key=len, default=None)
        if root:
            shows.add(local(root + '/' + f[len(root) + 1:].split('/', 1)[0]))
    for d in shows:
        nfo(d + '/tvshow.nfo', 'tvshow', item)
print('seeded', len(man['items']), 'items into', ROOT)
