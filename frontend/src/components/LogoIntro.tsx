import { useId, useLayoutEffect, useRef, useState } from 'react'
import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from '../logo'
import Logo from './Logo'

// The mark drawing itself in: on the login and wherever the shell shows it,
// again on every page change (the caller keys it by route). Five intros, one
// drawn at random per mount. Each is a timeline of
// overlapping beats driven by rAF and plain SVG attributes - WebKit ignores
// CSS transforms inside a clipPath - that enters with ease-out curves, stays
// under two seconds and lands on the static mark, sheen and all. Motion off:
// the static mark straight away.

const H = LOGO_H
const ROWS = 12
const HEAD = 0.06 // the running head of a traced outline, as a share of its length

const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const outExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
const outBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2)
const lin = (t: number) => t
// the wipe's edge runs on the slant of the mark itself
const slant = (x: number) => `-300,0 ${x.toFixed(1)},0 ${(x - 216).toFixed(1)},${H} -300,${H}`

export const INTROS = ['trace', 'cut', 'set', 'stream', 'roll'] as const
export type Intro = (typeof INTROS)[number]
const DURATION: Record<Intro, number> = { trace: 1950, cut: 1300, set: 900, stream: 1250, roll: 800 }

const still = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

export default function LogoIntro({
  className = '',
  intro,
  active = false,
}: {
  className?: string
  intro?: Intro
  active?: boolean
}) {
  const id = useId()
  const [play] = useState<Intro | null>(() =>
    still() ? null : (intro ?? INTROS[Math.floor(Math.random() * INTROS.length)]),
  )
  const [done, setDone] = useState(false)
  const svg = useRef<SVGSVGElement>(null)

  // layout effect: the first frame is set before the browser paints, so no
  // intro flashes its finished mark first
  useLayoutEffect(() => {
    const root = svg.current
    if (!play || !root) return
    const q = (sel: string) => [...root.querySelectorAll<SVGElement>(sel)]
    const set = (els: SVGElement[], k: string, v: string | number) => els.forEach((e) => e.setAttribute(k, String(v)))
    const el = {
      all: q('[data-k="all"]'),
      wipe: q('[data-k="wipe"]'),
      lvl: q('[data-k="lvl"]'),
      gw: q('[data-k="gw"]'),
      gs: q('[data-k="gs"]'),
      lnW: q('[data-k="ln-w"]'),
      lnS: q('[data-k="ln-s"]'),
      hdW: q('[data-k="hd-w"]'),
      hdS: q('[data-k="hd-s"]'),
      edge: q('[data-k="edge"]'),
      stW: q('[data-k="st-w"] rect'),
      stS: q('[data-k="st-s"] rect'),
      sheen: q('[data-k="sheen"]'),
    }
    const level = (v: number) => set(el.lvl, 'y', (H * (1 - v)).toFixed(1))
    const sheen = (p: number) => set(el.sheen, 'transform', `translate(${(-700 + 2200 * p).toFixed(1)} 0)`)
    const stripes = (els: SVGElement[], width: number, t: number, from: number) =>
      els.forEach((r, i) =>
        r.setAttribute('width', (width * outExpo(Math.min(1, Math.max(0, (t - from - i * 34) / 520)))).toFixed(1)),
      )

    const at: Record<Intro, (t: number, seg: (a: number, b: number, e: (x: number) => number) => number) => void> = {
      // the outlines trace with a running head, the fills follow, one sheen closes
      trace: (_t, seg) => {
        const m = seg(0, 400, outExpo)
        set(el.all, 'transform', `translate(0 ${((1 - m) * 40).toFixed(1)})`)
        set(el.all, 'opacity', m.toFixed(3))
        const pw = seg(0, 850, inOut)
        const ps = seg(220, 1070, inOut)
        set(el.lnW, 'stroke-dashoffset', 1 - pw)
        set(el.lnS, 'stroke-dashoffset', 1 - ps)
        set(el.hdW, 'stroke-dashoffset', HEAD - pw)
        set(el.hdS, 'stroke-dashoffset', HEAD - ps)
        set(el.hdW, 'stroke-opacity', pw > 0 && pw < 1 ? 1 : 0)
        set(el.hdS, 'stroke-opacity', ps > 0 && ps < 1 ? 1 : 0)
        set(el.wipe, 'points', slant(-300 + 1700 * seg(700, 1200, outExpo)))
        level(seg(900, 1350, outExpo))
        const fade = 1 - seg(1100, 1400, lin)
        set(el.lnW, 'stroke-opacity', fade)
        set(el.lnS, 'stroke-opacity', fade)
        sheen(seg(1350, 1950, inOut))
      },
      // one cut on the mark's own slant uncovers both letters, an accent blade leads
      cut: (_t, seg) => {
        const x = -300 + 1720 * seg(80, 900, outExpo)
        set(el.wipe, 'points', slant(x))
        set(
          el.edge,
          'points',
          `${x.toFixed(1)},0 ${(x + 18).toFixed(1)},0 ${(x - 198).toFixed(1)},${H} ${(x - 216).toFixed(1)},${H}`,
        )
        set(el.edge, 'opacity', 1 - seg(650, 900, lin))
        sheen(seg(800, 1300, inOut))
      },
      // the letters set down in turn and settle with a small overshoot
      set: (_t, seg) => {
        set(el.gw, 'transform', `translate(0 ${((1 - seg(0, 520, outBack)) * -50).toFixed(1)})`)
        set(el.gw, 'opacity', seg(0, 200, lin))
        set(el.gs, 'transform', `translate(0 ${((1 - seg(140, 660, outBack)) * 50).toFixed(1)})`)
        set(el.gs, 'opacity', seg(140, 340, lin))
      },
      // the letters fill row by row, like the queue's progress bars
      stream: (t) => {
        set(el.wipe, 'points', slant(t < 1150 ? -300 : 1400))
        stripes(el.stW, 640, t, 0)
        stripes(el.stS, 490, t, 260)
      },
      // the app's slot roll: each letter rolls up into its place
      roll: (_t, seg) => {
        set(el.gw, 'transform', `translate(0 ${((1 - seg(0, 480, outExpo)) * 640).toFixed(1)})`)
        set(el.gs, 'transform', `translate(0 ${((1 - seg(120, 600, outExpo)) * 640).toFixed(1)})`)
      },
    }

    const t0 = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const t = now - t0
      at[play](t, (a, b, e) => e(Math.min(1, Math.max(0, (t - a) / (b - a)))))
      // landed: hand over to the plain mark, which carries the sheen
      if (t < DURATION[play]) raf = requestAnimationFrame(frame)
      else setDone(true)
    }
    frame(t0)
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [play])

  if (!play || done) return <Logo className={className} active={active} />

  const stripeRows = (x0: number) =>
    Array.from({ length: ROWS }, (_, i) => (
      <rect key={i} x={x0} y={((i * H) / ROWS).toFixed(1)} width={0} height={(H / ROWS + 1).toFixed(1)} />
    ))
  const line = {
    fill: 'none',
    pathLength: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    vectorEffect: 'non-scaling-stroke',
  } as const
  return (
    <svg ref={svg} aria-hidden viewBox={`0 0 ${LOGO_W} ${LOGO_H}`} className={`overflow-visible ${className}`}>
      <defs>
        <clipPath id={`${id}b`}>
          <rect x={-30} y={-30} width={LOGO_W + 60} height={H + 60} />
        </clipPath>
        <clipPath id={`${id}w`}>
          <polygon
            data-k="wipe"
            points={slant(play === 'trace' || play === 'cut' || play === 'stream' ? -300 : 1400)}
          />
        </clipPath>
        <clipPath id={`${id}l`}>
          <rect data-k="lvl" x={540} y={play === 'trace' ? H : 0} width={500} height={H} />
        </clipPath>
        <clipPath id={`${id}ws`}>
          <path d={LOGO_PATH_W} />
        </clipPath>
        <clipPath id={`${id}ss`}>
          <path d={LOGO_PATH_S} />
        </clipPath>
        <linearGradient id={`${id}g`} x1="0" x2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g data-k="all" clipPath={`url(#${id}b)`}>
        <g clipPath={`url(#${id}w)`}>
          <g data-k="gw">
            <path d={LOGO_PATH_W} fill="currentColor" />
          </g>
          <g data-k="gs">
            <g clipPath={`url(#${id}l)`}>
              <path d={LOGO_PATH_S} fill="var(--accent-blue)" />
            </g>
          </g>
        </g>
        {play === 'stream' && (
          <>
            <g data-k="st-w" clipPath={`url(#${id}ws)`} fill="currentColor">
              {stripeRows(0)}
            </g>
            <g data-k="st-s" clipPath={`url(#${id}ss)`} fill="var(--accent-blue)">
              {stripeRows(540)}
            </g>
          </>
        )}
        {play === 'cut' && <polygon data-k="edge" points="-400,0 -384,0 -600,594 -616,594" fill="var(--accent-blue)" />}
        {play === 'trace' && (
          <>
            <path
              data-k="ln-w"
              d={LOGO_PATH_W}
              {...line}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="1 1"
              strokeDashoffset="1"
            />
            <path
              data-k="ln-s"
              d={LOGO_PATH_S}
              {...line}
              stroke="var(--accent-blue)"
              strokeWidth="1.5"
              strokeDasharray="1 1"
              strokeDashoffset="1"
            />
            <path
              data-k="hd-w"
              d={LOGO_PATH_W}
              {...line}
              stroke="var(--accent-blue)"
              strokeWidth="3"
              strokeDasharray={`${HEAD} 1`}
              strokeOpacity="0"
            />
            <path
              data-k="hd-s"
              d={LOGO_PATH_S}
              {...line}
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray={`${HEAD} 1`}
              strokeOpacity="0"
            />
          </>
        )}
        {(play === 'trace' || play === 'cut') && (
          <g clipPath={`url(#${id}ss)`}>
            <g transform="skewX(-20)">
              <rect data-k="sheen" width="220" height={H} fill={`url(#${id}g)`} transform="translate(-700 0)" />
            </g>
          </g>
        )}
      </g>
    </svg>
  )
}
