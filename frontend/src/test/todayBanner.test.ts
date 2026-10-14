import { expect, test } from 'vitest'
import { deal, nextPattern, PATTERNS, placed, shapes } from '../pages/today/banner'

test('a pattern never follows itself', () => {
  for (let last = -1; last < PATTERNS.length; last++) {
    for (const r of [0, 0.1, 0.3, 0.5, 0.79, 0.99, 0.999999]) {
      const n = nextPattern(last, () => r)
      expect(n).not.toBe(last)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(PATTERNS.length)
    }
  }
  // every other pattern can come up
  const seen = new Set<number>()
  for (let i = 0; i < 40; i++) seen.add(nextPattern(2, () => i / 40))
  expect([...seen].sort()).toEqual([0, 1, 3, 4])
})

test('every pattern has at most five panels, one main and one under the caption', () => {
  for (const pt of PATTERNS) {
    const panels = deal(pt, ['a', 'b', 'c', 'd', 'e'])
    expect(panels.length).toBeLessThanOrEqual(5)
    expect(panels.filter((p) => p.under).length).toBeGreaterThanOrEqual(1)
    // the main panel gets the first banner, the caption's panel the next
    const main = panels.find((p) => p.feat)!
    expect(main.b).toBe('a')
    expect(panels.find((p) => p.under)!.b).toBe('b')
    expect(panels.find((p) => p.under)!.tone).toBe('teal')
  }
})

test('panels without a banner become tone panels', () => {
  const panels = deal(PATTERNS[0], ['only'])
  expect(panels.filter((p) => p.b).length).toBe(1)
  expect(panels.filter((p) => !p.b).every((p) => p.fill)).toBe(true)
})

test('inner gutters are constant, corners carry the arc', () => {
  const W = 1200
  const H = 300
  const g = 8
  const pt = PATTERNS[3] // three columns, no split
  const panels = deal(pt, [1, 2, 3])
  const polys = shapes(pt, panels, W, H, g, 16)
  // at the top edge the gap between column 0's right and column 1's left is g
  // measured along the normal of the cut
  const cut = pt.cuts[1] * W
  const lean = pt.lean[1] * W
  const len = Math.hypot(lean, H)
  const atTop = (poly: [number, number][]) => poly.filter(([, y]) => Math.abs(y) < 0.5).map(([x]) => x)
  const right0 = Math.max(...atTop(polys[0]))
  const left1 = Math.min(...atTop(polys[1]))
  expect(((left1 - right0) * H) / len).toBeCloseTo(g, 1)
  expect(right0).toBeLessThan(cut)
  // column 0 starts at the page's top left corner: an arc, many points, none outside
  expect(polys[0].length).toBeGreaterThan(4)
  for (const [x, y] of polys.flat()) {
    expect(x).toBeGreaterThanOrEqual(-0.01)
    expect(x).toBeLessThanOrEqual(W + 0.01)
    expect(y).toBeGreaterThanOrEqual(-0.01)
    expect(y).toBeLessThanOrEqual(H + 0.01)
  }
  // the middle column touches no corner: four plain points
  expect(polys[1].length).toBe(4)
  // without a radius no arc
  expect(shapes(pt, panels, W, H, g, 0)[0].length).toBe(4)
})

test('a placed polygon sits in its own box', () => {
  const p = placed(
    [
      [10, 0],
      [110, 0],
      [100, 50],
      [0, 50],
    ],
    200,
    50,
  )
  expect(p).toMatchObject({ left: 0, top: 0, width: 110, height: 50 })
  expect(p.clip.startsWith('polygon(10.0px 0.0px')).toBe(true)
})
