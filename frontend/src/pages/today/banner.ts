// The Today page's hero: a manga page cut from banners. Five hand-set cut
// patterns (never the same twice in a row), panels drawn as polygons in
// pixels so the gutters stay constant at any width, and the banner's corner
// radius carried by the polygons themselves, so a panel lifted out by a view
// transition keeps its shape.

/** One cut pattern: the column cuts as fractions of the width, the lean of each cut, splits per column. */
export interface Pattern {
  /** x of every cut, 0 and 1 included */
  cuts: number[]
  /** how far each cut leans, as a fraction of the width (top to bottom) */
  lean: number[]
  /** a column split across: [where, as a fraction of the height; tilt] */
  split: Record<number, [number, number]>
  /** the column holding the large main panel */
  feat: number
  /** the panel drawn in the red duotone */
  red: number
}

export const PATTERNS: Pattern[] = [
  { cuts: [0, 0.28, 0.68, 1], lean: [0, 0.05, -0.04, 0], split: { 2: [0.5, 0.04] }, feat: 1, red: 3 },
  { cuts: [0, 0.3, 0.56, 1], lean: [0, -0.05, 0.06, 0], split: { 1: [0.46, -0.05] }, feat: 2, red: 1 },
  { cuts: [0, 0.26, 0.62, 0.81, 1], lean: [0, 0.05, 0.04, -0.05, 0], split: { 2: [0.52, 0.05] }, feat: 1, red: 4 },
  { cuts: [0, 0.3, 0.76, 1], lean: [0, 0.06, -0.05, 0], split: {}, feat: 1, red: 2 },
  { cuts: [0, 0.24, 0.46, 1], lean: [0, -0.04, 0.05, 0], split: { 1: [0.55, 0.04] }, feat: 2, red: 2 },
]

/** A pattern other than the last one shown; `rnd` returns 0..1. */
export function nextPattern(last: number, rnd: () => number = Math.random, count = PATTERNS.length): number {
  if (count < 2) return 0
  // draw among the others: no retry loop, every other pattern equally likely
  let n = Math.floor(rnd() * (count - 1))
  if (n >= last && last >= 0) n++
  return Math.min(n, count - 1)
}

/** One panel of a dealt page. */
export interface Panel<B> {
  col: number
  /** -1 for a whole column, 0 the upper and 1 the lower half of a split one */
  row: number
  split: { at: number; tilt: number } | null
  /** lies under the caption box: always the dark teal duotone */
  under: boolean
  feat: boolean
  /** the picture, or null for a tone panel */
  b: B | null
  tone: 'plain' | 'teal' | 'red'
  /** the side the halftone dots gather at */
  dots: string
  /** the tone fill of a panel without a picture */
  fill: 'speed-red' | 'half-teal' | 'speed-cream'
}

const FILLS = ['speed-red', 'half-teal', 'speed-cream'] as const
const DOTS = ['to top', 'to bottom', 'to right', 'to left']

/**
 * Lays the banners into a pattern's panels: the main panel first, the one
 * under the caption next, then the rest; panels left over are tone panels.
 */
export function deal<B>(pt: Pattern, banners: B[]): Panel<B>[] {
  const panels: Panel<B>[] = []
  for (let k = 0; k < pt.cuts.length - 1; k++) {
    const sp = pt.split[k]
    const split = sp ? { at: sp[0], tilt: sp[1] } : null
    for (let q = 0; q < (split ? 2 : 1); q++)
      panels.push({
        col: k,
        row: split ? q : -1,
        split,
        under: k === 0,
        feat: k === pt.feat,
        b: null,
        tone: 'plain',
        dots: DOTS[panels.length % 4],
        fill: FILLS[panels.length % 3],
      })
  }
  const order = panels
    .map((_, k) => k)
    .sort(
      (a, b) => Number(panels[b].feat) - Number(panels[a].feat) || Number(panels[b].under) - Number(panels[a].under),
    )
  order.forEach((k, i) => (panels[k].b = banners[i] ?? null))
  panels.forEach((p, k) => {
    p.tone = p.under ? 'teal' : k === pt.red ? 'red' : 'plain'
  })
  return panels
}

type Line = [number, number, number, number]
type Pt = [number, number]

const inter = (a: Line, b: Line): Pt => {
  const d1x = a[2] - a[0]
  const d1y = a[3] - a[1]
  const d2x = b[2] - b[0]
  const d2y = b[3] - b[1]
  const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / (d1x * d2y - d1y * d2x)
  return [a[0] + t * d1x, a[1] + t * d1y]
}

// a line moved by d along its normal, towards the point (cx, cy)
const shift = (l: Line, cx: number, cy: number, d: number): Line => {
  let nx = -(l[3] - l[1])
  let ny = l[2] - l[0]
  const len = Math.hypot(nx, ny)
  nx /= len
  ny /= len
  if ((cx - (l[0] + l[2]) / 2) * nx + (cy - (l[1] + l[3]) / 2) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  return [l[0] + nx * d, l[1] + ny * d, l[2] + nx * d, l[3] + ny * d]
}

/** points of an arc per quarter circle at a banner corner */
const ARC_STEPS = 6

/**
 * The panels' polygons in pixels for a W x H page: inner edges moved half a
 * gutter `g` inward (so every gutter is g wide), outer edges on the page's
 * edge, and a corner of the page drawn as an arc of radius `rad`. Points run
 * clockwise.
 */
export function shapes(pt: Pattern, panels: Panel<unknown>[], W: number, H: number, g: number, rad: number): Pt[][] {
  const vx = (k: number): Line => {
    const x = pt.cuts[k] * W
    const dx = pt.lean[k] * W
    return [x - dx / 2, 0, x + dx / 2, H]
  }
  const top: Line = [0, 0, W, 0]
  const bottom: Line = [0, H, W, H]
  return panels.map((p) => {
    const left = vx(p.col)
    const right = vx(p.col + 1)
    const sl: Line | null = p.split
      ? [0, (p.split.at - p.split.tilt / 2) * H, W, (p.split.at + p.split.tilt / 2) * H]
      : null
    const edges = [
      { l: p.row === 1 ? sl! : top, inner: p.row === 1 },
      { l: right, inner: p.col + 1 < pt.cuts.length - 1 },
      { l: p.row === 0 ? sl! : bottom, inner: p.row === 0 },
      { l: left, inner: p.col > 0 },
    ]
    const raw = edges.map((e, k) => inter(e.l, edges[(k + 3) % 4].l))
    const cx = raw.reduce((a, q) => a + q[0], 0) / 4
    const cy = raw.reduce((a, q) => a + q[1], 0) / 4
    const off = edges.map((e) => (e.inner ? shift(e.l, cx, cy, g / 2) : e.l))
    const pts = off.map((l, k) => inter(l, off[(k + 3) % 4]))
    const out: Pt[] = []
    for (const [x, y] of pts) {
      const L = x < 1
      const R = x > W - 1
      const T = y < 1
      const B = y > H - 1
      if (!((L || R) && (T || B)) || !rad) {
        out.push([x, y])
        continue
      }
      const ax = L ? rad : W - rad
      const ay = T ? rad : H - rad
      const a0 = L && T ? Math.PI : R && T ? 1.5 * Math.PI : R && B ? 0 : 0.5 * Math.PI
      for (let i = 0; i <= ARC_STEPS; i++) {
        const a = a0 + (i * Math.PI) / 2 / ARC_STEPS
        out.push([ax + Math.cos(a) * rad, ay + Math.sin(a) * rad])
      }
    }
    return out
  })
}

/** A polygon placed in its own bounding box: the box in page pixels and the clip path inside it. */
export function placed(pts: Pt[], W: number, H: number) {
  const xs = pts.map((q) => q[0])
  const ys = pts.map((q) => q[1])
  const x0 = Math.max(0, Math.min(...xs))
  const x1 = Math.min(W, Math.max(...xs))
  const y0 = Math.max(0, Math.min(...ys))
  const y1 = Math.min(H, Math.max(...ys))
  const clip = `polygon(${pts.map(([x, y]) => `${(x - x0).toFixed(1)}px ${(y - y0).toFixed(1)}px`).join(', ')})`
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, clip }
}
