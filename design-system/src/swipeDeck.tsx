import { useRef, useState, type ReactNode } from 'react'
import { useSwipe } from './useSwipe'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SwipeDeckProps {
  /** which page is on screen; any integer the caller can map to content */
  index: number
  /** the swipe has carried the deck to this index */
  onIndex: (index: number) => void
  /** false stops the deck at that end - no neighbour, no page turn */
  canPrev?: boolean
  canNext?: boolean
  /** also page on a held mouse button */
  mouse?: boolean
  /**
   * how far one page turn moves the index. A grid that shows seven days
   * around a picked one pages a week at a time while its index counts days.
   */
  step?: number
  className?: string
  /** the content of one page. Called for the neighbours only while swiping. */
  children: (index: number) => ReactNode
}

/**
 * A swipe that runs without a seam: the next page is already beside the
 * current one and travels with the finger, so paging reads as one continuous
 * surface rather than a jump. The neighbours are mounted only while a gesture
 * is live, and the deck holds no transform when it is idle - a transform that
 * stayed would pin every `position: fixed` descendant to the deck.
 *
 * For content that is cheap to render for a neighbouring index. A page whose
 * content fetches on mount does not belong in a deck.
 */
export function SwipeDeck({ index, onIndex, canPrev = true, canNext = true, mouse, step = 1, className, children }: SwipeDeckProps) {
  const box = useRef<HTMLDivElement>(null)
  // how far the deck is pushed right now; null is the resting state and the
  // only one without a transform - a transform that stayed would pin every
  // `position: fixed` descendant to the deck
  const [offset, setOffset] = useState<number | null>(null)
  // whether the deck is travelling on its own rather than under the finger
  const [anim, setAnim] = useState(false)
  // the page turn in flight, kept in a ref as well so the landing runs once
  // whether it was the transition or the fallback timer that got there first
  const [going, setGoing] = useState<-1 | 1 | null>(null)
  const flight = useRef<-1 | 1 | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // the fallback timer keeps the closure it was given, so the landing reads the
  // index from here - a parent that re-renders mid-slide (the calendar ticks
  // every second) would otherwise land on the index from before the flight
  const idx = useRef(index)
  idx.current = index

  const rest = () => {
    clearTimeout(timer.current)
    flight.current = null
    setGoing(null)
    setAnim(false)
    setOffset(null)
  }
  const land = () => {
    const dir = flight.current
    if (dir === null) return rest()
    rest()
    onIndex(idx.current + dir * step)
  }
  // transitionend can be missed - a reduced-motion setting cuts the duration to
  // nothing, a hidden tab never paints - and a deck stuck mid-slide is worse
  // than one that lands early
  const fly = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(land, 400)
  }
  const arrive = (dir: -1 | 1) => {
    flight.current = dir
    setGoing(dir)
    setAnim(true)
    setOffset(-dir * (box.current?.clientWidth ?? 0))
    fly()
  }

  const swipe = useSwipe({
    mouse,
    onPrev: canPrev ? () => arrive(-1) : undefined,
    onNext: canNext ? () => arrive(1) : undefined,
    onDrag: (dx) => {
      if (dx !== null) {
        setAnim(false)
        setOffset(dx)
        return
      }
      // let go without turning a page: slide home. Already home means no
      // transition will fire, so the deck has to clear itself.
      if (offset === null || offset === 0) return rest()
      setAnim(true)
      setOffset(0)
      fly()
    },
  })

  const live = offset !== null
  return (
    <div
      {...swipe}
      ref={box}
      className={cx('relative', className)}
      // the neighbours sit one width out on either side; without this they
      // would paint over whatever the page puts beside the deck
      style={{ ...swipe.style, ...(live ? { overflowX: 'clip' } : null) }}
    >
      <div
        className="relative"
        style={{
          transform: live ? `translateX(${offset}px)` : undefined,
          transition: anim ? 'transform var(--dur-2) var(--ease-out)' : 'none',
        }}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || !anim) return
          if (going !== null) land()
          else rest()
        }}
      >
        {live && canPrev && <div className="absolute top-0 right-full w-full">{children(index - step)}</div>}
        {children(index)}
        {live && canNext && <div className="absolute top-0 left-full w-full">{children(index + step)}</div>}
      </div>
    </div>
  )
}
