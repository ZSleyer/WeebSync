import { useEffect, useRef, type ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SidePanelProps {
  children: ReactNode
  /** Escape inside the panel; the owner decides and unmounts it */
  onRequestClose: () => void
  /**
   * Where focus goes when the panel closes while it holds focus. Defaults to
   * whatever had focus when it opened; an owner that swaps the content for
   * another opener's points it at the latest one.
   */
  returnFocus?: { current: HTMLElement | null }
  'aria-label'?: string
  'aria-labelledby'?: string
  className?: string
}

/**
 * A panel docked beside the page on a wide screen, for a detail the user
 * reads next to the list it came from. Non-modal: no scrim, the page stays
 * interactive and focusable, so the next item can be picked while it is
 * open. A named dialog with aria-modal false; focus moves in when it opens
 * and back to the opener when it closes, and Escape closes it while focus is
 * inside - unless an open menu in it claims the key. Mount it to open it.
 */
export function SidePanel({ children, onRequestClose, returnFocus, className, ...aria }: SidePanelProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    const opener = document.activeElement as HTMLElement | null
    el?.focus({ preventScroll: true })
    return () => {
      // only when the panel had focus: a click on the page that closed it
      // has already put focus where the user wants it
      const now = document.activeElement
      if (now && now !== document.body && !el?.contains(now)) return
      const back = returnFocus?.current ?? opener
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="false"
      tabIndex={-1}
      {...aria}
      className={cx('t-sidepanel outline-none', className)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        // a modal opened from inside answers its own Escape
        if ((e.target as HTMLElement).closest('dialog')) return
        // an open menu owns Escape, as in Dialog
        if (ref.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return
        e.preventDefault()
        onRequestClose()
      }}
    >
      {children}
    </section>
  )
}
