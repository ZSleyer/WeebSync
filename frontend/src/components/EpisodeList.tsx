import { useEffect, useRef, type ReactNode } from 'react'
import { BookOpen, Check, Clock, ExternalLink, Play, X } from 'lucide-react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, ButtonLink, Divider, useReveal } from 'fluid-lycoris'
import { api, fmtBytes, type Download, type Entry, type Watch, type WatchEpisode, type WatchEpisodes } from '../api'
import Loading from './Loading'
import { isVideo, listFolder, titleFilesIn } from './playLinks'

/** A folder a title's episodes lie in: the local library (server 0) or a server. */
export interface EpisodeFolder {
  server: number
  path: string
}

interface Group {
  label: string
  files: Entry[]
}

/** A video and the server its folder is on. */
type File = Entry & { server: number }

const PROVIDER_LABEL: Record<string, string> = { tvdb: 'TVDB', tmdb: 'TMDB' }

// the season and episode a file name carries
const SXE = /S(\d{1,2})\s*E(\d{1,4})/i
// a standalone number: not glued to letters (1080p, x264), digits or a decimal
// point (5.1); a release's version tail (05v2) still counts
const NUM = /(?<![\p{L}\d.])(\d{1,4})(?:v\d)?(?![\p{L}\d]|\.\d)/gu
const pad = (n: number | string) => String(n).padStart(2, '0')
const fileKey = (f: File) => `${f.server}:${f.path}`

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
 * Pairs files with the provider's episodes: by SxxEyy in the name, else by its
 * last standalone number against the absolute and then the episode number.
 * The first file per episode wins; a second copy stays in `rest`, still playable.
 */
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

/**
 * The title card's "Episodes" section: per watch its sync header (`renderWatch`
 * wraps the list in it) and the provider's episodes, each with its state and,
 * where a file matched, a play button; then every file no episode claimed.
 * Without a watch it is the plain file list. The file the card was opened for
 * is marked and scrolled to.
 */
export default function EpisodeList({
  folders,
  watches,
  renderWatch,
  highlight,
  onPlay,
}: {
  folders: EpisodeFolder[]
  watches: Watch[]
  renderWatch: (w: Watch, list: ReactNode) => ReactNode
  highlight?: string
  onPlay: (server: number, path: string) => void
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

  // Each watch claims its files in turn, the one the card came from first;
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

  const marked = useRef<HTMLLIElement>(null)
  useEffect(() => {
    // the card jumps to this section itself; a long list still brings the
    // marked file into view
    marked.current?.scrollIntoView({ block: 'nearest' })
  }, [filesIn, epsIn, highlight])

  // Rows slide in as they come into view: tied to the scroll by the
  // stylesheet where the browser can, marked once as they enter elsewhere.
  const box = useRef<HTMLDivElement>(null)
  useReveal(
    box,
    '.t-ep',
    known.reduce((n, q) => n + (q.data?.episodes.length ?? 0), 0),
  )

  const fileRow = (f: File, lead: ReactNode, rest: ReactNode, state?: WatchEpisode) => {
    const here = f.path === highlight
    return (
      <li
        key={fileKey(f)}
        ref={here ? marked : undefined}
        data-state={state && stateOf(state)}
        className={`t-ep-file ${state ? 't-ep flex items-center gap-1' : ''} ${here ? 't-ep-file--here' : ''}`}
        aria-current={here ? 'true' : undefined}
      >
        {lead}
        {/* named by what it shows (number, title, date or file name) plus
            "play", so speech control can say what it sees (WCAG 2.5.3); the
            full file name stays on hover */}
        <button
          type="button"
          className="t-ep-file__play min-w-0 flex-1"
          title={f.name}
          onClick={() => onPlay(f.server, f.path)}
        >
          {rest}
          <span className="sr-only">{isVideo(f.name) ? t('player.play') : t('viewer.open')}</span>
        </button>
      </li>
    )
  }

  // what is left of the folders, grouped as on disk
  const files = listed.map((q, i) => {
    const f = folders[i]
    const groups = (q.data ?? [])
      .map((g) => ({
        ...g,
        files: g.files.filter((e) => left.has(`${f.server}:${e.path}`)),
      }))
      .filter((g) => g.files.length)
    return groups.map((g) => (
      <div key={`${f.server}:${f.path}:${g.label}`}>
        {(groups.length > 1 || g.label) && <Divider label={g.label || t('series.thisFolder')} />}
        <ul className="-mx-2">
          {g.files.map((e) => {
            const m = SXE.exec(e.name)
            return fileRow(
              { ...e, server: f.server },
              null,
              <>
                <span className="t-ep-file__icon" aria-hidden>
                  {isVideo(e.name) ? (
                    <Play size="0.9em" fill="currentColor" strokeWidth={0} />
                  ) : (
                    <BookOpen size="0.9em" />
                  )}
                </span>
                {m && (
                  <span className="shrink-0 font-mono text-xs tabular-nums text-t-secondary">
                    S{pad(m[1])}E{pad(m[2])}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{e.name.replace(/\.[^.]+$/, '')}</span>
                <span className="hidden shrink-0 font-mono text-ctl-sm text-t-faint sm:inline">{fmtBytes(e.size)}</span>
              </>,
            )
          })}
        </ul>
      </div>
    ))
  })
  const failed = listed.some((q) => q.isError)
  const anyLeft = files.some((g) => g.length)

  return (
    <div ref={box} className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {watches.map((w, i) => {
        const q = known[i]
        const eps = q.data?.episodes ?? []
        const coming = incoming(downloads, w)
        const seasons = [...new Set(eps.map((e) => e.season))]
        // counted here, not taken from the server: a file matched by its
        // absolute number is not missing
        const missing = eps.filter((e) => !e.have && !e.upcoming && !hits[i].has(e)).length
        const provider = q.data?.provider ? PROVIDER_LABEL[q.data.provider] : ''
        return renderWatch(
          w,
          <div key={w.id}>
            <p className="mb-2 flex flex-wrap items-center gap-1.5 text-ctl-sm text-t-secondary">
              {provider && <Badge>{provider}</Badge>}
              {seasons.length === 1 && <Badge>{t('watch.gaps.season', { n: seasons[0] })}</Badge>}
              {!!eps.length && <span>{t('watch.gaps.count', { count: eps.length })}</span>}
              {!!missing && (
                <Badge tone="err">
                  {t('watch.gaps.missingCount', {
                    count: missing,
                    total: eps.length,
                  })}
                </Badge>
              )}
              {q.data?.url && (
                <ButtonLink
                  size="xs"
                  className="ml-auto inline-flex items-center gap-1"
                  href={q.data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('watch.gaps.viewAt', { provider })}
                  <ExternalLink aria-hidden size="1em" />
                </ButtonLink>
              )}
            </p>
            {q.isLoading && <Loading />}
            {q.isError && <p className="text-sm text-err">{t('watch.gaps.error')}</p>}
            {/* the reason sits above the list, not under it: a list without
                titles otherwise reads as a broken feature rather than a
                missing provider */}
            {q.data?.reason && <p className="mb-3 text-ctl-sm text-warn">{t(`watch.gaps.${q.data.reason}`)}</p>}
            {seasons.map((se) => (
              <div key={se} className="mb-3 last:mb-0">
                {seasons.length > 1 && <Divider label={t('watch.gaps.season', { n: se })} />}
                {/* rows slide in from 8px to the right; clipped, so a row on
                    its way in never widens the sheet */}
                <ul className="overflow-x-clip">
                  {eps
                    .filter((e) => e.season === se)
                    .map((raw) => {
                      const f = hits[i].get(raw)
                      // the server marks an episode present only by SxxEyy in
                      // a name; a file this list matched by its absolute
                      // number is just as much there
                      const e = f && !raw.have ? { ...raw, have: true } : raw
                      const body = <EpisodeCells ep={e} play={!!f} />
                      const loading = coming.get(`${e.season}-${e.episode}`)
                      return f ? (
                        fileRow(f, <StateIcon ep={e} loading={loading} />, body, e)
                      ) : (
                        <li
                          key={`${e.season}-${e.episode}`}
                          data-state={stateOf(e)}
                          className="t-ep flex items-center gap-1"
                        >
                          <StateIcon ep={e} loading={loading} />
                          <span className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-2 py-1 text-sm">
                            {body}
                          </span>
                        </li>
                      )
                    })}
                </ul>
              </div>
            ))}
          </div>,
        )
      })}
      {!filesIn ? (
        <Loading />
      ) : (
        epsIn && (
          // the column has to be capped: an auto track grows to the longest
          // file name and the card scrolls sideways
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {watches.length > 0 && anyLeft && <h5 className="t-label">{t('series.otherFiles')}</h5>}
            {files}
            {failed && <p className="text-sm text-err">{t('series.episodesError')}</p>}
            {!watches.length && !anyLeft && !failed && <p className="text-sm text-t-muted">{t('series.noEpisodes')}</p>}
          </div>
        )
      )}
    </div>
  )
}

const stateOf = (ep: WatchEpisode) => (ep.have ? 'have' : ep.upcoming ? 'upcoming' : 'gone')

// The check/cross carries the state as a shape, not only as a colour (WCAG
// 1.4.1), with the word behind it for screen readers. It is the row's first
// child: the rail runs through it.
// a small ring for an episode on its way in, filled with its bytes; px for
// Firefox, which ignores a unitless stroke-dashoffset
const RING = 2 * Math.PI * 6

function StateIcon({ ep, loading }: { ep: WatchEpisode; loading?: number }) {
  const { t } = useTranslation()
  if (loading !== undefined) {
    return (
      <>
        <svg aria-hidden viewBox="0 0 16 16" className="size-[1em] shrink-0 -rotate-90">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border-subtle" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            strokeDasharray={`${RING}px`}
            strokeDashoffset={`${RING * (1 - loading)}px`}
            className="t-live-ring stroke-accent"
          />
        </svg>
        <span className="sr-only">{t('watch.gaps.loading')}</span>
      </>
    )
  }
  return (
    <>
      {/* an episode that has not aired yet is absent, not missing - marking it
          red would paint every running series as half broken */}
      {ep.have ? (
        <Check aria-hidden size="1em" className="shrink-0 text-ok" />
      ) : ep.upcoming ? (
        <Clock aria-hidden size="1em" className="shrink-0 text-t-faint" />
      ) : (
        <X aria-hidden size="1em" className="shrink-0 text-err" />
      )}
      <span className="sr-only">
        {ep.have ? t('watch.gaps.have') : ep.upcoming ? t('watch.gaps.upcoming') : t('watch.gaps.gone')}
      </span>
    </>
  )
}

function EpisodeCells({ ep, play }: { ep: WatchEpisode; play: boolean }) {
  const { t } = useTranslation()
  return (
    <>
      <span className="shrink-0 font-mono text-xs tabular-nums text-t-secondary">
        S{pad(ep.season)}E{pad(ep.episode)}
      </span>
      {ep.absolute && ep.absolute !== ep.episode ? (
        <span className="shrink-0 font-mono text-ctl-sm tabular-nums text-t-faint">{ep.absolute}</span>
      ) : null}
      <span className={`min-w-0 flex-1 truncate ${ep.have || ep.upcoming ? '' : 'text-err'}`}>
        {ep.title || t('watch.gaps.untitled')}
      </span>
      {/* the date is the first thing to go when the row gets tight */}
      {ep.aired && <span className="hidden shrink-0 tabular-nums text-ctl-sm text-t-faint sm:inline">{ep.aired}</span>}
      {play && (
        <span className="t-ep-file__icon" aria-hidden>
          <Play size="0.9em" fill="currentColor" strokeWidth={0} />
        </span>
      )}
    </>
  )
}
