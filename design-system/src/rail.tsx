import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

/** pixels of slack at either end, so sub-pixel layouts never leave a fade on */
const EDGE = 4
/** how far a mouse moves before a press becomes a drag, so a click stays a click */
const DRAG_SLACK = 6

export interface RailEdges {
  /** there is more to the left */
  start: boolean
  /** there is more to the right */
  end: boolean
}

/** Which ends of a horizontal scroller have more content behind them. */
export function railEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): RailEdges {
  return {
    start: scrollLeft > EDGE,
    end: scrollLeft + clientWidth < scrollWidth - EDGE,
  }
}

export interface RailProps {
  children: ReactNode
  /** names of the paging buttons ("Zurück", "Weiter") */
  prevLabel: string
  nextLabel: string
  /** names the shelf as a region, e.g. the section heading's text */
  'aria-label'?: string
  className?: string
  /** classes for the scrolling row itself (gap, inline margins) */
  shelfClassName?: string
}

const Chevron = ({ flip }: { flip?: boolean }) => (
  <svg
    aria-hidden
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={flip ? { scale: '-1 1' } : undefined}
  >
    <path d="m10 6 6 6-6 6" />
  </svg>
)

/**
 * A horizontal shelf (covers, cards). The row fades at an edge that has more
 * behind it; on a device that hovers, a round button pages that way. A mouse
 * can drag the row, without swallowing a click that did not move; touch
 * scrolls natively.
 */
export function Rail({ children, prevLabel, nextLabel, className, shelfClassName, ...aria }: RailProps) {
  const row = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<RailEdges>({ start: false, end: false })

  // per scroll event only the edges: reading a cover's height and writing a
  // custom property each time cost a layout read and a style pass per frame,
  // which a phone's scroll felt
  const sync = useCallback(() => {
    const el = row.current
    if (!el) return
    const next = railEdges(el.scrollLeft, el.clientWidth, el.scrollWidth)
    setEdges((e) => (e.start === next.start && e.end === next.end ? e : next))
  }, [])
  // the paging buttons sit on the covers' middle, not the captions': measured
  // when the row's size or content changes, never while it scrolls
  const measure = useCallback(() => {
    sync()
    const cover = row.current?.querySelector<HTMLElement>('.t-cover, img')
    if (cover && box.current) box.current.style.setProperty('--cover-h', `${cover.offsetHeight}px`)
  }, [sync])

  useEffect(() => {
    const el = row.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    // a ResizeObserver reports once after the first layout: reading the
    // sizes right here instead forced a layout of the page being mounted
    if (ro) ro.observe(el)
    else measure()
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(measure) : undefined
    mo?.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', sync)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [sync, measure])

  // mouse drag: a few pixels of slack, then the row follows the pointer; the
  // click that ends a drag is eaten so the cover under it does not open
  const drag = useRef<{ id: number; x: number; left: number; moved: boolean } | null>(null)
  const eatClick = useRef(false)
  useEffect(() => {
    const el = row.current
    if (!el) return
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      drag.current = { id: e.pointerId, x: e.clientX, left: el.scrollLeft, moved: false }
    }
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      const dx = e.clientX - d.x
      if (!d.moved && Math.abs(dx) > DRAG_SLACK) {
        d.moved = true
        el.setPointerCapture?.(d.id)
        el.classList.add('dragging')
      }
      if (d.moved) el.scrollLeft = d.left - dx
    }
    const up = () => {
      const d = drag.current
      drag.current = null
      if (!d?.moved) return
      eatClick.current = true
      el.classList.remove('dragging')
      // a click that never comes (released outside) must not eat the next one
      setTimeout(() => (eatClick.current = false), 0)
    }
    const click = (e: MouseEvent) => {
      if (!eatClick.current) return
      eatClick.current = false
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('click', click, true)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('click', click, true)
    }
  }, [])

  const page = (dir: -1 | 1) => {
    const el = row.current
    if (!el) return
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: still ? 'auto' : 'smooth' })
  }

  return (
    <div
      ref={box}
      role={aria['aria-label'] ? 'region' : undefined}
      {...aria}
      className={cx('t-rail', className)}
      data-more-start={edges.start ? '' : undefined}
      data-more-end={edges.end ? '' : undefined}
    >
      <button type="button" className="t-rail-btn t-rail-btn--prev" aria-label={prevLabel} hidden={!edges.start} onClick={() => page(-1)}>
        <Chevron flip />
      </button>
      <div ref={row} className={cx('t-shelf', shelfClassName)}>
        {children}
      </div>
      <button type="button" className="t-rail-btn t-rail-btn--next" aria-label={nextLabel} hidden={!edges.end} onClick={() => page(1)}>
        <Chevron />
      </button>
    </div>
  )
}
