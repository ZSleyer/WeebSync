import { useMemo, useRef, type CSSProperties, type DragEvent, type PointerEvent } from 'react'

// The horizontal counterpart to the sheet's pull-down in dialog.tsx: the same
// pointer-events mechanics (slop, pointer capture, follow-the-finger transform),
// turned sideways and given a direction lock so a vertical scroll still belongs
// to the browser.

// pixels before a move counts as a gesture at all
const SWIPE_SLOP = 10
// how far the content is dragged before letting go pages: a quarter of the
// zone, but never a phone-sized 15px and never a 300px haul across a desktop
// week grid
const commitDistance = (width: number) => Math.min(120, Math.max(60, width * 0.25))
// the offset the arriving content starts from, on the side the finger came from
const ENTER_OFFSET = 40
// safety net for the settle transition, in case transitionend never fires
const SETTLE_MS = 400

export interface SwipeOptions {
  /** a swipe to the right - back. Undefined marks that edge: it only rubber-bands. */
  onPrev?: () => void
  /** a swipe to the left - forward. Undefined marks that edge. */
  onNext?: () => void
  /**
   * Also page on a held mouse button. Off by default: on a page of prose and
   * form fields a mouse drag has to select text, not turn the page.
   */
  mouse?: boolean
  disabled?: boolean
}

export interface SwipeHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
  onDragStart: (e: DragEvent<HTMLElement>) => void
  style: CSSProperties
}

// A scroller between the finger and the swipe zone owns the horizontal axis -
// the scrolling tab bar, a wide table, a row of covers. The zone itself is
// excluded on purpose: it is usually `overflow-y-auto`, whose computed
// overflow-x is `auto` as well, and one long unbreakable word inside it would
// otherwise kill the gesture for good.
const inHorizontalScroller = (from: HTMLElement, stop: HTMLElement) => {
  for (let n: HTMLElement | null = from; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}

// controls that need the pointer for themselves
const NO_SWIPE = 'input, textarea, select, [contenteditable], [data-no-swipe]'

// Zones nest - the calendar body sits inside the page's list/calendar zone -
// and a React event visits the inner handler first. The innermost zone that
// can act on the gesture takes it and marks the event; the outer ones stay
// still rather than dragging along with it.
const claimed = new WeakSet<Event>()

/**
 * Horizontal paging by swipe: spread the returned props on the element that
 * holds the pageable content. The content follows the finger and settles back
 * once the page has turned, so the new content arrives from the side the swipe
 * came from.
 *
 * Every gesture keeps its button (WCAG 2.2 SC 2.5.7) - this only adds a second
 * way to reach what the arrows, tabs or menu already do.
 */
export function useSwipe({ onPrev, onNext, mouse = false, disabled }: SwipeOptions): SwipeHandlers {
  // where the pointer went down, whether it is ours yet, and whether it was
  // given up to a vertical scroll
  const drag = useRef<{ x: number; y: number; id: number; el: HTMLElement; on: boolean; dead: boolean } | null>(null)
  // the handlers are read at the end of the gesture, not captured at its start
  const cb = useRef({ onPrev, onNext })
  cb.current = { onPrev, onNext }

  // Back to no transform at all, never to translateX(0): a transform that stays
  // makes the element a containing block for every `position: fixed` descendant,
  // and the menus inside these zones would anchor to it from then on.
  const settle = (el: HTMLElement) => {
    el.style.transition = 'transform var(--dur-2) var(--ease-out)'
    el.style.transform = ''
    const done = () => {
      el.removeEventListener('transitionend', done)
      clearTimeout(timer)
      el.style.transition = ''
    }
    const timer = setTimeout(done, SETTLE_MS)
    el.addEventListener('transitionend', done)
  }

  const end = (e?: PointerEvent<HTMLElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || !d.on) return
    const el = d.el
    try {
      el.releasePointerCapture(d.id)
    } catch {
      /* a synthetic pointer id, or jsdom */
    }
    const dx = e ? e.clientX - d.x : 0
    const limit = commitDistance(el.clientWidth)
    const go = dx <= -limit ? cb.current.onNext : dx >= limit ? cb.current.onPrev : undefined
    if (go) {
      go()
      // the page has turned; put what is now on screen on the far side of the
      // swipe so it slides in with the finger's direction rather than against it
      el.style.transition = 'none'
      el.style.transform = `translateX(${-Math.sign(dx) * ENTER_OFFSET}px)`
      void el.offsetWidth
    }
    settle(el)
  }

  return {
    onPointerDown: (e) => {
      if (disabled || e.button !== 0) return
      // nothing to page in either direction: no drag, no rubber band
      if (!cb.current.onPrev && !cb.current.onNext) return
      if (!mouse && e.pointerType === 'mouse') return
      if (claimed.has(e.nativeEvent)) return
      const el = e.currentTarget
      const target = e.target as HTMLElement | null
      if (!target?.closest) return
      if (target.closest(NO_SWIPE)) return
      if (inHorizontalScroller(target, el)) return
      claimed.add(e.nativeEvent)
      drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, el, on: false, dead: false }
    },
    onPointerMove: (e) => {
      const d = drag.current
      if (!d || d.dead || e.pointerId !== d.id) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.on) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
        // the direction lock: a move that is more vertical than horizontal is
        // the browser's to scroll, and this pointer is done for us
        if (Math.abs(dx) <= Math.abs(dy)) {
          d.dead = true
          return
        }
        d.on = true
        // from here the pointer is ours: the day button or card under the
        // finger must not get the click when the swipe ends
        try {
          d.el.setPointerCapture(e.pointerId)
        } catch {
          /* a synthetic pointer id, or jsdom */
        }
        d.el.style.transition = 'none'
      }
      // an edge with no handler resists instead of following
      const open = dx < 0 ? cb.current.onNext : cb.current.onPrev
      d.el.style.transform = `translateX(${open ? dx : dx / 3}px)`
    },
    onPointerUp: end,
    onPointerCancel: () => end(),
    // a mouse drag on a cover image would start the browser's own drag and
    // cancel our pointer halfway through the swipe. Only while a gesture of
    // ours is live, or a touch-only zone would lose native dragging on the
    // desktop - a link to the bookmarks bar, a selection, an image.
    onDragStart: (e) => {
      if (drag.current) e.preventDefault()
    },
    style: useMemo<CSSProperties>(
      () =>
        disabled
          ? {}
          : {
              // vertical scrolling and zooming stay with the browser, the
              // horizontal axis is ours
              touchAction: 'pan-y pinch-zoom',
              // a mouse-driven zone would start selecting text inside the slop
              // and keep the highlight afterwards
              ...(mouse ? { userSelect: 'none', WebkitUserSelect: 'none' } : {}),
            },
      [disabled, mouse],
    ),
  }
}
