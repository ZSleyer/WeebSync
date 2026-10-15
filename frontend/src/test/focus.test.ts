import { describe, expect, it } from 'vitest'
import { focusPosition, slice } from '../pages/today/focus'

const flat = Array(64).fill(10)
const right = flat.map((v, i) => (i >= 48 ? 100 : v))

describe('banner focus', () => {
  it('moves the slice to where the detail is', () => {
    expect(slice(right, 0.25)).toBeGreaterThan(90)
    expect(slice(right.toReversed(), 0.25)).toBeLessThan(10)
  })
  it('does not halve a subject to win a little more detail', () => {
    // a figure on cols 40..55 beside a busy strip on 20..39: the slice that
    // holds the whole figure beats the one cut through it
    const scene = flat.map((v, i) => (i >= 40 && i < 56 ? 90 : i >= 20 && i < 40 ? 40 : v))
    const at = slice(scene, 0.25)!
    const start = (at / 100) * (64 - 16)
    expect(start).toBeGreaterThanOrEqual(39)
    expect(start).toBeLessThanOrEqual(41)
  })
  it('keeps a picture without a focus centred', () => {
    expect(slice(flat, 0.4)).toBeCloseTo(50, 0)
  })
  it('leaves an axis the box sees whole alone', () => {
    expect(slice(right, 1)).toBeNull()
    // a 4.7:1 banner in a 16:9 box: cropped sideways only
    const at = focusPosition({ w: 1900, h: 400, cols: right, rows: Array(16).fill(5) }, 360, 202.5)
    expect(parseFloat(at.x!)).toBeGreaterThan(90)
    expect(at.y).toBeUndefined()
  })
  it('does nothing before the server has read the picture', () => {
    expect(focusPosition(undefined, 360, 200)).toEqual({})
  })
})
