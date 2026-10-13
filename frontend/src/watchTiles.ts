import { mediaTitle, type Watch } from './api'
import { attentionInfo, haveLabel } from './attention'

type T = (key: string, opts?: Record<string, unknown>) => string

// What the Auto-Sync page says about a watch in a tile, a list row and the
// filter: one short line instead of a row of chips. Kept apart from the page
// so the wording rules can be tested without rendering it.

/** The page's filter: everything, still airing, with gaps, finished. */
export type WatchFilter = 'all' | 'airing' | 'gaps' | 'done'
export const WATCH_FILTERS: readonly WatchFilter[] = ['all', 'airing', 'gaps', 'done']

export const hasGaps = (w: Pick<Watch, 'missing'>) => (w.missing?.length ?? 0) > 0
export const isAiring = (w: Pick<Watch, 'media' | 'nextAiringAt'>) =>
  w.media?.status === 'RELEASING' || !!w.nextAiringAt

export function matchesFilter(w: Watch, f: WatchFilter): boolean {
  switch (f) {
    case 'airing':
      return isAiring(w)
    case 'gaps':
      return hasGaps(w)
    case 'done':
      return w.complete
    default:
      return true
  }
}

/**
 * The dashboard's old "+N more" link landed with ?filter=attention; what
 * needs a hand now lives on Heute, so that address opens the gaps.
 */
export const normalizeFilter = (f: string): WatchFilter =>
  f === 'attention' ? 'gaps' : (WATCH_FILTERS as readonly string[]).includes(f) ? (f as WatchFilter) : 'all'

/** The name a watch goes by: the override, the record's title, else the folder. */
export const watchName = (w: Watch) => w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')

/**
 * A long runner counted in absolute numbers (One Piece, Conan): no season in
 * its folder and either no episode total or one past any season's length.
 */
export const isAbsolute = (w: Watch) => !(w.seasons?.length ?? 0) && (w.media?.episodes ?? 0) === 0 && w.localFiles > 0

export interface TileSub {
  text: string
  /** gap: missing episodes (warn); err/warn: what needs a hand */
  tone?: 'gap' | 'err' | 'warn'
  /** a download of it runs right now: "lädt" after the line, in the accent */
  loading: boolean
}

/**
 * The tile's line under the title: "S3 · 2 von 12", "Folge 1180",
 * "S2 komplett", "2 fehlen", or the most pressing thing that needs a hand.
 */
export function tileSub(t: T, w: Watch): TileSub {
  const loading = w.active > 0
  const total = w.media?.episodes ?? 0
  if (w.category === 'manga') return { text: haveLabel(t, w, 0), loading }
  const chips = attentionInfo(t, w).filter((c) => c.key !== 'missing')
  const err = chips.find((c) => c.tone === 'err')
  if (err) return { text: err.text, tone: 'err', loading }
  if (hasGaps(w)) return { text: t('watch.tile.missing', { count: w.missing!.length }), tone: 'gap', loading }
  const warn = chips[0]
  if (warn) return { text: warn.text, tone: 'warn', loading }
  const season = w.seasons?.length === 1 ? w.seasons[0] : 0
  if (w.complete)
    return { text: season ? t('watch.tile.seasonComplete', { n: season }) : t('watch.tile.complete'), loading }
  if (isAbsolute(w)) {
    const last = w.nextEpisode ? w.nextEpisode - 1 : w.localFiles
    return { text: t('watch.tile.absolute', { n: last }), loading }
  }
  const have = total > 0 ? t('watch.tile.haveOf', { have: w.localFiles, total }) : String(w.localFiles)
  return { text: season ? t('watch.tile.season', { n: season, have }) : have, loading }
}

/** "heute", "morgen" or "Di. 14.10.": a day near enough to need no year. */
export function dayLabel(t: T, ts: number, now: number): string {
  const day = (ms: number) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((day(ts * 1000) - day(now)) / 86_400_000)
  if (diff === 0) return t('watch.list.today')
  if (diff === 1) return t('watch.list.tomorrow')
  return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' })
}

/** The list's "next" column: "F12 morgen, 16:00", "abgeschlossen" or "kein Termin". */
export function nextCell(t: T, w: Watch, now: number): string {
  if (w.nextAiringAt && w.nextEpisode) {
    const time = new Date(w.nextAiringAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return t('watch.list.next', { n: w.nextEpisode, day: dayLabel(t, w.nextAiringAt, now), time })
  }
  return w.media?.status === 'FINISHED' || w.complete ? t('watch.list.finished') : t('watch.list.noDate')
}

// mount points that only lead to the disk's own folder
const MOUNT = new Set(['media', 'mnt', 'srv', 'data', 'volumes', 'run', 'downloads', 'home'])

/** The list's disk column: the first folder of the local path that is not a mount point. */
export function diskName(localPath: string): string {
  const parts = localPath.split('/').filter(Boolean)
  return parts.find((p) => !MOUNT.has(p.toLowerCase())) ?? parts[0] ?? ''
}

/** The list's state column: a gap, waiting for the next episode, or finished. */
export function checkCell(t: T, w: Watch): string {
  if (hasGaps(w)) return t('watch.list.gap')
  if (w.complete || (!isAiring(w) && w.media?.status === 'FINISHED')) return t('watch.list.done')
  return t('watch.list.waiting')
}

/** The calendar's day heading: "Heute", "Morgen", else "Donnerstag, 15.10.". */
export function calDayHeading(t: T, d: Date, today: Date): string {
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (diff === 0) return t('watch.week.today')
  if (diff === 1) return t('watch.cal.tomorrow')
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'numeric' })
}
