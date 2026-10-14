// A list score between AniList's 100-point raw value and the scale the user
// rates in. Pure, so the series page and its tests agree on the rounding.

export type ScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3'

export function scoreFormat(f?: string): ScoreFormat {
  return f === 'POINT_10_DECIMAL' || f === 'POINT_10' || f === 'POINT_5' || f === 'POINT_3' ? f : 'POINT_100'
}

/** The highest value of a scale. */
export const scoreMax: Record<ScoreFormat, number> = {
  POINT_100: 100,
  POINT_10_DECIMAL: 10,
  POINT_10: 10,
  POINT_5: 5,
  POINT_3: 3,
}

// the raw values the three faces stand for, and where one face ends
const FACES = [0, 35, 60, 85]

/** The raw 0-100 score in the user's scale; 0 is unrated. */
export function toScale(raw: number, f: ScoreFormat): number {
  if (raw <= 0) return 0
  switch (f) {
    case 'POINT_100':
      return Math.round(raw)
    case 'POINT_10_DECIMAL':
      return Math.round(raw) / 10
    case 'POINT_10':
      return Math.max(1, Math.round(raw / 10))
    case 'POINT_5':
      return Math.max(1, Math.round(raw / 20))
    case 'POINT_3':
      return raw <= FACES[1] ? 1 : raw <= FACES[2] ? 2 : 3
  }
}

/** A value in the user's scale as the raw 0-100 score AniList stores. */
export function fromScale(v: number, f: ScoreFormat): number {
  if (!(v > 0)) return 0
  const max = scoreMax[f]
  const c = Math.min(v, max)
  switch (f) {
    case 'POINT_100':
      return Math.round(c)
    case 'POINT_10_DECIMAL':
      return Math.round(c * 10)
    case 'POINT_10':
      return Math.round(c) * 10
    case 'POINT_5':
      return Math.round(c) * 20
    case 'POINT_3':
      return FACES[Math.round(c)]
  }
}
