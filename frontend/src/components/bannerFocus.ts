import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import type { Schemas } from '../api.gen'

type Focus = Schemas['api.bannerFocus']

// how much a slice off the middle has to win by before the page moves to it.
// The detail map is a guess (flames and foliage score like a face does), so
// the pull is strong: tuned on 55 AniList banners, at 0.5 the slice only
// leaves the middle for a clear subject, rarely for a busy background
const CENTRE_PULL = 0.5
// what a slice pays for cutting through detail at its sides: a slice that
// halves a character loses to one whose edges fall on empty ground
const CUT_COST = 0.3

/**
 * Where along one axis the box's slice of the picture sits, as an
 * object-position percentage: the window of `frac` of the axis holding the
 * most detail. `frac` >= 1 means the box sees the whole axis.
 */
export function slice(energy: number[], frac: number): number | null {
  const n = energy.length
  if (frac >= 1 || n < 2) return null
  const win = Math.max(1, Math.round(frac * n))
  const room = n - win
  if (room <= 0) return null
  const mean = energy.reduce((a, v) => a + v, 0) / n || 1
  let best = -Infinity
  let at = 0
  for (let s = 0, sum = 0; s <= room; s++) {
    if (s === 0) for (let i = 0; i < win; i++) sum += energy[i]
    else sum += energy[s + win - 1] - energy[s - 1]
    // the pull to the middle keeps a picture without a clear subject centred
    const score =
      (sum / (win * mean)) * (1 - CENTRE_PULL * Math.abs(s / room - 0.5)) -
      (CUT_COST * (energy[s] + energy[s + win - 1])) / (2 * mean)
    if (score > best) {
      best = score
      at = s
    }
  }
  return (at / room) * 100
}

/** The `object-position` axes for a picture drawn `cover` into a w x h box. */
export function focusPosition(f: Focus | undefined, w: number, h: number): { x?: string; y?: string } {
  if (!f || !f.w || !f.h || !w || !h) return {}
  const img = f.w / f.h
  const box = w / h
  const x = slice(f.cols, box / img)
  const y = slice(f.rows, img / box)
  return { x: x == null ? undefined : `${x.toFixed(1)}%`, y: y == null ? undefined : `${y.toFixed(1)}%` }
}

const ANILIST_IMAGE = /^https:\/\/([^/]+\.)?anilist\.co\//

/**
 * The focus map of an AniList banner the page did not arrive with (the Today
 * hero hands its own along). The server reads a picture once and answers empty
 * until then, so an empty answer is asked again a few times.
 */
export function useBannerFocus(url: string | null | undefined, known?: Focus, enabled = true): Focus | undefined {
  const { data } = useQuery<{ focus?: Focus }>({
    queryKey: ['banner-focus', url],
    queryFn: () => api.get(`/api/media/banner-focus?url=${encodeURIComponent(url!)}`),
    enabled: enabled && !known && !!url && ANILIST_IMAGE.test(url),
    staleTime: Infinity,
    retry: false,
    refetchInterval: (q) => (q.state.data?.focus || q.state.dataUpdateCount >= 8 ? false : 2500),
  })
  return known ?? data?.focus
}
