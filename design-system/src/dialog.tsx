import { useEffect, useId, useRef, type ReactNode } from 'react'
import { SHEET_MQ, useMediaQuery } from './useMediaQuery'

// The native <dialog> mechanics WeebSync repeats in every modal: open it as a
// modal on mount, close on a backdrop click but not on a drag that merely ended
// there, and report the outcome once through the dialog's own close event so
// every exit path behaves the same.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// Widths small enough to stay a centred box on a phone. Anything wider - the
// watch editor, the remote browser - fills the screen instead, where a centred
// box would only be a thin margin around a full-height panel anyway.
const BOX_WIDTHS = new Set(['max-w-xs', 'max-w-sm', 'max-w-md'])

// a pull on a sheet's header: this many pixels before it counts as a drag at
// all, and this many before letting go closes the sheet
const DRAG_SLOP = 10
const DRAG_CLOSE = 120

export interface DialogProps {
  children: ReactNode
  /** fires once the dialog has actually closed, whatever closed it */
  onClose: () => void
  /** width utility for the dialog element, e.g. "max-w-md" */
  width?: string
  /** red corner brackets for a destructive decision */
  danger?: boolean
  /**
   * Asked before a backdrop click or Escape closes the dialog. Return false to
   * keep it open - the unsaved-changes guard. A promise is awaited.
   */
  onRequestClose?: () => boolean | Promise<boolean>
  /**
   * Full-screen sheet on phones instead of a centred box. Defaults to true for
   * anything wider than `max-w-md`; pass it explicitly to override.
   */
  sheet?: boolean
  /** accessible name for the sheet's close button */
  closeLabel?: string
  'aria-labelledby'?: string
  'aria-label'?: string
  className?: string
  /**
   * Extra classes for the box inside the dialog. A tall modal needs its own
   * scroll container - `dialog-body` here, `overflow-y-auto` on the section
   * that may grow - so the page behind never gains a scrollbar. `dialog-body`
   * also knows how to give up its height cap inside a full-screen sheet.
   */
  bodyClassName?: string
}

/**
 * A modal dialog on the native `<dialog>` element: top layer, Escape handling
 * and backdrop come from the platform, the reveal animation from the
 * stylesheet. Mount it to open it; the parent unmounts on `onClose`.
 */
export function Dialog({
  children,
  onClose,
  width = 'max-w-md',
  danger,
  onRequestClose,
  sheet,
  closeLabel = 'Schließen',
  className,
  bodyClassName,
  ...aria
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // pointerdown started on the backdrop - a drag that began inside a control
  // and ended on the backdrop must not count as a click outside
  const backdropDown = useRef(false)
  const asSheet = sheet ?? !BOX_WIDTHS.has(width.split(' ')[0])
  // Whether the sheet layout is in effect right now. A full-screen sheet has no
  // visible backdrop to click and so no way out except this button - both the
  // button and the backdrop handler key off the live match rather than the
  // prop, so dragging a desktop window across the breakpoint flips both.
  const narrow = useMediaQuery(SHEET_MQ)
  const isSheet = asSheet && narrow

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const guarded = async () => {
    if (onRequestClose && !(await onRequestClose())) return
    ref.current?.close()
  }
  const menuOpen = () => !!ref.current?.querySelector('[aria-haspopup][aria-expanded="true"]')

  // the pull-down on a phone sheet: where the pointer went down, and whether
  // it has moved far enough to count as a drag rather than a tap
  const drag = useRef<{ y: number; id: number; on: boolean } | null>(null)
  const endDrag = async (clientY?: number) => {
    const d = drag.current
    const el = ref.current
    drag.current = null
    if (!d || !d.on || !el) return
    const far = clientY !== undefined && clientY - d.y > DRAG_CLOSE
    if (far && (!onRequestClose || (await onRequestClose()))) {
      // slide the rest of the way out, then close for real
      el.style.transition = 'transform var(--dur-2) var(--ease-in)'
      el.style.transform = 'translateY(100%)'
      const done = () => {
        el.removeEventListener('transitionend', done)
        el.close()
      }
      el.addEventListener('transitionend', done)
      setTimeout(done, 250)
      return
    }
    // too short, or the guard said no: the stylesheet's own transition
    // settles it back into place
    el.style.transition = ''
    el.style.transform = ''
  }

  // The back gesture closes the dialog instead of leaving the page: every
  // dialog pushes one history entry while it is open, and popping it - the
  // browser's back button, the swipe from the edge on Android - closes the
  // dialog. React Router keeps `usr`, `key` and `idx` in the state, so the
  // entry copies them and bumps `idx` rather than replacing the object.
  // Nested dialogs each hold an entry; back pops the innermost, the outer
  // one still finds its own mark and stays.
  const id = useId()
  const onRequestCloseRef = useRef(onRequestClose)
  onRequestCloseRef.current = onRequestClose
  useEffect(() => {
    if (typeof history === 'undefined') return
    // StrictMode mounts, unmounts and mounts again: the entry from the first
    // pass is still on top, so it is reused rather than pushed twice, and the
    // back() the first cleanup queued is cancelled below before it runs.
    // Chrome resolves history.back() against the entry current at the call,
    // so a back followed by a push would still pop the page's own entry and
    // close the dialog the moment it opened.
    clearTimeout(pendingBack.current)
    const mark = history.state?.wsDialog === id ? history.state : { ...history.state, idx: (history.state?.idx ?? 0) + 1, wsDialog: id }
    if (history.state !== mark) history.pushState(mark, '')
    const onPop = async () => {
      if (history.state?.wsDialog === id) return // an inner dialog's entry went, not ours
      // the guard declined (unsaved changes): put the entry back
      if (onRequestCloseRef.current && !(await onRequestCloseRef.current())) return history.pushState(mark, '')
      ref.current?.close()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // closed, saved or unmounted by its owner while its entry is still on
      // top: take it with us, or the next back is a no-op. After a route
      // change the top entry is the new page's and stays.
      // ponytail: a navigate({replace:true}) while a dialog is open wipes the
      // mark and leaves one dead entry behind - one wasted back, never a leave
      pendingBack.current = setTimeout(() => {
        if (history.state?.wsDialog === id) history.back()
      })
    }
  }, [id])
  const pendingBack = useRef<ReturnType<typeof setTimeout>>(undefined)

  return (
    <dialog
      ref={ref}
      {...aria}
      className={cx('w-full p-0', width, asSheet && 'dialog-sheet', className)}
      // close and cancel do not bubble natively, but React walks them up its own
      // tree - so a dialog opened from inside another one would close both, past
      // the outer guard and its unsaved changes. Only own events count.
      onClose={(e) => e.target === ref.current && onClose()}
      onCancel={(e) => {
        if (e.target !== ref.current) return
        // the platform's own Escape: an open menu keeps the dialog (see
        // onKeyDown), and a guard gets asked before it goes
        if (menuOpen()) return e.preventDefault()
        if (!onRequestClose) return
        e.preventDefault() // Escape goes through the same guard
        void guarded()
      }}
      // Firefox does not fire `cancel` when Escape is pressed while a text
      // field inside the dialog has focus: the field claims the key for its own
      // revert-the-value behaviour and marks the event handled. The watch
      // dialog autofocuses a field, so Escape did nothing there at all. Closing
      // from keydown works in every browser - and it deliberately does not skip
      // an already-handled event, because "handled" is exactly what Firefox
      // says here. `preventDefault` keeps the browsers that would also fire
      // `cancel` from running the guard a second time.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // a dialog opened from inside another one: only the top one closes
        if ((e.target as HTMLElement).closest('dialog') !== ref.current) return
        // an open menu inside the dialog owns Escape: it closes, the dialog
        // stays. Looked up in the dialog, not up from the target: on touch the
        // trigger never takes focus, so the key lands on the dialog itself.
        // `aria-haspopup` keeps an expanded disclosure (a folder browser) out
        // of it - those must not swallow Escape.
        // `preventDefault` here as well: Chrome closes the dialog from the
        // keydown's default action (its close watcher) unless the key is
        // cancelled, and the menu's own listener still sees the key.
        if (menuOpen()) return e.preventDefault()
        e.preventDefault()
        void guarded()
      }}
      onPointerDown={(e) => {
        backdropDown.current = e.target === ref.current
        // a pull on the sheet's header starts a drag - the banner, title and
        // tabs are the part that never scrolls, so a downward move there can
        // only mean "close". The stylesheet gives the header touch-action:
        // pan-x, or the browser would cancel the pointer for its own pan.
        // ponytail: drag zone is the <header>; pulling a scrolled-to-top panel
        // down needs touch-action juggling on the scroller, not worth it
        const el = e.target as HTMLElement
        if (isSheet && el.closest('dialog') === ref.current && el.closest('header')) {
          drag.current = { y: e.clientY, id: e.pointerId, on: false }
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        const el = ref.current
        if (!d || !el || e.pointerId !== d.id) return
        const dy = e.clientY - d.y
        if (!d.on) {
          if (dy < DRAG_SLOP) return
          d.on = true
          // from here on the pointer is ours: a tab under the finger must not
          // get the click when the pull ends
          try {
            el.setPointerCapture(e.pointerId)
          } catch {
            /* a synthetic pointer id, or jsdom */
          }
          el.style.transition = 'none'
        }
        el.style.transform = `translateY(${Math.max(0, dy)}px)`
      }}
      onPointerUp={(e) => void endDrag(e.clientY)}
      onPointerCancel={() => void endDrag()}
      onClick={(e) => {
        if (isSheet) return // no backdrop to click - the button is the way out
        if (e.target === ref.current && backdropDown.current) void guarded()
      }}
    >
      {isSheet && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={() => void guarded()}
          // the sheet scrolls under this button, and a banner image or a line
          // of text behind a bare glyph makes it unreadable - it carries its
          // own surface
          className="absolute top-1 right-1 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-bg-card/90 text-t-muted hover:text-t-primary"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
      {/* The dialog element itself must not scroll (fractional border height
          conjures a phantom scrollbar), so this box is the scroll container of
          last resort: content taller than the dialog would otherwise be clipped
          with no way to reach it. Modals that scroll a section of their own
          (`dialog-body`) never reach this overflow. */}
      <div className={cx('flex flex-col overflow-y-auto', danger && 't-panel--danger', bodyClassName)}>
        {children}
      </div>
    </dialog>
  )
}
