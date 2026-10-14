import { useEffect, useRef, useState, type ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface ToastRegionProps {
  children?: ReactNode
  /**
   * changes whenever a toast is raised: the region is shown again, so it
   * lands on top of a dialog or sheet that opened since
   */
  raise?: unknown
  className?: string
}

/**
 * Where toasts appear: a live region in the top layer (popover="manual"), so
 * a modal dialog or the side panel never covers it. It stays open while
 * empty, taking no room and letting every click through, so the live region
 * exists before its text. On a phone it sits above the tab bar, on a desktop
 * at the bottom right, left of an open side panel.
 */
export function ToastRegion({ children, raise, className }: ToastRegionProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el?.showPopover) return
    try {
      if (el.matches(':popover-open')) el.hidePopover()
      el.showPopover()
    } catch {
      /* not connected yet */
    }
  }, [raise])
  return (
    <div ref={ref} popover="manual" role="status" aria-live="polite" className={cx('t-toast-region', className)}>
      {children}
    </div>
  )
}

/**
 * How long a toast stays (WCAG 2.2.1, enough time): one second plus 300ms per
 * word, at least 6s, at least 8s when it offers an action (an undo has to be
 * read and reached), at most 10s.
 */
export function toastDuration(text: string, withAction = false): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const min = withAction ? 8000 : 6000
  return Math.min(10_000, Math.max(min, 1000 + 300 * words))
}

/** Whether the document is hidden (another tab, a minimised window). */
function useHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const on = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return hidden
}

export interface ToastProps {
  message: ReactNode
  /** a single action, e.g. undo */
  action?: { label: string; onClick: () => void }
  /**
   * how long it stays, in milliseconds (see toastDuration). With `onClose`
   * the toast keeps the time itself: a close button whose ring runs down,
   * paused while hovered, focused or the tab is hidden. Without, only a bar
   * runs out and the caller keeps the time.
   */
  duration?: number
  /** called when the time is up, on the close button and on Escape inside */
  onClose?: () => void
  /** the close button's name */
  closeLabel?: string
  className?: string
}

/** One toast: inverted colours, a line of text and at most one action. */
export function Toast({ message, action, duration, onClose, closeLabel = 'Close', className }: ToastProps) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const hidden = useHidden()
  const paused = hover || focus || hidden
  const timed = duration !== undefined && !!onClose
  // what is left of the time, kept across pauses
  const left = useRef(duration ?? 0)
  useEffect(() => {
    if (!timed || paused) return
    const start = performance.now()
    const id = setTimeout(() => onClose(), left.current)
    return () => {
      clearTimeout(id)
      left.current = Math.max(0, left.current - (performance.now() - start))
    }
  }, [timed, paused, onClose])
  return (
    <div
      className={cx('t-toast', className)}
      data-paused={timed && paused ? '' : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <span className="t-toast__text">{message}</span>
      {action && (
        <button type="button" className="t-toast__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onClose && (
        <button type="button" className="t-toast__close" aria-label={closeLabel} onClick={onClose}>
          {timed && <i aria-hidden className="t-toast__ring" style={{ animationDuration: `${duration}ms` }} />}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
      {duration !== undefined && !onClose && (
        <i aria-hidden className="t-toast__time" style={{ animationDuration: `${duration}ms` }} />
      )}
    </div>
  )
}
