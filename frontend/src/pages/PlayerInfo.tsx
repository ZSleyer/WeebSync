import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Cover } from '@weebsync/design-system'
import { api, fmtBytes, mediaTitle, type Entry, type Watch, type WatchEpisode, type WatchEpisodes } from '../api'
import { matchFiles } from '../components/EpisodeList'
import { catalogTitle, watchOf } from '../components/playLinks'
import { useSeriesModal } from '../components/SeriesModal'

export interface PlayTrack {
  index: number
  codec: string
  lang?: string
  title?: string
  default?: boolean
  forced?: boolean
  channels?: number
  image?: boolean
  file?: string
}

export interface PlayInfo {
  duration: number
  video?: { codec: string; profile?: string; pixFmt?: string; width: number; height: number }
  audio: PlayTrack[]
  subs: PlayTrack[]
  // names: what libass may ask for the font by; none for one it cannot name
  fonts: { index: number; names?: string[] }[]
}

// ffmpeg's codec names, as people know the formats
export const CODEC_NAMES: Record<string, string> = {
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  subrip: 'SRT',
  mov_text: 'Text',
  webvtt: 'VTT',
  eac3: 'E-AC3',
  truehd: 'TrueHD',
}

export function trackLabel(tr: PlayTrack, i: number): string {
  const codec = CODEC_NAMES[tr.codec] ?? tr.codec.toUpperCase()
  const bits = [tr.lang, tr.title && tr.title !== tr.lang ? tr.title : '', codec]
  return bits.filter(Boolean).join(' · ') || `#${i + 1}`
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${pad(m)}` : m}:${pad(Math.floor(s % 60))}`
}
const code = (ep: WatchEpisode) => `S${pad(ep.season)}E${pad(ep.local ?? ep.episode)}`
const CHANNELS: Record<number, string> = { 1: 'Mono', 2: '2.0', 6: '5.1', 8: '7.1' }

export type PlayMode = 'direct' | 'copy' | 'transcode'

/**
 * What the player knows about the file, under the picture: the title it
 * belongs to (a watch's, else the catalog's match of its folder), this
 * episode, the file's tracks and how it plays, and the folder's episodes to
 * go on with. A phone has the room below a 16:9 picture; a desktop scrolls to it.
 */
export default function PlayerInfo({
  server,
  path,
  info,
  files,
  at,
  onPick,
  audioIdx,
  sub,
  mode,
  burned,
  serverName,
}: {
  server: number
  path: string
  info: PlayInfo
  files: Entry[]
  at: number
  onPick: (e: Entry) => void
  audioIdx: number
  sub?: PlayTrack
  mode: PlayMode
  burned: boolean
  serverName: string
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const series = useSeriesModal()
  const dir = path.slice(0, path.lastIndexOf('/'))

  const watches = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    staleTime: 10_000,
  })
  const watch = watches.data && watchOf(watches.data, server, path)
  const matched = useQuery({
    queryKey: ['play-title', server, dir],
    queryFn: () => catalogTitle(qc, server, path),
    enabled: watches.isSuccess && !watch?.media,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const media = watch?.media ?? matched.data?.media
  const source = watch?.media ? watch.mediaSource || 'anilist' : matched.data?.source
  const eps = useQuery({
    queryKey: ['watch-episodes', watch?.id],
    queryFn: () => api.get<WatchEpisodes>(`/api/watches/${watch?.id}/episodes`),
    enabled: !!watch,
    staleTime: 5 * 60_000,
    retry: false,
  })
  // the provider's episode behind each file, for real titles in the list
  const epOf = new Map<string, WatchEpisode>()
  for (const [ep, f] of matchFiles(eps.data?.episodes ?? [], files).hits) epOf.set(f.path, ep)
  const file = at >= 0 ? files[at] : undefined
  const cur = file && epOf.get(file.path)
  // the list in episode order where the provider knows the files (a bare
  // `- 16.mkv` sorts before `S02E01` by name); the rest after, by name
  const rank = (f: Entry, i: number): [number, number, number] => {
    const ep = epOf.get(f.path)
    return ep ? [0, ep.season, ep.local ?? ep.episode] : [1, i, 0]
  }
  const shown = files
    .map((f, i) => ({ f, i, r: rank(f, i) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2])
  const name = path.split('/').pop() ?? path

  // the list starts at the episode playing, without moving the page
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = list.current
    const li = el?.querySelector<HTMLElement>('[aria-current="true"]')
    if (el && li) el.scrollTop = li.offsetTop - el.clientHeight / 2 + li.offsetHeight / 2
  }, [at, files.length])

  const v = info.video
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language)
  const facts: [string, string][] = [
    [t('player.duration'), clock(info.duration)],
    ...(v
      ? [
          [
            t('player.picture'),
            [
              `${CODEC_NAMES[v.codec] ?? v.codec.toUpperCase()}${v.pixFmt?.includes('10') ? ' 10-bit' : ''}`,
              v.width > 0 && `${v.width}×${v.height}`,
            ]
              .filter(Boolean)
              .join(' · '),
          ] as [string, string],
        ]
      : []),
    ...info.audio.map(
      (a, i) =>
        [
          i ? '' : t('player.audio'),
          `${trackLabel(a, i)}${a.channels ? ` · ${CHANNELS[a.channels] ?? `${a.channels} ch`}` : ''}${a.index === audioIdx && info.audio.length > 1 ? ' ✓' : ''}`,
        ] as [string, string],
    ),
    [t('player.subtitles'), sub ? trackLabel(sub, 0) : t('player.subOff')],
    [t('player.mode'), [t(`player.mode_${mode}`), burned && t('player.burned')].filter(Boolean).join(' · ')],
    [t('player.source'), serverName],
    ...(file ? [[t('player.file'), `${fmtBytes(file.size)} · ${date(file.modTime)}`] as [string, string]] : []),
  ]

  const description =
    media?.description &&
    new DOMParser()
      .parseFromString(media.description.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
      .body.textContent?.replace(/\s+/g, ' ')
      .trim()

  return (
    <section className="t-player-info" aria-label={t('player.about')}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex gap-4">
          {media && <Cover src={media.coverImage?.large} tint={media.coverImage?.color ?? undefined} size="lg" />}
          <div className="min-w-0 flex-1">
            {media && <p className="text-sm font-semibold text-pretty text-t-secondary">{mediaTitle(media)}</p>}
            <h2 className="font-display text-base font-semibold break-words text-balance text-t-primary">
              {cur ? `${code(cur)}${cur.title ? ` · ${cur.title}` : ''}` : name.replace(/\.[^.]+$/, '')}
            </h2>
            <p className="text-ctl-sm text-t-muted">
              {[
                !cur && files.length > 1 && at >= 0 && t('player.episodeOf', { n: at + 1, total: files.length }),
                cur?.aired && date(cur.aired),
                media?.format,
                media?.seasonYear,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {media && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() =>
                  series.open({
                    source,
                    id: media.id,
                    media,
                    watchId: watch?.id,
                    folders: [{ server, path: matched.data?.dir ?? dir }],
                    playPath: path,
                    tab: 'episodes',
                  })
                }
              >
                {t('player.openTitle')}
              </Button>
            )}
          </div>
        </div>
        {description && <p className="line-clamp-4 text-sm text-pretty text-t-secondary">{description}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {facts.map(([k, val], i) => (
            <div key={i} className="contents">
              <dt className="text-t-muted">{k}</dt>
              <dd className="break-words text-t-secondary">{val}</dd>
            </div>
          ))}
        </dl>
      </div>
      {files.length > 1 && (
        <nav aria-label={t('player.episodes')} className="min-w-0">
          <h2 className="mb-2 text-ctl-sm font-semibold tracking-[0.18em] text-t-muted uppercase">
            {t('player.episodes')}
          </h2>
          <ol ref={list} className="t-player-info__list">
            {shown.map(({ f, i }) => {
              const ep = epOf.get(f.path)
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    className="t-player-info__ep"
                    aria-current={i === at || undefined}
                    onClick={() => onPick(f)}
                  >
                    <span className="tabular-nums text-t-muted">{ep ? code(ep) : pad(i + 1)}</span>
                    <span className="line-clamp-2 min-w-0 break-words">
                      {ep?.title ?? f.name.replace(/\.[^.]+$/, '')}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
      )}
    </section>
  )
}
