import { describe, expect, it } from 'vitest'
import { fromScale, scoreFormat, toScale } from '../components/anilistScore'

describe('anilist score scales', () => {
  it('reads the raw score in every scale', () => {
    expect(toScale(83, 'POINT_100')).toBe(83)
    expect(toScale(83, 'POINT_10_DECIMAL')).toBe(8.3)
    expect(toScale(83, 'POINT_10')).toBe(8)
    expect(toScale(83, 'POINT_5')).toBe(4)
    expect(toScale(83, 'POINT_3')).toBe(3)
    expect(toScale(50, 'POINT_3')).toBe(2)
    expect(toScale(20, 'POINT_3')).toBe(1)
    // a low score never reads as unrated
    expect(toScale(3, 'POINT_5')).toBe(1)
    expect(toScale(0, 'POINT_10')).toBe(0)
  })

  it('writes the user value back as the raw score and round-trips', () => {
    expect(fromScale(8.5, 'POINT_10_DECIMAL')).toBe(85)
    expect(fromScale(7, 'POINT_10')).toBe(70)
    expect(fromScale(4, 'POINT_5')).toBe(80)
    expect(fromScale(2, 'POINT_3')).toBe(60)
    expect(fromScale(12, 'POINT_10')).toBe(100)
    expect(fromScale(0, 'POINT_5')).toBe(0)
    for (const f of ['POINT_10', 'POINT_5', 'POINT_3'] as const)
      for (let v = 1; v <= { POINT_10: 10, POINT_5: 5, POINT_3: 3 }[f]; v++) expect(toScale(fromScale(v, f), f)).toBe(v)
  })

  it('falls back to the 100-point scale for an unknown format', () => {
    expect(scoreFormat('POINT_5')).toBe('POINT_5')
    expect(scoreFormat(undefined)).toBe('POINT_100')
    expect(scoreFormat('STARS')).toBe('POINT_100')
  })
})
