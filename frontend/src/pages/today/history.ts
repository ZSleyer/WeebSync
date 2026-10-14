import type { Download } from '../../api'

// The history page's logic: which finished downloads it shows, how they read
// (done, upgrade, failed), grouped by day, and the week in four numbers.

export type HistKind = 'done' | 'up' | 'fail'
export type HistFilter = 'all' | HistKind

/** what a finished download was: a new episode, a better copy of one, or a failure; null for anything else */
export function histKind(d: Pick<Download, 'status' | 'replaceOld'>): HistKind | null {
  if (d.status === 'error') return 'fail'
  if (d.status === 'done') return d.replaceOld ? 'up' : 'done'
  return null
}

/** when the download ended, in ms; 0 when unknown */
export const endedAt = (d: Pick<Download, 'finishedAt'>) =>
  d.finishedAt ? Date.parse(d.finishedAt.replace(' ', 'T') + 'Z') : 0

const DAY = 86_400_000
const dayStart = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** How many calendar days before `now` the moment `ms` lies (0 today, 1 yesterday). */
export function daysAgo(ms: number, now: number): number {
  return Math.round((dayStart(now) - dayStart(ms)) / DAY)
}

export interface HistDay<T> {
  /** local midnight of the day */
  day: number
  /** 0 today, 1 yesterday, else more */
  ago: number
  items: T[]
}

/** Finished downloads newest first, grouped by local day. */
export function groupByDay<T extends Pick<Download, 'finishedAt'>>(list: T[], now: number): HistDay<T>[] {
  const sorted = [...list].sort((a, b) => endedAt(b) - endedAt(a))
  const out: HistDay<T>[] = []
  for (const d of sorted) {
    const at = endedAt(d)
    const day = dayStart(at)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(d)
    else out.push({ day, ago: daysAgo(at, now), items: [d] })
  }
  return out
}

/** The history's rows for a filter and a search over the title and the file names. */
export function filterHistory<T extends Pick<Download, 'status' | 'replaceOld' | 'remotePath' | 'localPath'>>(
  list: T[],
  filter: HistFilter,
  query: string,
  titleOf: (d: T) => string,
): T[] {
  const q = query.trim().toLowerCase()
  return list.filter((d) => {
    const k = histKind(d)
    if (!k || (filter !== 'all' && k !== filter)) return false
    if (!q) return true
    return `${titleOf(d)} ${d.remotePath} ${d.localPath}`.toLowerCase().includes(q)
  })
}

export interface WeekSummary {
  episodes: number
  bytes: number
  upgrades: number
  failed: number
}

/** The last seven days in four numbers: episodes landed, their size, upgrades among them, failures. */
export function weekSummary(
  list: Pick<Download, 'status' | 'replaceOld' | 'finishedAt' | 'size'>[],
  now: number,
): WeekSummary {
  const s: WeekSummary = { episodes: 0, bytes: 0, upgrades: 0, failed: 0 }
  for (const d of list) {
    const at = endedAt(d)
    if (!at || now - at > 7 * DAY) continue
    const k = histKind(d)
    if (k === 'fail') s.failed++
    else if (k) {
      s.episodes++
      s.bytes += d.size
      if (k === 'up') s.upgrades++
    }
  }
  return s
}

/** App language codes ("Ger", "Jap") as BCP 47 tags, for Intl.DisplayNames and the short chips. */
const LANG_TAGS: Record<string, string> = {
  Ger: 'de',
  Eng: 'en',
  Jap: 'ja',
  Fre: 'fr',
  Spa: 'es',
  Ita: 'it',
  Por: 'pt',
  Rus: 'ru',
  Chi: 'zh',
  Kor: 'ko',
  Ara: 'ar',
  Hin: 'hi',
  Tur: 'tr',
}

/** A language code's short tag for a chip: "DE", "JA". */
export const langChip = (code: string) => (LANG_TAGS[code] ?? code).toUpperCase()

/** A language code in words, in the reader's language: "Deutsch", "Japanisch". */
export function langName(code: string, locale: string): string {
  const tag = LANG_TAGS[code]
  if (!tag) return code
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? code
  } catch {
    return code
  }
}
