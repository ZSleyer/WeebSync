import { useMemo, useRef, type CSSProperties, type DragEvent, type PointerEvent } from 'react'
import { haptic } from './haptics'

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
// the tick under the thumb when a page turns
const HAPTIC_MS = 8

export interface SwipeOptions {
  /** a swipe to the right - back. Undefined marks that edge. */
  onPrev?: () => void
  /** a swipe to the left - forward. Undefined marks that edge. */
  onNext?: () => void
  /**
   * Also page on a held mouse button. Off by default: on a page of prose and
   * form fields a mouse drag has to select text, not turn the page.
   */
  mouse?: boolean
  disabled?: boolean
  /**
   * Deck mode: report the live offset in pixels instead of transforming the
   * element, and leave the rest to the caller. `null` means the gesture ended
   * without turning a page, so the caller settles back. On a page turn the
   * hook only calls onPrev/onNext - the caller owns the animation from there.
   */
  onDrag?: (dx: number | null) => void
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

interface Zone {
  el: HTMLElement | null
  cb: Pick<SwipeOptions, 'onPrev' | 'onNext' | 'onDrag'>
}

// Zones nest: the calendar body sits inside the page, the page inside the app's
// route area. One pointer, one owner - and which one it is only becomes clear
// once the finger has picked a direction, so the decision waits for the first
// move. The innermost zone that can actually go that way wins; the ones that
// cannot are skipped, which is what lets a swipe at the calendar's first week
// fall through to the page underneath.
interface Gesture {
  x: number
  y: number
  /** candidates, innermost first - React events reach the inner handler first */
  zones: Zone[]
  owner: Zone | null
  dead: boolean
}
const live = new Map<number, Gesture>()
// one gesture, many handlers on the way up: the first one to see an event does
// the work for all of them
const seen = new WeakSet<Event>()

const capture = (el: HTMLElement, id: number, take: boolean) => {
  try {
    if (take) el.setPointerCapture(id)
    else el.releasePointerCapture(id)
  } catch {
    /* a synthetic pointer id, or jsdom */
  }
}

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

const show = (z: Zone, dx: number) => {
  // the owner may still be at its own edge in the other direction: resist there
  const open = dx < 0 ? z.cb.onNext : z.cb.onPrev
  const v = open ? dx : dx / 3
  if (z.cb.onDrag) z.cb.onDrag(v)
  else if (z.el) z.el.style.transform = `translateX(${v}px)`
}

/**
 * Horizontal paging by swipe: spread the returned props on the element that
 * holds the pageable content. The content follows the finger and settles back
 * once the page has turned, so the new content arrives from the side the swipe
 * came from. With `onDrag` the hook reports the offset instead and the caller
 * draws the motion - that is how `SwipeDeck` runs a seamless deck.
 *
 * Every gesture keeps its button (WCAG 2.2 SC 2.5.7) - this only adds a second
 * way to reach what the arrows, tabs or menu already do.
 */
export function useSwipe({ onPrev, onNext, mouse = false, disabled, onDrag }: SwipeOptions): SwipeHandlers {
  // one identity per mounted zone, its callbacks refreshed every render so the
  // decision at the end of a gesture uses what is true then
  const zone = useRef<Zone>({ el: null, cb: {} })
  zone.current.cb = { onPrev, onNext, onDrag }

  const end = (e: PointerEvent<HTMLElement>, commit: boolean) => {
    const g = live.get(e.pointerId)
    if (!g || seen.has(e.nativeEvent)) return
    seen.add(e.nativeEvent)
    live.delete(e.pointerId)
    const z = g.owner
    if (!z || !z.el) return
    capture(z.el, e.pointerId, false)
    // a cancelled pointer (the browser took it for its own pan) settles back
    const dx = commit ? e.clientX - g.x : 0
    const go = dx <= -commitDistance(z.el.clientWidth) ? z.cb.onNext : dx >= commitDistance(z.el.clientWidth) ? z.cb.onPrev : undefined
    if (go) {
      haptic(HAPTIC_MS)
      go()
      // a deck draws its own arrival; a plain zone puts what is now on screen
      // on the far side of the swipe so it slides in with the finger
      if (!z.cb.onDrag) {
        z.el.style.transition = 'none'
        z.el.style.transform = `translateX(${-Math.sign(dx) * ENTER_OFFSET}px)`
        void z.el.offsetWidth
        settle(z.el)
      }
      return
    }
    if (z.cb.onDrag) z.cb.onDrag(null)
    else settle(z.el)
  }

  return {
    onPointerDown: (e) => {
      if (disabled || e.button !== 0) return
      if (!mouse && e.pointerType === 'mouse') return
      const el = e.currentTarget
      const target = e.target as HTMLElement | null
      if (!target?.closest) return
      if (target.closest(NO_SWIPE)) return
      if (inHorizontalScroller(target, el)) return
      // the first zone to see this press opens the gesture, the ones above it
      // add themselves as candidates
      if (!seen.has(e.nativeEvent)) {
        seen.add(e.nativeEvent)
        live.set(e.pointerId, { x: e.clientX, y: e.clientY, zones: [], owner: null, dead: false })
      }
      zone.current.el = el
      live.get(e.pointerId)?.zones.push(zone.current)
    },
    onPointerMove: (e) => {
      const g = live.get(e.pointerId)
      if (!g || g.dead || seen.has(e.nativeEvent)) return
      seen.add(e.nativeEvent)
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      if (!g.owner) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
        // the direction lock: a move that is more vertical than horizontal is
        // the browser's to scroll, and this pointer is done for us
        if (Math.abs(dx) <= Math.abs(dy)) {
          g.dead = true
          return
        }
        g.owner = g.zones.find((z) => (dx < 0 ? z.cb.onNext : z.cb.onPrev)) ?? null
        if (!g.owner?.el) {
          g.dead = true
          return
        }
        // from here the pointer is ours: the day button or card under the
        // finger must not get the click when the swipe ends
        capture(g.owner.el, e.pointerId, true)
        if (g.owner.cb.onDrag) g.owner.cb.onDrag(0)
        else g.owner.el.style.transition = 'none'
      }
      show(g.owner, dx)
    },
    onPointerUp: (e) => end(e, true),
    onPointerCancel: (e) => end(e, false),
    // a mouse drag on a cover image would start the browser's own drag and
    // cancel our pointer halfway through the swipe. Only while a gesture of
    // ours is live, or a touch-only zone would lose native dragging on the
    // desktop - a link to the bookmarks bar, a selection, an image.
    onDragStart: (e) => {
      for (const g of live.values()) if (g.owner === zone.current) e.preventDefault()
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
