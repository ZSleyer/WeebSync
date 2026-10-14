// The shapes of the loading duo (LoadingIndicator). Two halves, one red and
// one teal, that are two dots, then a yin and yang, then a flower split down
// the middle, then two diamonds. Each shape is the same number of points in
// the same order (from the top, clockwise), so clip-path morphs one into the
// next in every engine; WebKit can't morph a path.

type Pt = [number, number]

const N = 48

const arc = (cx: number, cy: number, r: number, from: number, to: number, steps = 64): Pt[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180
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
const poly = (pts: Pt[]) => `polygon(${resample(pts).map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(',')})`

// red's half of the yin and yang: down the S through the middle, back up
// the left side of the big circle
const yin: Pt[] = [...arc(50, 25, 25, -90, -270), ...arc(50, 75, 25, -90, 90), ...arc(50, 50, 50, 90, 270)]

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

const red = [arc(30, 50, 19, 0, 360, 128), yin, flower, diamond(34, 34, 24)]
const teal = [arc(72, 50, 13, 0, 360, 128), turn(yin), mirror(flower), diamond(68, 68, 18)]

/** --a0..3 (red) and --b0..3 (teal), for the duo's inline style */
export const DUO_SHAPES = Object.fromEntries([
  ...red.map((s, i) => [`--a${i}`, poly(s)]),
  ...teal.map((s, i) => [`--b${i}`, poly(s)]),
]) as Record<string, string>
