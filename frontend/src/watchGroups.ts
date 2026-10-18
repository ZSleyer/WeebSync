import type { Watch } from './api'
import { isAbsolute, isAiring, watchName } from './watchTiles'

// Auto-Sync's sections: the sort decides the order and, from it, the headings
// the tiles fall under - there is no separate "group by". Next sync gives
// Heute / Morgen / Diese Woche / Später, status gives what each watch is
// doing, name gives letters, last check gives how long ago, season gives the
// season. What needs a hand stands first in the two that are about now.
// Pure, so the rules are tested without the page.

export type WatchSort = 'next' | 'status' | 'name' | 'last' | 'season'
export const WATCH_SORTS: readonly WatchSort[] = ['next', 'status', 'name', 'last', 'season']
export type SortDir = 'asc' | 'desc'

export interface WatchGroup {
  /** stable id, e.g. "today", "letter-A", "season-2" */
  key: string
  /** i18n key of the heading, and its values */
  label: string
  values?: Record<string, unknown>
  /** the heading's colour: needs a hand in red, the rest in the sync side's teal */
  tone: 'accent' | 'accent-2'
  watches: Watch[]
}

const DAY = 86_400_000
const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const lastOf = (w: Watch) => Date.parse(w.lastCheck.replace(' ', 'T') + 'Z') || 0
// a title with no episode ahead but a dub still coming waits on the dub's date
const dubAt = (w: Watch) => w.dubExpectedAt || w.dubProgress?.expectedAt || 0
const nextOf = (w: Watch) => (w.nextAiringAt || dubAt(w) || w.nextCheck) * 1000
const seasonOf = (w: Watch) => Number(w.template.match(/S(\d+)E/i)?.[1] ?? 0)
const nameKey = (w: Watch) => watchName(w).toLocaleLowerCase()
const needsHand = (w: Watch) => (w.attention?.length ?? 0) > 0

/** The order inside a section, the same comparator the flat list used. */
export function compareWatches(sort: WatchSort, a: Watch, b: Watch): number {
  switch (sort) {
    case 'last':
      return lastOf(b) - lastOf(a)
    case 'name':
      return nameKey(a).localeCompare(nameKey(b))
    case 'season':
      return seasonOf(a) - seasonOf(b) || nameKey(a).localeCompare(nameKey(b))
    default:
      return nextOf(a) - nextOf(b)
  }
}

// a heading per watch: [order within the sort, key, i18n label, values, tone]
type Slot = [number, string, string, Record<string, unknown> | undefined, WatchGroup['tone']]

function slotOf(sort: WatchSort, w: Watch, now: number): Slot {
  const today = startOfDay(now)
  if ((sort === 'next' || sort === 'status') && needsHand(w))
    return [-1, 'attention', 'watch.group.attention', undefined, 'accent']
  switch (sort) {
    case 'status':
      if (w.active > 0) return [0, 'syncing', 'watch.group.syncing', undefined, 'accent-2']
      if (w.complete) return [4, 'complete', 'watch.group.complete', undefined, 'accent-2']
      if (w.waiting || w.dubWaiting || w.dubProgress)
        return [2, 'waiting', 'watch.group.waiting', undefined, 'accent-2']
      if (isAiring(w)) return [1, 'airing', 'watch.group.airing', undefined, 'accent-2']
      return [3, 'idle', 'watch.group.idle', undefined, 'accent-2']
    case 'name': {
      const c = watchName(w).normalize('NFD').replace(/\p{M}/gu, '').charAt(0).toUpperCase()
      const letter = /[A-Z]/.test(c) ? c : '#'
      return [
        letter === '#' ? 0 : letter.charCodeAt(0),
        `letter-${letter}`,
        'watch.group.letter',
        { letter },
        'accent-2',
      ]
    }
    case 'last': {
      const at = lastOf(w)
      if (!at) return [4, 'never', 'watch.group.never', undefined, 'accent-2']
      if (at >= today) return [0, 'today', 'watch.group.today', undefined, 'accent-2']
      if (at >= today - DAY) return [1, 'yesterday', 'watch.group.yesterday', undefined, 'accent-2']
      if (at >= today - 6 * DAY) return [2, 'week', 'watch.group.lastWeek', undefined, 'accent-2']
      return [3, 'older', 'watch.group.older', undefined, 'accent-2']
    }
    case 'season': {
      if (isAbsolute(w)) return [10_000, 'absolute', 'watch.group.absolute', undefined, 'accent-2']
      const s = seasonOf(w)
      return s
        ? [s, `season-${s}`, 'watch.group.season', { n: s }, 'accent-2']
        : [9_999, 'season-0', 'watch.group.noSeason', undefined, 'accent-2']
    }
    default: {
      if (w.complete) return [5, 'complete', 'watch.group.complete', undefined, 'accent-2']
      // a dub date already gone is overdue, not today
      const at = w.nextAiringAt ? w.nextAiringAt * 1000 : dubAt(w) * 1000 >= today ? dubAt(w) * 1000 : 0
      if (!at) return [4, 'none', 'watch.group.none', undefined, 'accent-2']
      if (at < today + DAY) return [0, 'today', 'watch.group.today', undefined, 'accent-2']
      if (at < today + 2 * DAY) return [1, 'tomorrow', 'watch.group.tomorrow', undefined, 'accent-2']
      if (at < today + 7 * DAY) return [2, 'week', 'watch.group.week', undefined, 'accent-2']
      return [3, 'later', 'watch.group.later', undefined, 'accent-2']
    }
  }
}

/**
 * The watches in their sections for a sort and direction. Descending turns
 * the sections and the order inside them around; what needs a hand stays on
 * top. Empty sections never appear.
 */
export function groupWatches(watches: Watch[], sort: WatchSort, dir: SortDir, now: number): WatchGroup[] {
  const by = new Map<string, { order: number; group: WatchGroup }>()
  for (const w of watches) {
    const [order, key, label, values, tone] = slotOf(sort, w, now)
    const hit = by.get(key)
    if (hit) hit.group.watches.push(w)
    else by.set(key, { order, group: { key, label, values, tone, watches: [w] } })
  }
  const flip = dir === 'desc' ? -1 : 1
  return [...by.values()]
    .sort((a, b) => (a.order === -1 ? -1 : b.order === -1 ? 1 : flip * (a.order - b.order)))
    .map(({ group }) => ({ ...group, watches: group.watches.sort((a, b) => flip * compareWatches(sort, a, b)) }))
}
