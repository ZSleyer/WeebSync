import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, Clock, Play } from 'lucide-react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconButton, SectionHeading, TextLink } from 'fluid-lycoris'
import { api, fmtBytes, type Download, type Entry, type Watch, type WatchEpisode, type WatchEpisodes } from '../api'
import type { Schemas } from '../api.gen'
import Loading from './Loading'
import { dayWord } from './MediaDetail'
import { isVideo, listFolder, titleFilesIn } from './playLinks'

/** A folder a title's episodes lie in: the local library (server 0) or a server. */
export interface EpisodeFolder {
  server: number
  path: string
}

/** The episode a caller lands on: scrolled to, opened, marked once. */
export interface EpisodeLanding {
  ep: number
  season?: number
}

interface Group {
  label: string
  files: Entry[]
}

/** A video and the server its folder is on. */
type File = Entry & { server: number }
type PlayInfo = Schemas['api.PlayInfo']

const PROVIDER_LABEL: Record<string, string> = { tvdb: 'TVDB', tmdb: 'TMDB' }

// the season and episode a file name carries
const SXE = /S(\d{1,2})\s*E(\d{1,4})/i
// a standalone number: not glued to letters (1080p, x264), digits or a decimal
// point (5.1); a release's version tail (05v2) still counts
const NUM = /(?<![\p{L}\d.])(\d{1,4})(?:v\d)?(?![\p{L}\d]|\.\d)/gu
const pad = (n: number | string) => String(n).padStart(2, '0')
const fileKey = (f: File) => `${f.server}:${f.path}`
const bare = (name: string) => name.replace(/\.[^.]+$/, '')
const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// rows past this many render only near the screen
const LONG_LIST = 40

/**
 * The last standalone number of a file name, tags in brackets and parentheses
 * (hashes, resolutions, years) dropped first: `One Piece - 1095 [1080p].mkv` is 1095.
 *
 * ponytail: separators are spaces, dashes, underscores; `Show.05.mkv` and a
 * bare `E05` stay unmatched. Widen when such a library turns up.
 */
function bareNumber(name: string): number | undefined {
  const core = name.replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  const all = [...core.matchAll(NUM)]
  return all.length ? Number(all[all.length - 1][1]) : undefined
}

function episodeOf(eps: WatchEpisode[], name: string): WatchEpisode | undefined {
  const m = SXE.exec(name)
  if (m) {
    const s = Number(m[1])
    const e = Number(m[2])
    // local is the number on disk when an {episode-N} template renumbers
    return eps.find((ep) => ep.season === s && (ep.local ?? ep.episode) === e)
  }
  const n = bareNumber(name)
  if (n === undefined) return undefined
  const abs = eps.find((ep) => ep.absolute === n)
  if (abs) return abs
  // ponytail: without a season in the name, an episode number that several
  // seasons share is a guess; such a file stays with the other files
  const byEp = eps.filter((ep) => (ep.local ?? ep.episode) === n)
  return byEp.length === 1 ? byEp[0] : undefined
}

/**
 * The episodes of a watch on their way in, keyed "season-episode", each with
 * how much of it has arrived: its running or queued downloads from the
 * watch's folder whose target names the episode as SxxEyy.
 */
export function incoming(
  downloads: Pick<Download, 'status' | 'serverId' | 'remotePath' | 'localPath' | 'size' | 'transferred'>[],
  w: Pick<Watch, 'serverId' | 'remotePath'>,
) {
  const m = new Map<string, number>()
  for (const d of downloads) {
    if (d.status !== 'running' && d.status !== 'queued') continue
    if (d.serverId !== w.serverId || !d.remotePath.startsWith(w.remotePath)) continue
    const se = /S(\d+)E(\d+)/i.exec(d.localPath.slice(d.localPath.lastIndexOf('/') + 1))
    if (se) m.set(`${Number(se[1])}-${Number(se[2])}`, d.size > 0 ? d.transferred / d.size : 0)
  }
  return m
}

/**
 * Pairs files with the provider's episodes: by SxxEyy in the name, else by its
 * last standalone number against the absolute and then the episode number.
 * The first file per episode wins; a second copy stays in `rest`, still playable.
 */
export function matchFiles<F extends { name: string }>(
  episodes: WatchEpisode[],
  files: F[],
): { hits: Map<WatchEpisode, F>; rest: F[] } {
  const hits = new Map<WatchEpisode, F>()
  const rest: F[] = []
  for (const f of files) {
    const ep = episodeOf(episodes, f.name)
    if (ep && !hits.has(ep)) hits.set(ep, f)
    else rest.push(f)
  }
  return { hits, rest }
}

/**
 * The episode a landing points at: the season's when given, else the first
 * episode or absolute number that matches.
 */
export function landingEpisode(eps: WatchEpisode[], land: EpisodeLanding): WatchEpisode | undefined {
  if (land.season !== undefined) return eps.find((e) => e.season === land.season && e.episode === land.ep)
  return eps.find((e) => e.episode === land.ep) ?? eps.find((e) => e.absolute === land.ep)
}

/** A folder's videos (or volumes) and those of its season folders, one level down. */
async function episodeGroups(f: EpisodeFolder): Promise<Group[]> {
  const entries = await listFolder(f.server, f.path)
  const groups: Group[] = []
  const here = titleFilesIn(entries)
  if (here.length) groups.push({ label: '', files: here })
  const seasons = entries
    .filter((e) => e.isDir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const s of seasons) {
    const files = titleFilesIn(await listFolder(f.server, s.path))
    if (files.length) groups.push({ label: s.name, files })
  }
  return groups
}

/** A language tag as a word in the reader's language ("jpn" is "Japanisch"). */
export function langName(tag: string | undefined, locale: string): string {
  if (!tag || tag === 'und') return '?'
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/**
 * The series page's "Folgen": per watch its episodes in hairline rows, each
 * with its state and, where a file matched, a play button; a row with a file
 * opens to its facts. Then every file no episode claimed. Without a watch it
 * is the plain file list. A landing (Neu da, ?ep=N) or the file the page was
 * opened for is scrolled to, opened and marked once.
 */
export default function EpisodeList({
  folders,
  watches,
  highlight,
  land,
  onPlay,
  now,
  headingId,
}: {
  folders: EpisodeFolder[]
  watches: Watch[]
  highlight?: string
  land?: EpisodeLanding
  onPlay: (server: number, path: string) => void
  now: number
  /** the id of the section's first heading, for the section's label */
  headingId?: string
}) {
  const { t } = useTranslation()
  const listed = useQueries({
    queries: folders.map((f) => ({
      queryKey: ['episode-files', f.server, f.path],
      queryFn: () => episodeGroups(f),
      staleTime: 60_000,
    })),
  })
  const known = useQueries({
    queries: watches.map((w) => ({
      queryKey: ['watch-episodes', w.id],
      queryFn: () => api.get<WatchEpisodes>(`/api/watches/${w.id}/episodes`),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  // episodes on their way in: a download of this watch whose target names
  // its SxxEyy. The shared downloads query, patched live by the event stream
  const { data: downloads = [] } = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<Download[]>('/api/downloads'),
  })
  const filesIn = listed.every((q) => !q.isLoading)
  const epsIn = known.every((q) => !q.isLoading)

  // Each watch claims its files in turn, the one the page came from first;
  // local copies go ahead of a server's so the play button stays at home.
  let pool: File[] = listed
    .flatMap((q, i) => (q.data ?? []).flatMap((g) => g.files.map((e) => ({ ...e, server: folders[i].server }))))
    .sort((a, b) => Number(a.server !== 0) - Number(b.server !== 0))
  const hits: Map<WatchEpisode, File>[] = []
  for (const q of known) {
    const m = matchFiles(q.data?.episodes ?? [], pool)
    hits.push(m.hits)
    pool = m.rest
  }
  const left = new Set(pool.map(fileKey))

  // rows open to their facts; the landing opens one by itself
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [hit, setHit] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !filesIn || !epsIn) return
    let key: string | null = null
    if (land) {
      for (let i = 0; i < watches.length && !key; i++) {
        const e = landingEpisode(known[i].data?.episodes ?? [], land)
        if (e) key = `${watches[i].id}:${e.season}-${e.episode}`
      }
    }
    if (!key && highlight) {
      for (let i = 0; i < watches.length && !key; i++)
        for (const [e, f] of hits[i]) if (f.path === highlight) key = `${watches[i].id}:${e.season}-${e.episode}`
      key ??= [...rows.current.keys()].find((k) => k.endsWith(`|${highlight}`)) ?? null
    }
    landed.current = true
    if (!key) return
    const k = key
    setOpen((s) => new Set(s).add(k))
    setHit(k)
    const el = rows.current.get(k)
    const still = matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el?.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    const id = setTimeout(() => el?.querySelector<HTMLElement>('.ws-ep-tog')?.focus({ preventScroll: true }), 500)
    return () => clearTimeout(id)
    // the landing runs once, when both lists are in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesIn, epsIn])

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const rowRef = (k: string) => (el: HTMLLIElement | null) => {
    if (el) rows.current.set(k, el)
    else rows.current.delete(k)
  }

  // one row: number, title and its quiet line, the state, play; with a file
  // the whole row is the toggle of its facts (play stays a button of its own)
  const row = (
    k: string,
    no: string,
    title: string,
    sub: ReactNode,
    state: ReactNode,
    file?: File,
    w?: Watch,
    aired?: string,
  ) => {
    const isOpen = open.has(k)
    const factsId = `ws-epf-${k.replace(/[^\w-]/g, '_')}`
    return (
      <li key={k} ref={rowRef(k)} className="ws-ep" data-hit={hit === k || undefined}>
        <div className="ws-ep-in">
          {file && (
            <button
              type="button"
              className="ws-ep-tog"
              aria-expanded={isOpen}
              aria-controls={factsId}
              aria-label={t('series.ep.facts', { name: title })}
              onClick={() => toggle(k)}
            />
          )}
          <span className="ws-ep-no">{no}</span>
          <span className="ws-ep-t">
            <strong>{title}</strong>
            {sub}
          </span>
          <span className="ws-ep-st">{state}</span>
          {file ? (
            <IconButton
              size="sm"
              className="ws-ep-play"
              aria-label={
                isVideo(file.name) ? t('series.ep.play', { name: title }) : t('series.ep.read', { name: title })
              }
              title={file.name}
              onClick={() => onPlay(file.server, file.path)}
            >
              {isVideo(file.name) ? (
                <Play aria-hidden size="1rem" fill="currentColor" strokeWidth={0} />
              ) : (
                <BookOpen aria-hidden size="1rem" />
              )}
            </IconButton>
          ) : (
            <span aria-hidden className="ws-ep-play-sp" />
          )}
        </div>
        {file && <EpisodeFacts id={factsId} open={isOpen} file={file} watch={w} aired={aired} />}
      </li>
    )
  }

  // what is left of the folders, grouped as on disk
  const files = listed.map((q, i) => {
    const f = folders[i]
    const groups = (q.data ?? [])
      .map((g) => ({ ...g, files: g.files.filter((e) => left.has(`${f.server}:${e.path}`)) }))
      .filter((g) => g.files.length)
    return groups.map((g) => (
      <div key={`${f.server}:${f.path}:${g.label}`} className="ws-ep-group">
        {(groups.length > 1 || g.label) && <h3 className="ws-d-h3">{g.label || t('series.thisFolder')}</h3>}
        <ul className={`ws-eps ${g.files.length > LONG_LIST ? 'ws-eps-long' : ''}`}>
          {g.files.map((e) => {
            const m = SXE.exec(e.name)
            const file = { ...e, server: f.server }
            return row(
              `f|${fileKey(file)}|${e.path}`,
              m ? `S${pad(m[1])}E${pad(m[2])}` : '',
              bare(e.name),
              <span>{fmtBytes(e.size)}</span>,
              null,
              file,
            )
          })}
        </ul>
      </div>
    ))
  })
  const failed = listed.some((q) => q.isError)
  const anyLeft = files.some((g) => g.length)

  return (
    <>
      {watches.map((w, i) => {
        const q = known[i]
        const eps = q.data?.episodes ?? []
        const coming = incoming(downloads, w)
        const seasons = [...new Set(eps.map((e) => e.season))]
        const have = eps.filter((e) => e.have || hits[i].has(e)).length
        const provider = q.data?.provider ? PROVIDER_LABEL[q.data.provider] : ''
        const airings = (w.airings ?? []).filter((a) => !a.dub)
        return (
          <div key={w.id} className="ws-ep-group">
            <SectionHeading
              id={i === 0 ? headingId : undefined}
              tone="accent-2"
              title={
                seasons.length === 1
                  ? t('watch.gaps.season', { n: seasons[0] })
                  : watches.length > 1
                    ? w.titleOverride || w.remotePath.split('/').pop()
                    : t('series.tab.episodes')
              }
              action={
                <span className="ws-ep-head">
                  {!!eps.length && (
                    <span className="ws-d-count">{t('series.ep.count', { have, total: eps.length })}</span>
                  )}
                  {q.data?.url && (
                    <TextLink tone="accent-2" href={q.data.url} target="_blank" rel="noreferrer">
                      {t('watch.gaps.viewAt', { provider })}
                    </TextLink>
                  )}
                </span>
              }
            />
            {q.isLoading && <Loading />}
            {q.isError && <p className="ws-d-err">{t('watch.gaps.error')}</p>}
            {/* the reason sits above the list: a list without titles
                otherwise reads as a broken feature, not a missing provider */}
            {q.data?.reason && <p className="ws-ex-sub">{t(`watch.gaps.${q.data.reason}`)}</p>}
            {q.data && !eps.length && !q.data.reason && <p className="ws-d-quiet">{t('series.noEpisodesKnown')}</p>}
            {seasons.map((se) => {
              const inSeason = eps.filter((e) => e.season === se)
              return (
                <div key={se} className="ws-ep-group">
                  {seasons.length > 1 && <h3 className="ws-d-h3">{t('watch.gaps.season', { n: se })}</h3>}
                  <ul className={`ws-eps ${inSeason.length > LONG_LIST ? 'ws-eps-long' : ''}`}>
                    {inSeason.map((raw) => {
                      const f = hits[i].get(raw)
                      // the server marks an episode present only by SxxEyy in
                      // a name; a file this list matched by its absolute
                      // number is just as much there
                      const e = f && !raw.have ? { ...raw, have: true } : raw
                      const loading = coming.get(`${e.season}-${e.episode}`)
                      const no = seasons.length > 1 ? `S${pad(e.season)}E${pad(e.episode)}` : `F${e.episode}`
                      const title = e.title || t('series.ep.title', { n: e.episode })
                      const air = airings.find(
                        (a) => a.episode === (e.absolute ?? e.episode) || a.episode === e.episode,
                      )
                      const sub = f ? (
                        <span>{bare(f.name)}</span>
                      ) : e.upcoming ? (
                        air && air.at * 1000 > now ? (
                          <span data-tone="acc">
                            {t('series.ep.airs', { day: dayWord(t, air.at * 1000, now), time: hm(air.at * 1000) })}
                          </span>
                        ) : (
                          <span>{t('series.ep.noDate')}</span>
                        )
                      ) : e.have ? (
                        <span>{e.aired ?? ''}</span>
                      ) : (
                        <span data-tone="warn">{t('series.ep.missing')}</span>
                      )
                      return row(
                        `${w.id}:${e.season}-${e.episode}`,
                        no,
                        title,
                        sub,
                        <StateIcon ep={e} loading={loading} />,
                        f,
                        w,
                        e.aired,
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        )
      })}
      {!filesIn ? (
        <Loading />
      ) : (
        epsIn && (
          <>
            {watches.length > 0 && anyLeft && <h3 className="ws-d-h3">{t('series.otherFiles')}</h3>}
            {files}
            {failed && <p className="ws-d-err">{t('series.episodesError')}</p>}
            {!watches.length && !anyLeft && !failed && <p className="ws-d-quiet">{t('series.noEpisodes')}</p>}
          </>
        )
      )}
    </>
  )
}

// The state as a shape, not only as a colour (WCAG 1.4.1), with the word for
// screen readers: a check (here), a warn ring (missing), a ring that fills
// (on its way in), a clock (not aired yet).
function StateIcon({ ep, loading }: { ep: WatchEpisode; loading?: number }) {
  const { t } = useTranslation()
  if (loading !== undefined) {
    return (
      <>
        <span aria-hidden className="ws-prog" style={{ '--p': loading } as CSSProperties} />
        <span className="sr-only">{t('watch.gaps.loading')}</span>
      </>
    )
  }
  return (
    <>
      {ep.have ? (
        <svg aria-hidden viewBox="0 0 24 24">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      ) : ep.upcoming ? (
        <Clock aria-hidden size="1rem" className="text-t-muted" />
      ) : (
        <span aria-hidden className="ws-dot" />
      )}
      <span className="sr-only">
        {ep.have ? t('watch.gaps.have') : ep.upcoming ? t('watch.gaps.upcoming') : t('watch.gaps.gone')}
      </span>
    </>
  )
}

/**
 * What a file on disk is: name, size, picture, sound, subtitles, where it
 * came from and when it arrived. The streams come from the player's probe,
 * asked only once the row is open.
 */
function EpisodeFacts({
  id,
  open,
  file,
  watch,
  aired,
}: {
  id: string
  open: boolean
  file: File
  watch?: Watch
  aired?: string
}) {
  const { t, i18n } = useTranslation()
  const video = isVideo(file.name)
  const probe = useQuery({
    queryKey: ['play-info', file.server, file.path],
    queryFn: () => api.get<PlayInfo>(`/api/play/info?server=${file.server}&path=${encodeURIComponent(file.path)}`),
    enabled: open && video,
    staleTime: 10 * 60_000,
    retry: false,
  })
  const p = probe.data
  const langs = (tracks?: PlayInfo['audio']) =>
    [...new Set((tracks ?? []).map((x) => langName(x.lang, i18n?.language ?? 'en')))].join(', ') || t('series.ep.none')
  const pending = probe.isPending && video ? t('series.ep.probing') : ''
  const facts: [string, string][] = [
    [t('series.ep.file'), file.name],
    [t('series.ep.size'), fmtBytes(file.size)],
    ...(video
      ? ([
          [t('series.ep.picture'), p?.video ? `${p.video.height}p · ${p.video.codec.toUpperCase()}` : pending || ''],
          [t('series.ep.sound'), p ? langs(p.audio) : pending || ''],
          [t('series.ep.subs'), p ? langs(p.subs) : pending || ''],
        ] as [string, string][])
      : []),
    [t('series.ep.source'), watch?.serverName || (file.server === 0 ? t('series.ep.local') : '')],
    [
      t('series.ep.loaded'),
      file.modTime ? new Date(file.modTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '',
    ],
    [t('series.ep.aired'), aired ?? ''],
  ]
  return (
    <div className="ws-ep-facts" id={id} hidden={!open}>
      {open && (
        <dl>
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className={k === t('series.ep.file') ? 'ws-mono' : undefined}>{v}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  )
}
