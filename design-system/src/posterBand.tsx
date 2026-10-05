import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type MouseEvent } from 'react'
import { haptic } from './haptics'
import { Cover } from './composites'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface PosterBandItem {
  key: string
  cover?: string
  /** the poster's own colour, shown while it loads */
  tint?: string
  /** the chip on the poster, e.g. "Fr 17:00" */
  chip: string
  /** the poster button's accessible name */
  label: string
  /** already aired: shown, but stepped back */
  past?: boolean
}

export interface PosterBandProps {
  items: PosterBandItem[]
  /** the poster in the middle */
  index: number
  onIndex: (i: number) => void
  /** a tap on the middle poster; a tap on another brings it to the middle */
  onOpen: (i: number) => void
  /** accessible name of the band */
  label: string
  className?: string
}

// a mouse travels this far before a press is a drag, not a click
const DRAG_SLOP = 6
// the tick as a poster passes the middle
const TICK_MS = 3

/**
 * Releases as a band of posters, the one in the middle standing straight and
 * the others turning away and stepping back the further out they are - one
 * glance says what comes next and what follows. A finger flicks it (snapping
 * poster by poster), a mouse drags it, the arrow keys step it; a tap on a side
 * poster brings it to the middle, a tap on the middle one opens it. The tilt
 * is written straight to each poster from the scroll position, so it follows
 * the finger exactly; reduced motion keeps the band flat.
 */
export function PosterBand({ items, index, onIndex, onOpen, label, className }: PosterBandProps) {
  const band = useRef<HTMLDivElement>(null)
  const at = useRef(index)
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null)

  const posters = () => [...(band.current?.querySelectorAll<HTMLElement>('.t-posterband__item') ?? [])]
  const centre = (i: number, smooth: boolean) => {
    const el = band.current
    const p = posters()[i]
    if (!el || !p) return
    const still =
      document.documentElement.dataset.motion === 'off' ||
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    el.scrollTo?.({ left: p.offsetLeft + p.offsetWidth / 2 - el.clientWidth / 2, behavior: smooth && !still ? 'smooth' : 'auto' })
  }

  // where the middle is, and how far each poster stands from it
  useEffect(() => {
    const el = band.current
    if (!el) return
    let frame = 0
    // the first pass only draws: the band has not been centred on the given
    // poster yet, and what sits in the middle now is not a choice
    const update = (report = true) => {
      frame = 0
      const mid = el.scrollLeft + el.clientWidth / 2
      let best = 0
      let bestD = Infinity
      posters().forEach((p, i) => {
        const w = p.offsetWidth || 1
        const d = Math.max(-2, Math.min(2, (p.offsetLeft + w / 2 - mid) / w))
        p.style.setProperty('--d', d.toFixed(3))
        p.style.setProperty('--ad', Math.abs(d).toFixed(3))
        if (Math.abs(d) < bestD) {
          bestD = Math.abs(d)
          best = i
        }
      })
      if (report && best !== at.current) {
        at.current = best
        haptic(TICK_MS)
        onIndex(best)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => update())
    }
    el.addEventListener('scroll', schedule, { passive: true })
    update(false)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
    }
    // onIndex is read fresh through the closure on every scroll frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  // the first paint opens on the given poster
  useEffect(() => {
    at.current = index
    centre(index, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])
  // a change from outside (a key, a tap on a side poster) brings it over
  useEffect(() => {
    if (index !== at.current) {
      at.current = index
      centre(index, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const step = (to: number) => {
    const i = Math.max(0, Math.min(items.length - 1, to))
    if (i !== index) onIndex(i)
  }

  return (
    <div
      ref={band}
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      className={cx('t-posterband', className)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') step(index + 1)
        else if (e.key === 'ArrowLeft') step(index - 1)
        else return
        e.preventDefault()
      }}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return
        drag.current = { x: e.clientX, left: e.currentTarget.scrollLeft, moved: false }
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x
        if (!d.moved) {
          if (Math.abs(dx) < DRAG_SLOP) return
          d.moved = true
          e.currentTarget.dataset.drag = ''
          e.currentTarget.setPointerCapture(e.pointerId)
        }
        e.currentTarget.scrollLeft = d.left - dx
      }}
      onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current
        if (!d) return
        delete e.currentTarget.dataset.drag
        // a drag settles on the poster nearest the middle; the click that
        // follows it is not a tap on that poster
        if (d.moved) {
          centre(at.current, true)
          setTimeout(() => (drag.current = null), 0)
        } else drag.current = null
      }}
      onClickCapture={(e: MouseEvent) => {
        if (drag.current?.moved) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          className="t-posterband__item"
          data-past={it.past || undefined}
          aria-label={it.label}
          aria-current={i === index || undefined}
          tabIndex={-1}
          onClick={() => (i === index ? onOpen(i) : step(i))}
        >
          <Cover src={it.cover} tint={it.tint} size="fill" />
          <span className="t-posterband__chip">{it.chip}</span>
        </button>
      ))}
    </div>
  )
}
