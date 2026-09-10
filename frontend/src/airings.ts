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
