import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// The wipe, after the credits of a TV opening: a thin bar flashes, grows into
// a solid block over the line, withdraws to the far side and leaves the text
// behind it. Out runs in reverse and leaves nothing. The block is the line's
// ::after (a heading keeps ::before for its marker), coloured --wipe-c, which
// defaults to the text colour. Lines that wipe together stagger by --i.

/** in: playing the reveal; out: playing the cut; shown/hidden: at rest */
export type WipePhase = 'in' | 'out' | 'shown' | 'hidden'

/** the out animation's length, its stagger step, and the cap on the stagger */
const OUT_MS = 420
const OUT_STEP_MS = 70
const MAX_STAGGER = 6

/** How long a line takes to wipe out, with its stagger; 0 when motion is reduced. */
export function wipeOutMs(index: number, reduced: boolean): number {
  return reduced ? 0 : OUT_MS + Math.min(index, MAX_STAGGER) * OUT_STEP_MS
}

function reducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off') return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The phase of a wiped line that follows `show`. A change of `show` plays the
 * wipe; the first render stands still unless `appear` asks for the reveal.
 * Out ends hidden once its animation has run.
 */
export function useWipe(show: boolean, { appear = false, index = 0 }: { appear?: boolean; index?: number } = {}): WipePhase {
  const [phase, setPhase] = useState<WipePhase>(show ? (appear ? 'in' : 'shown') : 'hidden')
  const [was, setWas] = useState(show)
  if (was !== show) {
    setWas(show)
    setPhase(show ? 'in' : 'out')
  }
  useEffect(() => {
    if (phase !== 'out') return
    const t = setTimeout(() => setPhase('hidden'), wipeOutMs(index, reducedMotion()))
    return () => clearTimeout(t)
  }, [phase, index])
  return phase
}

export interface WipeProps {
  show: boolean
  children: ReactNode
  /** play the reveal on the first render too */
  appear?: boolean
  /** the place in a group of lines wiping together */
  index?: number
  /** the block's colour; defaults to the text colour */
  color?: string
  as?: 'span' | 'p' | 'div' | 'h1' | 'h2' | 'h3'
  className?: string
}

/** A line of text that wipes in when shown and out when hidden. */
export function Wipe({ show, children, appear, index = 0, color, as: Tag = 'span', className }: WipeProps) {
  const phase = useWipe(show, { appear, index })
  const style = { '--i': Math.min(index, MAX_STAGGER), ...(color ? { '--wipe-c': color } : {}) } as CSSProperties
  return (
    <Tag
      className={cx('t-wipe', className)}
      data-wipe={phase === 'in' || phase === 'out' ? phase : undefined}
      hidden={phase === 'hidden'}
      style={style}
    >
      {children}
    </Tag>
  )
}

/** what enterPage wipes: the page's titles and its section headings */
const WIPE_SELECTOR = '.t-page-title, .t-appbar-title, .t-sec-title'
/** what enterPage lets rise: rows, shelf items, and the children of a [data-rise] container */
const RISE_SELECTOR = ':is(.t-rows > .t-row, .t-shelf > *, [data-rise] > *, .t-rise):not(.t-reveal)'
/** the rise runs as one wave from left to right: its delay grows with the item's place across the screen, up to this */
export const RISE_SPAN_MS = 260

/**
 * The rise delay of an item from where it stands across the screen: 0ms at
 * the left edge, RISE_SPAN_MS at the right. Not from its order or its height,
 * so every visible row starts at the same moment and a grid rises as one wave.
 */
export function riseDelay(left: number, viewportWidth: number): number {
  if (!(viewportWidth > 0)) return 0
  return Math.round(Math.min(1, Math.max(0, left / viewportWidth)) * RISE_SPAN_MS)
}

/**
 * Entering a page, or switching what a part of it shows (a segment, a tab, a
 * filter): its title and section headings wipe in, staggered (a heading's
 * marker stands at once), its meters fill from zero, and every item rises
 * 14px with a fade in one wave from left to right (riseDelay). Plays once per
 * call; call it when the page is entered or the content switched, not on
 * every render.
 */
export function enterPage(root: HTMLElement, extra: HTMLElement[] = []) {
  const lines = [...extra, ...root.querySelectorAll<HTMLElement>(WIPE_SELECTOR)]
  lines.forEach((el, i) => {
    el.classList.add('t-wipe')
    el.style.setProperty('--i', String(Math.min(i, MAX_STAGGER)))
  })
  const width = typeof innerWidth === 'number' ? innerWidth : 0
  for (const el of root.querySelectorAll<HTMLElement>(RISE_SELECTOR)) {
    el.style.setProperty('--rd', `${riseDelay(el.getBoundingClientRect().left, width)}ms`)
  }
  for (const el of new Set([root, ...extra])) {
    el.removeAttribute('data-wipe')
    // a reflow between, so the same value starts the animation again
    void el.offsetWidth
    el.dataset.wipe = 'in'
  }
}

/**
 * Plays enterPage on the element behind `ref` when it mounts and again each
 * time `key` changes (the picked segment, tab, filter or sort).
 */
export function useEnterPage(ref: { current: HTMLElement | null }, key?: unknown) {
  useEffect(() => {
    if (ref.current) enterPage(ref.current)
  }, [ref, key])
}
