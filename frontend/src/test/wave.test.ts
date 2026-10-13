import { describe, expect, it } from 'vitest'
import { wavePath, waveRamp } from '@weebsync/design-system'

const ys = (d: string) =>
  d
    .split(/[ML]/)
    .filter(Boolean)
    .map((pt) => Number(pt.split(' ')[1]))

describe('wavy progress', () => {
  it('runs out onto the middle line at both ends, so the head meets the track', () => {
    const y = ys(wavePath(301, 6, 3, 24, 1.3))
    expect(y[0]).toBe(6)
    expect(y[y.length - 1]).toBe(6)
    expect(Math.max(...y)).toBeGreaterThan(8)
  })
  it('grows in over the first tenth and flattens over the last', () => {
    const want = [0, 0.5, 1, 1, 1, 0.5, 0]
    ;[0, 0.05, 0.1, 0.5, 0.9, 0.95, 1].forEach((p, i) => expect(waveRamp(p)).toBeCloseTo(want[i]))
  })
})
