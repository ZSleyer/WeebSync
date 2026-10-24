import { useEffect, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Button, Cover, SectionHeading } from 'fluid-lycoris'
import {
  api,
  fmtBytes,
  mediaDescription,
  mediaTitle,
  type Entry,
  type Media,
  type Watch,
  type WatchEpisode,
  type WatchEpisodes,
} from '../api'
import { matchFiles } from '../components/EpisodeList'
import { catalogTitle, watchOf } from '../components/playLinks'
import { useSeriesModal } from '../components/SeriesModal'
import { wasSeen } from './playPosition'

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

export interface PlayChapter {
  start: number
  end: number
  title?: string
  // the opening or the ending, which the player offers to skip
  kind?: 'op' | 'ed'
}

export interface PlayInfo {
  duration: number
  video?: { codec: string; profile?: string; pixFmt?: string; width: number; height: number }
  audio: PlayTrack[]
  subs: PlayTrack[]
  // names: what libass may ask for the font by; none for one it cannot name
  fonts: { index: number; names?: string[] }[]
  // the chapter marks in order, none when the file has fewer than two
  chapters: PlayChapter[]
  // the AniList entry behind the file, when it is on the user's list
  anilist?: { mediaId: number; episode: number; progress: number }
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
/**
 * A file's name as a title: without the extension and the tags in brackets
 * and parentheses (group, resolution, codecs, languages, hash), so
 * `Clevatess II E02 [1080p][AAC][GerJapDub].mkv` reads `Clevatess II E02`.
 * A name that is nothing but tags stays as it was.
 */
export function bareTitle(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const bare = base
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '')
  return bare || base
}
/** an episode's code as the files name it: S01E05 */
export const episodeCode = (ep: WatchEpisode) => `S${pad(ep.season)}E${pad(ep.local ?? ep.episode)}`
const CHANNELS: Record<number, string> = { 1: 'Mono', 2: '2.0', 6: '5.1', 8: '7.1' }

export type PlayMode = 'direct' | 'copy' | 'transcode'

/**
 * The title a file belongs to - a watch's, else the catalog's match of its
 * folder - and the provider's episode behind each of the folder's files. The
 * player's title row and the panel under it read the same answer (the
 * queries are shared, so asking twice costs nothing).
 */
export function usePlayTitle(server: number, path: string, files: Entry[], at: number) {
  const qc = useQueryClient()
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
  const media: Media | undefined = watch?.media ?? matched.data?.media
  const source = watch?.media ? watch.mediaSource || 'anilist' : matched.data?.source
  const eps = useQuery({
    queryKey: ['watch-episodes', watch?.id],
    queryFn: () => api.get<WatchEpisodes>(`/api/watches/${watch?.id}/episodes`),
    enabled: !!watch,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const episodes = eps.data?.episodes ?? []
  const hits = matchFiles(episodes, files).hits
  const epOf = new Map<string, WatchEpisode>()
  for (const [ep, f] of hits) epOf.set(f.path, ep)
  const file = at >= 0 ? files[at] : undefined
  const cur = file && epOf.get(file.path)
  return { media, source, watch, folder: matched.data?.dir ?? dir, episodes, hits, epOf, cur }
}

export type PlayTitle = ReturnType<typeof usePlayTitle>

/** One line of the episode list: a file, a provider episode, or both. */
interface EpRow {
  key: string
  ep?: WatchEpisode
  file?: Entry
  /** the file's place in the folder's list */
  index: number
}

/**
 * The episode list under the player: the provider's episodes in order where
 * a watch knows them, those without a file greyed out, then every file no
 * episode claimed. Only the seasons the folder has files of: an endless
 * series lists a thousand episodes otherwise.
 */
export function episodeRows(files: Entry[], episodes: WatchEpisode[], hits: Map<WatchEpisode, Entry>): EpRow[] {
  const indexOf = new Map(files.map((f, i) => [f.path, i]))
  const seasons = new Set([...hits.keys()].map((e) => e.season))
  const listed = episodes
    .filter((e) => seasons.has(e.season))
    .sort((a, b) => a.season - b.season || (a.local ?? a.episode) - (b.local ?? b.episode))
    .map((ep) => {
      const file = hits.get(ep)
      return {
        key: file?.path ?? `ep:${ep.season}:${ep.episode}`,
        ep,
        file,
        index: file ? indexOf.get(file.path)! : -1,
      }
    })
  const claimed = new Set(listed.flatMap((r) => (r.file ? [r.file.path] : [])))
  const rest = files.flatMap((f, i) => (claimed.has(f.path) ? [] : [{ key: f.path, file: f, index: i }]))
  return [...listed, ...rest]
}

/**
 * What the player knows about the file, under the picture: the title it
 * belongs to, this episode, the file's tracks and how it plays, and the
 * folder's episodes to go on with. A phone scrolls it under the picture; a
 * desktop has it in two columns.
 */
export default function PlayerInfo({
  server,
  path,
  info,
  files,
  at,
  title,
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
  title: PlayTitle
  onPick: (e: Entry) => void
  audioIdx: number
  sub?: PlayTrack
  mode: PlayMode
  burned: boolean
  serverName: string
}) {
  const { t, i18n } = useTranslation()
  const series = useSeriesModal()
  const { media, source, watch, folder, episodes, hits, cur } = title
  const rows = episodeRows(files, episodes, hits)
  const file = at >= 0 ? files[at] : undefined
  const name = path.split('/').pop() ?? path

  // the list starts at the episode playing, without moving the page
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = list.current
    const li = el?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!el || !li) return
    // by where the row is drawn: offsetTop counts from the nearest positioned
    // ancestor, which is not this list
    const row = li.getBoundingClientRect()
    const top = row.top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = top - el.clientHeight / 2 + row.height / 2
  }, [at, files.length])

  // AniList counts its own numbers: the playing file tells how they line up
  // with the provider's episodes of its season
  const tracked = info.anilist
  const offset = tracked && cur ? tracked.episode - (cur.local ?? cur.episode) : null
  const seen = (r: EpRow) =>
    (r.file && wasSeen(server, r.file.path)) ||
    (offset !== null &&
      !!r.ep &&
      r.ep.season === cur?.season &&
      (r.ep.local ?? r.ep.episode) + offset <= tracked!.progress)

  const v = info.video
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'numeric', year: '2-digit' })
  const facts: [string, ReactNode][] = [
    [t('player.duration'), clock(info.duration)],
    ...(v
      ? [
          [
            t('player.picture'),
            [
              CODEC_NAMES[v.codec] ?? v.codec.toUpperCase(),
              v.width > 0 && `${v.width}×${v.height}`,
              v.pixFmt && (v.pixFmt.includes('10') ? '10 bit' : v.pixFmt.includes('12') ? '12 bit' : '8 bit'),
            ]
              .filter(Boolean)
              .join(' · '),
          ] as [string, ReactNode],
        ]
      : []),
    ...info.audio.map(
      (a, i) =>
        [
          i ? '' : t('player.audio'),
          <>
            {trackLabel(a, i)}
            {a.channels ? ` · ${CHANNELS[a.channels] ?? `${a.channels} ch`}` : ''}
            {a.index === audioIdx && info.audio.length > 1 && (
              <span className="t-pi-ok">{t('player.activeTrack')}</span>
            )}
          </>,
        ] as [string, ReactNode],
    ),
    [t('player.subtitles'), sub ? trackLabel(sub, 0) : t('player.subOff')],
    [
      t('player.mode'),
      [
        t(`player.modeText_${mode}`),
        burned && `${t('player.burned').charAt(0).toUpperCase()}${t('player.burned').slice(1)}.`,
      ]
        .filter(Boolean)
        .join(' '),
    ],
    [
      t('player.source'),
      <span key="path" className="t-pi-mono">
        {path}
      </span>,
    ],
    ...(file ? [[t('player.size'), `${fmtBytes(file.size)} · ${date(file.modTime)}`] as [string, ReactNode]] : []),
  ]
  const n = cur ? (cur.local ?? cur.episode) : at + 1
  const total = media?.episodes || (files.length > 1 ? files.length : 0)
  const line = [
    at >= 0 && total > 0 && t('player.episodeOf', { n, total }),
    cur?.aired && date(cur.aired),
    media?.seasonYear,
    media?.format,
    serverName,
  ]
    .filter(Boolean)
    .join(' · ')

  const overview = mediaDescription(media, i18n.language)
  const description =
    overview &&
    new DOMParser()
      .parseFromString(overview.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
      .body.textContent?.replace(/\s+/g, ' ')
      .trim()

  return (
    <section className="t-player-info" aria-label={t('player.about')}>
      <div className={`t-pi-head${media ? '' : ' t-pi-head--bare'}`}>
        {media && (
          <Cover
            src={media.coverImage?.extraLarge || media.coverImage?.large}
            tint={media.coverImage?.color ?? undefined}
            size="fill"
          />
        )}
        <div className="min-w-0">
          {media && <p className="t-pi-quiet">{mediaTitle(media)}</p>}
          <h2 className="t-pi-title">
            {cur?.title ?? (cur ? episodeCode(cur) : bareTitle(name))}
            {cur?.title && <span> {episodeCode(cur)}</span>}
          </h2>
          {line && <p className="t-pi-quiet">{line}</p>}
          {media && (
            <Button
              className="t-pi-open"
              onClick={() =>
                series.open({
                  source,
                  id: media.id,
                  media,
                  watchId: watch?.id,
                  folders: [{ server, path: folder }],
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
      {description && <p className="t-pi-desc">{description}</p>}
      <div className="t-pi-cols">
        <section>
          <SectionHeading level={3} tone="accent-2" title={t('player.thisFile')} />
          <dl className="t-pi-dl">
            {facts.map(([k, val], i) => (
              <div key={i} className="contents">
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
        </section>
        {rows.length > 1 && (
          <nav aria-label={t('player.episodes')} className="min-w-0">
            <SectionHeading level={3} tone="accent-2" title={t('player.episodes')} />
            <ol ref={list} className="t-pi-eps">
              {rows.map((r) => {
                const here = r.index === at && r.index >= 0
                const f = r.file
                return (
                  <li key={r.key}>
                    <button type="button" disabled={!f} aria-current={here || undefined} onClick={() => f && onPick(f)}>
                      <span aria-hidden className="t-pi-mark">
                        {here && <Play size={14} fill="currentColor" strokeWidth={0} />}
                      </span>
                      <span className="t-pi-label">
                        {r.ep ? (
                          <>
                            <span className="t-pi-code">{episodeCode(r.ep)}</span>
                            {r.ep.title ?? (f ? bareTitle(f.name) : '')}
                          </>
                        ) : (
                          bareTitle(f!.name)
                        )}
                      </span>
                      <span className="t-pi-st">
                        {!f ? t('player.epMissing') : !here && seen(r) ? t('player.epSeen') : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>
        )}
      </div>
    </section>
  )
}
