import { useEffect, useRef, type PointerEvent, type RefObject } from 'react'
import { EASE_THROW, moveVelocity, project, releaseVelocity, startVelocity, throwMs, type Velocity } from './gesture'

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
// A move that is wider than it is tall is never the sheet's: it is a swipe
// between the tabs inside it, or the browser's. Without that lock a diagonal
// swipe in the series dialog moved the sheet and the tab deck at once.
//
// Once the sheet owns the gesture it follows the finger 1:1 in both directions
// - up as far as its full height, with a rubber band past that - and nothing
// is decided until the finger lifts. What decides is where the throw would come
// to rest (gesture.ts): the release position carried on at the release speed,
// measured over the last 100ms rather than over the whole gesture. So a slow
// pull that ends in a flick closes, and a long pull flicked back up does not.
// Deciding mid-gesture (the old 32px trigger) made the sheet snap open under a
// finger that was still pulling.
//
// A gesture the sheet claims is cancelled with `preventDefault` on a
// non-passive `touchmove`, which is the only thing that stops a browser scroll
// once a finger is down. React attaches its own touch handlers passively, so
// these have to be native listeners.

// A throw that would come to rest past a quarter of the sheet's height closes
// it. The fraction alone is too twitchy on a short sheet, hence the floor.
const CLOSE_FRACTION = 0.25
const CLOSE_MIN = 64
// a move shorter than this is a tap with a shaky thumb, not a pull
const SLOP = 6
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
// the slide-out of a sheet let go at rest, and the base of the safety net in
// case transitionend never fires. A thrown sheet takes its time from the throw
// instead. The settle back into place has no number here: it runs on the
// stylesheet's own transition, which is the one that also moves the height.
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
  const drag = useRef<{ id: number; x: number; y: number; vel: Velocity; from: Element; on: boolean; frozen: HTMLElement | null; span: number } | null>(null)
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

  // A pull up from the opening height lifts the sheet as one block, as a
  // sheet pushed up the screen: the full height goes on at once, offset down
  // by the difference so nothing moves, and the pull takes the offset away.
  // Growing the height instead re-laid the content every frame and the new
  // room opened at the bottom - the sheet spread out rather than rose.
  // `lifted` is that offset while it lasts, 0 otherwise.
  const lifted = useRef(0)
  const begin = (el: HTMLElement, dy: number) => {
    el.style.transition = 'none'
    grip(el, true)
    const s = span(el)
    lifted.current = 0
    if (dy < 0 && s > 0 && !live.current.expanded && live.current.onExpand) {
      el.toggleAttribute('data-expanded', true)
      lifted.current = s
    }
    return s
  }
  // a lift that is called off: back to the opening height without a jump
  const unlift = (el: HTMLElement) => {
    if (!lifted.current) return
    lifted.current = 0
    el.style.transition = 'none'
    el.toggleAttribute('data-expanded', false)
    el.style.transform = ''
    void el.offsetHeight
    el.style.transition = ''
  }

  // How far the sheet has been pulled off the screen, 0..1, for the backdrop:
  // it dims in step with the sheet rather than staying dark until the close.
  // The stylesheet reads the property on `::backdrop`, which inherits from the
  // dialog; `data-dragging` turns the backdrop's own transition off so it
  // follows the finger instead of lagging behind it.
  const pulled = (el: HTMLElement, dy: number) => {
    const h = el.clientHeight
    el.style.setProperty('--sheet-pull', String(h > 0 ? Math.min(1, Math.max(0, dy) / h) : 0))
  }
  const grip = (el: HTMLElement, on: boolean) => {
    el.toggleAttribute('data-dragging', on)
    if (!on) el.style.removeProperty('--sheet-pull')
  }

  // Where the sheet stands for a pull of `dy`: down follows 1:1, up follows
  // 1:1 as far as the full height and rubber-bands past it (or straight away
  // when it already stands at its full height)
  const follow = (el: HTMLElement, dy: number, span: number) => {
    let y = dy
    if (lifted.current) {
      // the full height stands; the pull eats the offset, then rubber-bands
      y = lifted.current + dy
      if (y < 0) y = -dampen(-y)
    } else if (dy < 0) {
      const room = live.current.expanded ? 0 : span > 0 ? span : Infinity
      y = -dy <= room ? dy : -room - dampen(-dy - room)
    }
    el.style.transform = `translate3d(0, ${y}px, 0)`
    pulled(el, dy)
  }

  // What a finished pull does: dismiss, step between the two heights, or
  // settle. Shared by the mouse and the touch path. `v` is the release speed in
  // px/ms, downward positive.
  const finish = async (el: HTMLElement, dy: number, v: number, span: number) => {
    const { expanded: isExpanded, onCollapse: collapse, onExpand: expand, onRequestClose: guard, onClose: close } = live.current
    // where the throw would come to rest, not where the finger let go
    const to = project(dy, v)
    const far = to > Math.max(el.clientHeight * CLOSE_FRACTION, CLOSE_MIN)
    // the point between the two heights, past which the other one is nearer
    const half = span > 0 ? span / 2 : EXPAND_AT
    // Back to the stylesheet's transition, not to an inline one: the sheet's
    // height animates from there as well, and an inline `transform ...` would
    // leave the height out - the detent would then snap while the transform
    // still holds the pull, and the sheet visibly jumps before it settles.
    const settle = () => {
      grip(el, false)
      el.style.transition = ''
      el.style.transform = ''
    }
    // The detent flips on the element first, so the height and the transform
    // start moving in the same frame; React's commit writes the same value.
    const detent = (on: boolean) => {
      el.toggleAttribute('data-expanded', on)
      ;(on ? live.current.onExpand : live.current.onCollapse)?.()
    }
    // A lift: the full height once it is nearer - the block slides the rest
    // of the way up - or back down by the offset and only then the opening
    // height again, out of sight. A long pull down from it still dismisses.
    const base = lifted.current
    if (base && !far) {
      lifted.current = 0
      if (-to >= half) {
        detent(true)
        settle()
        return
      }
      grip(el, false)
      el.style.transition = ''
      el.style.transform = `translate3d(0, ${base}px, 0)`
      const down = () => {
        el.removeEventListener('transitionend', down)
        clearTimeout(timer)
        lifted.current = base
        unlift(el)
      }
      const timer = setTimeout(down, reducedMotion() ? 0 : 400)
      el.addEventListener('transitionend', down)
      return
    }
    lifted.current = 0
    // a throw up from the opening height: the full height, once it is nearer
    if (to < 0) {
      if (!isExpanded && expand && -to >= half) detent(true)
      settle()
      return
    }
    // From the full height a pull down is a step back to the opening height,
    // not a dismissal: the sheet the user grew is not the sheet they meant to
    // throw away, and the second pull from there does dismiss it. One long
    // pull that carries the sheet past the opening height and a dismissal's
    // distance beyond it is both pulls in one; where the height difference
    // could not be measured the sheet steps back rather than guess.
    const past = span > 0 && to >= span + Math.max((el.clientHeight - span) * CLOSE_FRACTION, CLOSE_MIN)
    if (isExpanded && collapse && !past) {
      if (to >= half) detent(false)
      settle()
      return
    }
    if (far) {
      if (!guard || (await guard())) {
        // the backdrop fades with the slide, not after it
        grip(el, false)
        el.style.setProperty('--sheet-pull', '1')
        // thrown: carry on at the finger's speed; let go at rest: ease in
        const thrown = v > 0 ? throwMs(Math.max(0, el.clientHeight - dy), v) : null
        const ms = thrown ?? CLOSE_MS
        el.style.transition = reducedMotion()
          ? 'none'
          : thrown
            ? `transform ${thrown}ms ${EASE_THROW}`
            : `transform ${CLOSE_MS}ms var(--ease-in)`
        el.style.transform = 'translateY(100%)'
        const done = () => {
          el.removeEventListener('transitionend', done)
          clearTimeout(timer)
          close()
        }
        const timer = setTimeout(done, ms + 100)
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
    // 'none' = undecided, 'sheet' = ours to drag, 'scroll' = not ours for the
    // rest of the gesture (sideways, or a flick's momentum), 'content' = the
    // content scrolls vertically - until it reaches its top under a finger
    // still moving down. Then the same movement carries on as the pull, the
    // way a native sheet hands over: scroll up to the top and keep going, and
    // the sheet comes down without lifting the finger.
    let mode: 'none' | 'sheet' | 'scroll' | 'content' = 'none'
    let content: HTMLElement | null = null
    let lastY = 0
    let startX = 0
    let startY = 0
    let vel = startVelocity(0)
    let room = 0
    let from: Element | null = null
    let frozen: HTMLElement | null = null

    const reset = () => {
      if (frozen) frozen.style.overflow = ''
      frozen = null
      mode = 'none'
      content = null
      from = null
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return reset()
      const t = e.touches[0]
      const target = t.target as HTMLElement | null
      if (!target?.closest || target.closest(NO_DRAG)) return reset()
      mode = 'none'
      content = null
      startX = t.clientX
      startY = t.clientY
      lastY = t.clientY
      vel = startVelocity(t.clientY)
      from = target
    }

    const onMove = (e: TouchEvent) => {
      if (!from || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      const dx = e.touches[0].clientX - startX
      const down = y > lastY
      lastY = y
      if (mode === 'scroll') return
      if (mode === 'content') {
        if (!down || (content && content.scrollTop > 0)) return
        // the hand-over: the content is at its top and the finger goes on
        // down. The pull starts here, from where the finger is now.
        startY = y
        vel = startVelocity(y)
        mode = 'sheet'
        if (content) {
          frozen = content
          content.style.overflow = 'hidden'
        }
        room = begin(el, 1)
      }
      const dy = y - startY
      moveVelocity(vel, y)
      if (mode === 'none') {
        if (Math.abs(dy) < DECIDE && Math.abs(dx) < DECIDE) return
        // the axis lock: wider than tall is a sideways swipe, not a pull
        if (Math.abs(dx) > Math.abs(dy)) {
          mode = 'scroll'
          return
        }
        // a flick that just ended its momentum at the top of the content must
        // not turn into a dismissal
        if (performance.now() - lastScroll.current < SCROLL_LOCK_MS) {
          mode = 'scroll'
          return
        }
        const { el: scroller, atTop } = scrollerAtTop(from, el)
        if (dy > 0) {
          if (!atTop) {
            mode = 'content'
            content = scroller
            return
          }
        } else if (live.current.expanded || !live.current.onExpand) {
          // upward with no height left to take: the move belongs to the
          // content - and may come back down to the sheet
          mode = 'content'
          content = scroller
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
        room = begin(el, dy)
      }
      // ours: keep the browser from scrolling and follow the finger
      if (e.cancelable) e.preventDefault()
      follow(el, dy, room)
    }

    const onEnd = (e: TouchEvent) => {
      const claimed = mode === 'sheet'
      const y = e.changedTouches[0]?.clientY ?? startY
      reset()
      if (claimed) void finish(el, y - startY, releaseVelocity(vel, y), room)
    }

    const onCancel = () => {
      const claimed = mode === 'sheet'
      reset()
      // a lift goes back down the way it came; anything else just settles
      if (claimed && lifted.current) void finish(el, 0, 0, room)
      else if (claimed) {
        grip(el, false)
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
      if (lifted.current) return void (await finish(el, 0, 0, d.span))
      grip(el, false)
      el.style.transition = ''
      el.style.transform = ''
      return
    }
    await finish(el, e.clientY - d.y, releaseVelocity(d.vel, e.clientY), d.span)
  }

  return {
    onPointerDown: (e) => {
      if (!enabled || drag.current || e.pointerType === 'touch') return
      const el = sheet.current
      const target = e.target as HTMLElement | null
      if (!el || !target?.closest || target.closest(NO_DRAG)) return
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vel: startVelocity(e.clientY), from: target, on: false, frozen: null, span: 0 }
    },
    onPointerMove: (e) => {
      const d = drag.current
      const el = sheet.current
      if (!d || !el || e.pointerId !== d.id) return
      const dy = e.clientY - d.y
      moveVelocity(d.vel, e.clientY)
      if (!d.on) {
        if (Math.abs(dy) < SLOP && Math.abs(e.clientX - d.x) < SLOP) return
        // the axis lock, as on touch
        if (Math.abs(e.clientX - d.x) > Math.abs(dy)) return (drag.current = null) as null
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
        d.span = begin(el, dy)
      }
      follow(el, dy, d.span)
    },
    onPointerUp: (e) => void end(e, true),
    onPointerCancel: (e) => void end(e, false),
  }
}
