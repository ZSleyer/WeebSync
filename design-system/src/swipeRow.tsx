import { useEffect, useRef, type ReactNode } from 'react'
import { EASE_THROW } from './gesture'
import { haptic } from './haptics'
import { commitDistance, useSwipe } from './useSwipe'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SwipeAction {
  /** what the action does, shown on the ground the swipe uncovers */
  label: string
  icon?: ReactNode
  tone?: 'accent' | 'ok' | 'warn' | 'err'
  /** the row goes away with it (cancel, remove): it slides out instead of back */
  leaves?: boolean
  run: () => void
}

export interface SwipeRowProps {
  /** uncovered by a swipe to the right */
  start?: SwipeAction
  /** uncovered by a swipe to the left */
  end?: SwipeAction
  children: ReactNode
  className?: string
}

// a row that slid out but is still here a while later was not removed after
// all (the action failed, or the list kept it): it comes back
const RETURN_MS = 1500

/**
 * A list row with an action under each side, like a mail app's: swipe it
 * sideways and the ground beneath says what letting go will do; past the
 * commit distance the ground turns solid and the phone ticks, and letting go
 * runs it. Short of that the row springs back. Touch only - a mouse drag on a
 * row selects text, and the same actions are buttons on the row anyway (WCAG
 * 2.5.7). Built on useSwipe's deck mode, so it is one zone among the others:
 * a direction the row has no action for falls through to the page swipe.
 */
export function SwipeRow({ start, end, children, className }: SwipeRowProps) {
  const root = useRef<HTMLDivElement>(null)
  const face = useRef<HTMLDivElement>(null)
  const back = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(back.current), [])

  const reset = (animate: boolean) => {
    const el = face.current
    if (!el) return
    el.style.transition = animate ? `transform 280ms ${EASE_THROW}` : 'none'
    el.style.transform = ''
    delete root.current?.dataset.side
    root.current?.removeAttribute('data-armed')
  }
  const drag = (dx: number | null) => {
    const el = face.current
    const r = root.current
    if (!el || !r) return
    if (dx === null) return reset(true)
    el.style.transition = 'none'
    el.style.transform = dx ? `translateX(${dx}px)` : ''
    if (dx) r.dataset.side = dx > 0 ? 'start' : 'end'
    const armed = Math.abs(dx) >= commitDistance(r.clientWidth)
    if (armed !== r.hasAttribute('data-armed')) {
      r.toggleAttribute('data-armed', armed)
      if (armed) haptic(8)
    }
  }
  const commit = (a: SwipeAction, dir: 1 | -1) => {
    const el = face.current
    if (el && a.leaves) {
      el.style.transition = `transform var(--dur-2) ${EASE_THROW}`
      el.style.transform = `translateX(${dir * 105}%)`
      clearTimeout(back.current)
      back.current = setTimeout(() => reset(true), RETURN_MS)
    } else reset(true)
    a.run()
  }
  const swipe = useSwipe({
    onPrev: start ? () => commit(start, 1) : undefined,
    onNext: end ? () => commit(end, -1) : undefined,
    onDrag: drag,
  })

  return (
    <div ref={root} className={cx('t-swiperow', className)}>
      {start && (
        <div aria-hidden className="t-swiperow__ground t-swiperow__ground--start" data-tone={start.tone}>
          {start.icon}
          <span>{start.label}</span>
        </div>
      )}
      {end && (
        <div aria-hidden className="t-swiperow__ground t-swiperow__ground--end" data-tone={end.tone}>
          <span>{end.label}</span>
          {end.icon}
        </div>
      )}
      <div ref={face} {...swipe} className="t-swiperow__face">
        {children}
      </div>
    </div>
  )
}
