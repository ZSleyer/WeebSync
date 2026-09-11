import type { Watch } from './api'

// One scheduled release of a watched series. The watches page groups these
// by day for its calendar, the dashboard shows the next few.
export type Airing = { at: number; episode: number; episodeAbs?: number; watch: Watch }

/**
 * Every future release the providers know, flattened across the watches and
 * sorted by time. `withinDays` caps how far ahead to look; without it the
 * list reaches as far as AniList's schedule or TMDB's dated episodes go.
 */
export function upcomingAirings(watches: Watch[], now = Date.now(), withinDays?: number): Airing[] {
  const until = withinDays ? now + withinDays * 86_400_000 : Infinity
  return watches
    .flatMap((w) => (w.airings ?? []).map((a) => ({ at: a.at, episode: a.episode, episodeAbs: a.episodeAbs, watch: w })))
    .filter((e) => e.at * 1000 > now && e.at * 1000 <= until)
    .sort((a, b) => a.at - b.at)
}

/** Local midnight of the day `d` is in. */
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** `days` days after `d`, at the same local time (DST-safe: by date, not by ms). */
export const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes())

/**
 * Local midnight of the first day of the week `d` is in. `firstDay` is the
 * locale's, 1 = Monday .. 7 = Sunday as Intl.Locale.weekInfo counts them.
 */
export function startOfWeek(d: Date, firstDay = 1): Date {
  const day = d.getDay() || 7 // JS: 0 = Sunday; the week info counts 7
  return startOfDay(addDays(d, -((day - firstDay + 7) % 7)))
}

/** The key a day is grouped under: its local date, YYYY-MM-DD. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * One day on or back from `selected` (a dayKey), never before `floor`. Returns
 * the new day together with the week it falls in, so a step over the boundary
 * carries the week strip along. Null means the step was refused.
 */
export function stepDay(selected: string, delta: number, weekStart: Date, floor: Date): { day: string; weekStart: Date } | null {
  const next = addDays(new Date(selected + 'T00:00'), delta)
  if (next.getTime() < floor.getTime()) return null
  const week =
    next.getTime() >= addDays(weekStart, 7).getTime()
      ? addDays(weekStart, 7)
      : next.getTime() < weekStart.getTime()
        ? addDays(weekStart, -7)
        : weekStart
  return { day: dayKey(next), weekStart: week }
}

/** The locale's first day of the week, Monday where the engine cannot say. */
export function localeFirstDay(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } }
    return loc.weekInfo?.firstDay ?? loc.getWeekInfo?.().firstDay ?? 1
  } catch {
    return 1
  }
}
