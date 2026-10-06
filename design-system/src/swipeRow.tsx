import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { EASE_THROW } from './gesture'
import { haptic } from './haptics'
import { useSwipe } from './useSwipe'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SwipeAction {
  key: string
  label: string
  icon?: ReactNode
  tone?: 'accent' | 'ok' | 'warn' | 'err'
  run: () => void
}

export interface SwipeRowProps {
  /** buttons uncovered by a swipe to the right, outermost first */
  start?: SwipeAction[]
  /** buttons uncovered by a swipe to the left, outermost first */
  end?: SwipeAction[]
  children: ReactNode
  /** the root element: an li inside a list */
  as?: 'div' | 'li'
  className?: string
}

// the row that stands open, if any: opening another one closes it first
let closeOpen: (() => void) | null = null

const SETTLE = `transform var(--dur-2) ${EASE_THROW}`

/**
 * A list row with buttons under each side, the way a mail app does it: swipe
 * the row sideways and it stays open on its buttons; a tap on one runs it.
 * Nothing runs from the swipe alone, so there is nothing to confirm - the tap
 * on "Cancel" is the decision. Where the row comes to rest decides, not how
 * fast it was thrown: past half the buttons it opens, short of that it closes.
 *
 * One row is open at a time. A tap anywhere else, a tap on the row itself (it
 * closes instead of acting) or a scroll closes it. Touch only - a mouse drag
 * on a row selects text - and every action has to stay reachable without the
 * gesture, through the row's own buttons or its ⋯ menu (WCAG 2.5.7).
 *
 * Built on useSwipe's deck mode, so it is one zone among the others and the
 * direction lock, the slop and the click suppression come from there.
 */
export function SwipeRow({ start = [], end = [], children, as: Tag = 'div', className }: SwipeRowProps) {
  const root = useRef<HTMLElement>(null)
  const face = useRef<HTMLDivElement>(null)
  const startGround = useRef<HTMLDivElement>(null)
  const endGround = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<'start' | 'end' | null>(null)
  // where the row rests: 0 closed, + open on the start side, - on the end side
  const base = useRef(0)
  const pos = useRef(0)
  // a tap on an open row closes it, and the click that tap makes is not one
  const swallow = useRef(false)

  const width = (side: 'start' | 'end') => (side === 'start' ? startGround : endGround).current?.offsetWidth ?? 0
  const place = (x: number, animate: boolean) => {
    const el = face.current
    const r = root.current
    if (!el || !r) return
    pos.current = x
    el.style.transition = animate ? SETTLE : 'none'
    el.style.transform = x ? `translateX(${x}px)` : ''
    if (x > 0) r.dataset.side = 'start'
    else if (x < 0) r.dataset.side = 'end'
    else if (animate) {
      // the ground stays until the row has covered it again
      setTimeout(() => pos.current === 0 && delete r.dataset.side, 200)
    } else delete r.dataset.side
  }
  const close = () => {
    base.current = 0
    place(0, true)
    setOpen(null)
    if (closeOpen === close) closeOpen = null
  }
  const openOn = (side: 'start' | 'end') => {
    if (closeOpen && closeOpen !== close) closeOpen()
    closeOpen = close
    base.current = side === 'start' ? width('start') : -width('end')
    place(base.current, true)
    if (open !== side) haptic(8)
    setOpen(side)
  }

  // follow the finger from where the row rests; past the buttons it resists
  const drag = (dx: number | null) => {
    if (dx === null) return settle()
    let x = base.current + dx
    const max = start.length ? width('start') : 0
    const min = end.length ? -width('end') : 0
    if (x > max) x = max + (x - max) / 3
    if (x < min) x = min + (x - min) / 3
    place(x, false)
  }
  // where it was let go decides: past half the buttons it opens on them
  const settle = () => {
    const x = pos.current
    if (x > 0 && start.length && x > width('start') / 2) openOn('start')
    else if (x < 0 && end.length && -x > width('end') / 2) openOn('end')
    else close()
  }
  const swipe = useSwipe({
    // both directions belong to the row while it has something that way, or
    // while it stands open and the swipe would close it
    onPrev: start.length || base.current < 0 ? settle : undefined,
    onNext: end.length || base.current > 0 ? settle : undefined,
    onDrag: drag,
  })

  // an open row closes on a tap anywhere but its buttons, and on a scroll
  useEffect(() => {
    if (!open) return
    const ground = (open === 'start' ? startGround : endGround).current
    const onDown = (e: Event) => {
      const t = e.target as Node
      if (ground?.contains(t)) return
      // a tap on the row itself only closes it; its click is swallowed below
      if (face.current?.contains(t)) {
        swallow.current = true
        // only this touch's click: a touch that turns into a scroll has none,
        // and the next real tap must not be eaten
        const clear = () => {
          setTimeout(() => (swallow.current = false), 0)
          document.removeEventListener('pointerup', clear, true)
          document.removeEventListener('pointercancel', clear, true)
        }
        document.addEventListener('pointerup', clear, true)
        document.addEventListener('pointercancel', clear, true)
      }
      close()
    }
    const onScroll = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
    }
    // close is stable enough: it only touches refs and the setter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => () => {
    if (closeOpen === close) closeOpen = null
  })

  const buttons = (side: 'start' | 'end', list: SwipeAction[], ref: RefObject<HTMLDivElement | null>) =>
    list.length > 0 && (
      <div
        ref={ref}
        className={`t-swiperow__ground t-swiperow__ground--${side}`}
        // reachable only while uncovered; the row's own buttons and ⋯ menu
        // are the way in otherwise
        inert={open !== side}
      >
        {list.map((a) => (
          <button
            key={a.key}
            type="button"
            className="t-swiperow__action"
            data-tone={a.tone}
            onClick={() => {
              close()
              a.run()
            }}
          >
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    )

  return (
    <Tag ref={root as RefObject<HTMLDivElement & HTMLLIElement>} className={cx('t-swiperow', className)}>
      {buttons('start', start, startGround)}
      {buttons('end', end, endGround)}
      <div
        ref={face}
        {...swipe}
        className="t-swiperow__face"
        onClickCapture={(e) => {
          if (swallow.current) {
            swallow.current = false
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      >
        {children}
      </div>
    </Tag>
  )
}
