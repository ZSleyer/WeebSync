import { useEffect, useRef } from 'react'

/**
 * The wavy progress of Material 3 Expressive, drawn into an <svg><path> of
 * each bar: the wave travels one wavelength a second while data flows, its
 * height follows the progress (growing in over the first tenth, flattening
 * into the line over the last), and it eases into every change. A bar that
 * stops settles flat. Both ends run out onto the middle line over half a wave,
 * so the head meets the flat track without a step; a dot sits on the head and
 * marks where the transfer stands. The track is drawn in the
 * same frame, under the wave and from where it ends, and the progress glides
 * to each new value: wave and track never part or overlap. One animation
 * frame loop serves every bar on the page and stops when none is left.
 */
interface Bar {
  svg: SVGSVGElement
  pct: number
  shown: number // the progress drawn, gliding to pct
  active: boolean
  wave: number // px per wave
  amp: number // px, full height
  a: number // the height now, easing to the target
  ph: number
}

const bars = new Set<Bar>()
let raf = 0
let last = 0

const still = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

// 0 at 0 %, full from 10 % to 90 %, 0 again at 100 %
export const waveRamp = (p: number) => Math.max(0, Math.min(1, p / 0.1, (1 - p) / 0.1))

/** The path of one bar: a sine of height `a` over `end` px, eased out at both ends. */
export function wavePath(end: number, mid: number, a: number, wave: number, ph: number): string {
  let d = ''
  const half = wave / 2
  for (let x = 0; x <= end; x = x < end && x + 2 > end ? end : x + 2) {
    const e = Math.max(0, Math.min(1, x / half, (end - x) / half))
    const y = mid + a * e * e * (3 - 2 * e) * Math.sin((2 * Math.PI * x) / wave - ph)
    d += `${x ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(2)}`
    if (x === end) break
  }
  return d
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const calm = still()
  for (const b of bars) {
    const w = b.svg.clientWidth
    const h = b.svg.clientHeight
    if (!w || !h) continue
    b.shown += (b.pct - b.shown) * (calm ? 1 : Math.min(1, dt * 6))
    const p = b.shown / 100
    const target = b.active ? b.amp * waveRamp(p) : 0
    b.a += (target - b.a) * (calm ? 1 : Math.min(1, dt * 4))
    if (b.active && !calm) b.ph = (b.ph + dt * 2 * Math.PI) % (2 * Math.PI)
    const end = Math.min(w, w * p)
    b.svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    const [track, wave, head] = b.svg.children
    track?.setAttribute('d', end < w ? `M${end.toFixed(1)} ${h / 2}H${w}` : '')
    wave?.setAttribute('d', wavePath(end, h / 2, b.a, b.wave, b.ph))
    // the dot marks where the transfer stands, riding the wave's head
    head?.setAttribute('cx', end.toFixed(1))
    head?.setAttribute('cy', String(h / 2))
  }
  raf = bars.size ? requestAnimationFrame(frame) : 0
}

/** Registers the bar's svg with the shared loop while it is mounted. */
export function useWave(pct: number, active: boolean, wave: number, amp: number) {
  const ref = useRef<SVGSVGElement>(null)
  const bar = useRef<Bar | null>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    const b: Bar = { svg, pct: 0, shown: -1, active: false, wave, amp, a: 0, ph: 0 }
    bar.current = b
    bars.add(b)
    if (!raf) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    return () => {
      bars.delete(b)
      bar.current = null
    }
  }, [wave, amp])
  useEffect(() => {
    if (!bar.current) return
    // the first value is drawn as it is, the next ones glide
    if (bar.current.shown < 0) bar.current.shown = pct
    bar.current.pct = pct
    bar.current.active = active
  }, [pct, active, wave, amp])
  return ref
}
