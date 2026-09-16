import { useEffect, useRef, type PointerEvent, type RefObject } from 'react'

// A bottom sheet follows the finger from anywhere on its surface. Restricting
// the pull to a handle or a header is the thing people notice as wrong: every
// native sheet drags from its whole face, and Apple ships the grabber hidden by
// default precisely because it is a hint rather than the handle.
//
// The whole difficulty is that the surface also scrolls, and one finger cannot
// do both. Handing that decision to the browser through `touch-action` does not
// work, and the way it fails is invisible to a mouse: `pan-y` on the scrolling
// middle lets the browser claim every vertical gesture the moment it starts. On
// a sheet whose content fits, there is nothing to scroll, so the browser eats
// the gesture and the sheet never moves - while the same drag with a mouse,
// which `touch-action` does not govern at all, works perfectly. So the
// arbitration lives here instead, and the decision is made on the FIRST move of
// the gesture, before the browser has committed to scrolling:
//
//   down, and the scroller under the finger is at its top   -> the sheet's
//   down, and it is not                                     -> the scroller's
//   up, and the sheet is at its opening height              -> the sheet's
//   up, and it is already open to full height               -> the scroller's
//
// Once the sheet owns the gesture it follows the finger 1:1 in both directions
// - up as far as its full height, with a rubber band past that - and nothing
// is decided until the finger lifts: the nearest height wins, or a flick
// carries it over. Deciding mid-gesture (the old 32px trigger) made the sheet
// snap open under a finger that was still pulling.
//
// A gesture the sheet claims is cancelled with `preventDefault` on a
// non-passive `touchmove`, which is the only thing that stops a browser scroll
// once a finger is down. React attaches its own touch handlers passively, so
// these have to be native listeners.

// px/ms, measured over the whole gesture: a flick this fast closes the sheet
// however short the pull was.
const VELOCITY = 0.4
// or a pull past a quarter of the sheet's height. The fraction alone is too
// twitchy on a short sheet, hence the floor.
const CLOSE_FRACTION = 0.25
const CLOSE_MIN = 64
// a move shorter than this is a tap with a shaky thumb, not a pull
const SLOP = 6
// a flick this fast between the two heights carries the sheet over, however
// short the pull. Gentler than the dismissal, which throws the sheet away.
const DETENT_VELOCITY = 0.3
// the first move of a touch gesture decides who owns it, and it has to decide
// on less than the tap slop - waiting longer means the browser has already
// started scrolling and `preventDefault` is ignored from then on
const DECIDE = 3
// an upward pull past this opens the sheet to its full height where the
// height difference cannot be measured (no layout - jsdom); with layout the
// threshold is half the difference, i.e. the nearest height
const EXPAND_AT = 32
// Momentum scrolling fires scroll events with no pointer down, and a flick that
// lands at the top of the content must not turn into a dismissal. A press this
// soon after the last scroll cannot start a drag.
const SCROLL_LOCK_MS = 100
// how far the sheet may be pulled UP past its resting place, and how hard it
// resists on the way: `limit * x * r / (x * r + limit)` saturates instead of
// following, which is what reads as rubber rather than as a broken constraint.
const OVERDRAG_LIMIT = 40
const OVERDRAG_R = 0.55
// the slide-out, and the safety net in case transitionend never fires. The
// settle back into place has no number here: it runs on the stylesheet's own
// transition, which is the one that also moves the height.
const CLOSE_MS = 250

// Controls that own the pointer themselves, plus the opt-out for anything that
// pans on its own (a slider, a horizontal carousel).
const NO_DRAG = 'input, textarea, select, [contenteditable], [data-no-drag]'

// rubber band: the pull-up distance the sheet actually moves
const dampen = (over: number) => (OVERDRAG_LIMIT * over * OVERDRAG_R) / (over * OVERDRAG_R + OVERDRAG_LIMIT)

// The scroller between the finger and the sheet, and whether it is at its top.
// Safari lets scrollTop go negative during its bounce, so the test is <= 0
// rather than === 0 - on an over-scrolled sheet the drag would never start.
const scrollerAtTop = (from: Element | null, root: Element): { el: HTMLElement | null; atTop: boolean } => {
  for (let n = from as HTMLElement | null; n && n !== root.parentElement; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1) {
      const oy = getComputedStyle(n).overflowY
      if (oy === 'auto' || oy === 'scroll') return { el: n, atTop: n.scrollTop <= 0 }
    }
  }
  return { el: null, atTop: true }
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export interface SheetDragHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
}

export interface SheetDragOptions {
  /** the sheet itself: what moves, and the root the scroller search stops at */
  sheet: RefObject<HTMLElement | null>
  /** off on a desktop dialog, where there is no sheet to pull */
  enabled: boolean
  /** the sheet stands at its full height rather than its opening height */
  expanded?: boolean
  /** an upward pull asks for the full height */
  onExpand?: () => void
  /** a downward pull from full height asks for the opening height back */
  onCollapse?: () => void
  /** asked before the pull closes; false settles the sheet back into place */
  onRequestClose?: () => boolean | Promise<boolean>
  /** the sheet has slid out - close it for real */
  onClose: () => void
}

/**
 * Pull-to-dismiss and pull-to-expand for a bottom sheet, from anywhere on its
 * surface.
 *
 * Spread the returned handlers on the sheet element for mouse input; touch is
 * handled by native listeners the hook installs itself, because stopping a
 * browser scroll needs a non-passive `touchmove` and React does not give one.
 *
 * The gesture always has a non-dragging alternative beside it (the close
 * button, the backdrop, Escape) - WCAG 2.2 SC 2.5.1 and 2.5.7 both ask for one,
 * and a sheet that can only be swiped apart is unusable for anyone who cannot
 * swipe precisely.
 */
export function useSheetDrag({
  sheet,
  enabled,
  expanded = false,
  onExpand,
  onCollapse,
  onRequestClose,
  onClose,
}: SheetDragOptions): SheetDragHandlers {
  const drag = useRef<{ id: number; y: number; t: number; from: Element; on: boolean; frozen: HTMLElement | null; span: number } | null>(null)
  const lastScroll = useRef(0)
  // the callbacks and the detent change between renders; the native listeners
  // are installed once and read them from here
  const live = useRef({ expanded, onExpand, onCollapse, onRequestClose, onClose })
  live.current = { expanded, onExpand, onCollapse, onRequestClose, onClose }

  // `scroll` does not bubble, so the sheet listens in the capture phase and
  // hears every scroller inside it.
  useEffect(() => {
    const el = sheet.current
    if (!el || !enabled) return
    const seen = () => {
      lastScroll.current = performance.now()
    }
    el.addEventListener('scroll', seen, true)
    return () => el.removeEventListener('scroll', seen, true)
  }, [sheet, enabled])

  const release = (el: HTMLElement, d: NonNullable<typeof drag.current>) => {
    if (d.frozen) d.frozen.style.overflow = ''
    try {
      el.releasePointerCapture(d.id)
    } catch {
      /* a synthetic pointer id, or jsdom */
    }
  }

  // The distance between the two heights, measured from whichever the sheet
  // stands at by flipping the attribute with the transition already off (with it on, a
  // forced layout would read the start of a transition, not its end). 0 where
  // there is no layout, and the callers fall back to fixed thresholds.
  const span = (el: HTMLElement) => {
    const on = live.current.expanded
    const before = el.clientHeight
    el.toggleAttribute('data-expanded', !on)
    const other = el.clientHeight
    el.toggleAttribute('data-expanded', on)
    return Math.abs(other - before)
  }

  // Where the sheet stands for a pull of `dy`: down follows 1:1, up follows
  // 1:1 as far as the full height and rubber-bands past it (or straight away
  // when it already stands at its full height)
  const follow = (el: HTMLElement, dy: number, span: number) => {
    let y = dy
    if (dy < 0) {
      const room = live.current.expanded ? 0 : span > 0 ? span : Infinity
      y = -dy <= room ? dy : -room - dampen(-dy - room)
    }
    el.style.transform = `translate3d(0, ${y}px, 0)`
  }

  // What a finished pull does: dismiss, step between the two heights, or
  // settle. Shared by the mouse and the touch path.
  const finish = async (el: HTMLElement, dy: number, dt: number, span: number) => {
    const { expanded: isExpanded, onCollapse: collapse, onExpand: expand, onRequestClose: guard, onClose: close } = live.current
    // two events carrying the same timestamp say nothing about speed; the
    // distance still does
    const v = dt > 0 ? dy / dt : 0
    const far = dy > Math.max(el.clientHeight * CLOSE_FRACTION, CLOSE_MIN)
    // the point between the two heights, past which the other one is nearer
    const half = span > 0 ? span / 2 : EXPAND_AT
    // Back to the stylesheet's transition, not to an inline one: the sheet's
    // height animates from there as well, and an inline `transform ...` would
    // leave the height out - the detent would then snap while the transform
    // still holds the pull, and the sheet visibly jumps before it settles.
    const settle = () => {
      el.style.transition = ''
      el.style.transform = ''
    }
    // The detent flips on the element first, so the height and the transform
    // start moving in the same frame; React's commit writes the same value.
    const detent = (on: boolean) => {
      el.toggleAttribute('data-expanded', on)
      ;(on ? live.current.onExpand : live.current.onCollapse)?.()
    }
    // a pull up from the opening height: the full height, once it is nearer
    if (dy < 0) {
      if (!isExpanded && expand && (-dy >= half || -v > DETENT_VELOCITY)) detent(true)
      settle()
      return
    }
    // From the full height a pull down is a step back to the opening height,
    // not a dismissal: the sheet the user grew is not the sheet they meant to
    // throw away, and the second pull from there does dismiss it.
    if (isExpanded && collapse) {
      if (dy >= half || v > DETENT_VELOCITY) detent(false)
      settle()
      return
    }
    if (far || v > VELOCITY) {
      if (!guard || (await guard())) {
        el.style.transition = reducedMotion() ? 'none' : `transform ${CLOSE_MS}ms var(--ease-in)`
        el.style.transform = 'translateY(100%)'
        const done = () => {
          el.removeEventListener('transitionend', done)
          clearTimeout(timer)
          close()
        }
        const timer = setTimeout(done, CLOSE_MS + 100)
        el.addEventListener('transitionend', done)
        return
      }
    }
    settle()
  }

  // ── touch ──────────────────────────────────────────────────────────────
  // Native and non-passive: `preventDefault` on the first `touchmove` is the
  // only way to keep the browser from scrolling instead, and React's own touch
  // handlers are passive.
  useEffect(() => {
    const el = sheet.current
    if (!el || !enabled) return
    // 'none' = undecided, 'sheet' = ours to drag, 'scroll' = the content's,
    // hands off for the rest of the gesture
    let mode: 'none' | 'sheet' | 'scroll' = 'none'
    let startY = 0
    let startT = 0
    let room = 0
    let from: Element | null = null
    let frozen: HTMLElement | null = null

    const reset = () => {
      if (frozen) frozen.style.overflow = ''
      frozen = null
      mode = 'none'
      from = null
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return reset()
      const t = e.touches[0]
      const target = t.target as HTMLElement | null
      if (!target?.closest || target.closest(NO_DRAG)) return reset()
      mode = 'none'
      startY = t.clientY
      startT = performance.now()
      from = target
    }

    const onMove = (e: TouchEvent) => {
      if (!from || e.touches.length !== 1) return
      const dy = e.touches[0].clientY - startY
      if (mode === 'scroll') return
      if (mode === 'none') {
        if (Math.abs(dy) < DECIDE) return
        // a flick that just ended its momentum at the top of the content must
        // not turn into a dismissal
        if (performance.now() - lastScroll.current < SCROLL_LOCK_MS) {
          mode = 'scroll'
          return
        }
        const { el: scroller, atTop } = scrollerAtTop(from, el)
        if (dy > 0) {
          if (!atTop) {
            mode = 'scroll'
            return
          }
        } else if (live.current.expanded || !live.current.onExpand) {
          // upward with no height left to take: the move belongs to the content
          mode = 'scroll'
          return
        }
        mode = 'sheet'
        // The gesture is the sheet's from here. The scroller is frozen so a
        // late scroll cannot slip underneath the drag; it is at its top, so
        // nothing jumps.
        if (scroller) {
          frozen = scroller
          scroller.style.overflow = 'hidden'
        }
        el.style.transition = 'none'
        room = span(el)
      }
      // ours: keep the browser from scrolling and follow the finger
      if (e.cancelable) e.preventDefault()
      follow(el, dy, room)
    }

    const onEnd = (e: TouchEvent) => {
      const claimed = mode === 'sheet'
      const dy = (e.changedTouches[0]?.clientY ?? startY) - startY
      const dt = performance.now() - startT
      reset()
      if (claimed) void finish(el, dy, dt, room)
    }

    const onCancel = () => {
      const claimed = mode === 'sheet'
      reset()
      if (claimed) {
        el.style.transition = ''
        el.style.transform = ''
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      reset()
    }
    // `finish` closes over refs only, so the listeners stay installed for the
    // life of the sheet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, enabled])

  // ── mouse ──────────────────────────────────────────────────────────────
  // A narrow desktop window gets the same sheet, and `touch-action` never
  // governed mouse input, so the pointer path can stay as it was.
  const end = async (e: PointerEvent<HTMLElement>, commit: boolean) => {
    const d = drag.current
    const el = sheet.current
    drag.current = null
    if (!d || !el || e.pointerId !== d.id) return
    release(el, d)
    if (!d.on) return
    if (!commit) {
      // the browser took the pointer for its own pan: settle back
      el.style.transition = ''
      el.style.transform = ''
      return
    }
    await finish(el, e.clientY - d.y, performance.now() - d.t, d.span)
  }

  return {
    onPointerDown: (e) => {
      if (!enabled || drag.current || e.pointerType === 'touch') return
      const el = sheet.current
      const target = e.target as HTMLElement | null
      if (!el || !target?.closest || target.closest(NO_DRAG)) return
      drag.current = { id: e.pointerId, y: e.clientY, t: performance.now(), from: target, on: false, frozen: null, span: 0 }
    },
    onPointerMove: (e) => {
      const d = drag.current
      const el = sheet.current
      if (!d || !el || e.pointerId !== d.id) return
      const dy = e.clientY - d.y
      if (!d.on) {
        if (Math.abs(dy) < SLOP) return
        // upward with no height left to take: not ours
        if (dy < 0 && (live.current.expanded || !live.current.onExpand)) return (drag.current = null) as null
        if (performance.now() - lastScroll.current < SCROLL_LOCK_MS) return (drag.current = null) as null
        // the element the pointer went down on, not the one it is over now:
        // the move may already have left it, and pointer capture will change
        // the target from here on anyway
        const { el: scroller, atTop } = scrollerAtTop(d.from, el)
        if (dy > 0 && !atTop) return (drag.current = null) as null
        d.on = true
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* a synthetic pointer id, or jsdom */
        }
        if (scroller) {
          d.frozen = scroller
          scroller.style.overflow = 'hidden'
        }
        el.style.transition = 'none'
        d.span = span(el)
      }
      follow(el, dy, d.span)
    },
    onPointerUp: (e) => void end(e, true),
    onPointerCancel: (e) => void end(e, false),
  }
}
