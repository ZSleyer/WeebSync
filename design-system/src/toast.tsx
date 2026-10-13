import { useEffect, useRef, type ReactNode } from 'react'

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

export interface ToastProps {
  message: ReactNode
  /** a single action, e.g. undo */
  action?: { label: string; onClick: () => void }
  /** shows a bar that runs out over this many milliseconds */
  duration?: number
  className?: string
}

/** One toast: inverted colours, a line of text and at most one action. */
export function Toast({ message, action, duration, className }: ToastProps) {
  return (
    <div className={cx('t-toast', className)}>
      <span className="t-toast__text">{message}</span>
      {action && (
        <button type="button" className="t-toast__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {duration !== undefined && <i aria-hidden className="t-toast__time" style={{ animationDuration: `${duration}ms` }} />}
    </div>
  )
}
