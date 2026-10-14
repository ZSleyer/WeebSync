// The shapes of the loading duo (LoadingIndicator). Two halves, one red and
// one teal: two dots, a small yin and yang twisted as if still stirring, a
// flower split down the middle, two diamonds. Each shape is
// the same number of points in the same order (from the top, clockwise), so
// clip-path morphs one into the next in every engine; WebKit can't morph a
// path. The goo filter over them rounds what a morph leaves sharp.

type Pt = [number, number]

const N = 64

const rad = (deg: number) => (deg * Math.PI) / 180

const arc = (cx: number, cy: number, r: number, from: number, to: number, steps = 64): Pt[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = rad(from + ((to - from) * i) / steps)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })

// N points evenly along the outline, starting where the outline crosses
// straight up from its centre, so every shape starts in the same place
function resample(dense: Pt[]): Pt[] {
  const ring = [...dense, dense[0]]
  const len = [0]
  for (let i = 1; i < ring.length; i++)
    len.push(len[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]))
  const total = len[len.length - 1]
  const out: Pt[] = []
  for (let k = 0, j = 1; k < N; k++) {
    const at = (total * k) / N
    while (len[j] < at) j++
    const t = (at - len[j - 1]) / (len[j] - len[j - 1] || 1)
    out.push([ring[j - 1][0] + (ring[j][0] - ring[j - 1][0]) * t, ring[j - 1][1] + (ring[j][1] - ring[j - 1][1]) * t])
  }
  const cx = out.reduce((s, p) => s + p[0], 0) / N
  const cy = out.reduce((s, p) => s + p[1], 0) / N
  const up = (p: Pt) => Math.abs(Math.atan2(p[1] - cy, p[0] - cx) + Math.PI / 2)
  const first = out.reduce((best, p, i) => (up(p) < up(out[best]) ? i : best), 0)
  return [...out.slice(first), ...out.slice(0, first)]
}

const turn = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [100 - x, 100 - y])
const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]): Pt => [100 - x, y]).reverse()
// a twist that grows toward the rim, like a stirred liquid
const swirl = (pts: Pt[], k: number): Pt[] =>
  pts.map(([x, y]): Pt => {
    const dx = x - 50
    const dy = y - 50
    const a = (k * Math.hypot(dx, dy)) / 50
    return [50 + dx * Math.cos(a) - dy * Math.sin(a), 50 + dx * Math.sin(a) + dy * Math.cos(a)]
  })
const poly = (pts: Pt[]) => `polygon(${resample(pts).map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(',')})`

// red's half of the yin and yang, with a seam of 2G to teal's like the
// flower's cut: teal's head (r 25 - G) leaves a hollow of r 25 + G in red,
// red's own head is r 25 - G. The tail stops at TAIL degrees round the rim
// with a round end; run out to a point it was thinner than the goo filter
// can hold and broke off square. Clockwise: round the hollow, down red's
// head, up the rim, over the round end.
const G = 5
const TAIL = 215
const deg = (a: number) => (a * 180) / Math.PI
const tailEnd: Pt = [50 + 50 * Math.cos(rad(TAIL)), 50 + 50 * Math.sin(rad(TAIL))]
const toHollow = Math.atan2(tailEnd[1] - 25, tailEnd[0] - 50)
const tailIn: Pt = [50 + (25 + G) * Math.cos(toHollow), 25 + (25 + G) * Math.sin(toHollow)]
const mid: Pt = [(tailEnd[0] + tailIn[0]) / 2, (tailEnd[1] + tailIn[1]) / 2]
const from = deg(Math.atan2(tailEnd[1] - mid[1], tailEnd[0] - mid[0]))
// the end bulges on along the rim, the way the tail was going
const ahead = (sweep: number) => {
  const a = rad(from + sweep / 2)
  const r = Math.hypot(tailEnd[0] - mid[0], tailEnd[1] - mid[1])
  return deg(Math.atan2(mid[1] + r * Math.sin(a) - 50, mid[0] + r * Math.cos(a) - 50) + 2 * Math.PI) % 360
}
const sweep = ahead(180) > ahead(-180) ? 180 : -180
const capR = Math.hypot(tailEnd[0] - mid[0], tailEnd[1] - mid[1])
// a hint, not the full sign: at 62 % it is gone again before it settles
const yin = swirl(
  [
    ...arc(50, 25, 25 + G, deg(toHollow) + 360, 90),
    ...arc(50, 75, 25 - G, -90, 90),
    ...arc(50, 50, 50, 90, TAIL, 96),
    ...arc(mid[0], mid[1], capR, from, from + sweep, 24),
  ],
  0.45,
).map(([x, y]): Pt => [50 + (x - 50) * 0.62, 50 + (y - 50) * 0.62])

// red's half of an eight-petal flower: up the petals, the cut closes it
const petal = (a: number) => 44 * (1 + 0.09 * Math.cos(8 * a))
const flower = Array.from({ length: 97 }, (_, i): Pt => {
  const a = Math.PI / 2 + (Math.PI * i) / 96
  return [47 + petal(a) * Math.cos(a) * 0.98, 50 + petal(a) * Math.sin(a)]
})

// a diamond with soft corners
const diamond = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 128 }, (_, i) => {
    const a = (i / 128) * 2 * Math.PI
    const k = (Math.abs(Math.cos(a)) ** 1.4 + Math.abs(Math.sin(a)) ** 1.4) ** (-1 / 1.4)
    return [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)]
  })

const dot = (cx: number, r: number) => arc(cx, 50, r, 0, 360, 128)

const red = [dot(28, 18), yin, flower, diamond(34, 34, 24)]
const teal = [dot(74, 13), turn(yin), mirror(flower), diamond(68, 68, 18)]

/** --a0..3 (red) and --b0..3 (teal), for the duo's inline style */
export const DUO_SHAPES = Object.fromEntries([
  ...red.map((s, i) => [`--a${i}`, poly(s)]),
  ...teal.map((s, i) => [`--b${i}`, poly(s)]),
]) as Record<string, string>
