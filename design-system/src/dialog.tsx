import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { SHEET_MQ, useMediaQuery } from './useMediaQuery'
import { useSheetDrag } from './useSheetDrag'

// The native <dialog> mechanics WeebSync repeats in every modal: open it as a
// modal on mount, close on a backdrop click but not on a drag that merely ended
// there, and report the outcome once through the dialog's own close event so
// every exit path behaves the same.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// Widths small enough to stay a centred box on a phone. Anything wider - the
// watch editor, the remote browser - becomes a bottom sheet instead, where a
// centred box would only be a thin margin around a full-height panel anyway.
const BOX_WIDTHS = new Set(['max-w-xs', 'max-w-sm', 'max-w-md'])

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
   * Bottom sheet on phones instead of a centred box: it rises from the bottom
   * edge, stops short of the top so the page behind stays visible, and is
   * dismissed by pulling it down. Defaults to true for anything wider than
   * `max-w-md`; pass it explicitly to override.
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
   * also knows how to give up its height cap inside a bottom sheet.
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
  // Whether the sheet layout is in effect right now, read from the live match
  // rather than the prop so dragging a desktop window across the breakpoint
  // flips the grabber and the pull gesture with it.
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

  // A sheet opens at a height that suits a form. The first scroll inside it is
  // the content saying that height was not enough, so the sheet takes the rest
  // of the screen and the reader carries on in the same movement. It stops
  // short of the top either way - that strip of page is the backdrop they tap
  // to get out - and it never shrinks back on its own: a box that resizes
  // under the thumb while somebody reads is worse than one that stayed small.
  // `scroll` does not bubble, so this listens in the capture phase and hears
  // whichever box inside the sheet actually scrolls.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || !isSheet || expanded) return
    const onScroll = (e: Event) => {
      if ((e.target as HTMLElement).scrollTop > 0) setExpanded(true)
    }
    el.addEventListener('scroll', onScroll, true)
    return () => el.removeEventListener('scroll', onScroll, true)
  }, [isSheet, expanded])

  // the pull-down, from anywhere on the sheet's face - see useSheetDrag for
  // how it hands the vertical axis back and forth with the scrolling content
  const sheetDrag = useSheetDrag({
    sheet: ref,
    enabled: isSheet,
    onRequestClose,
    onClose: () => ref.current?.close(),
  })

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
      data-expanded={isSheet && expanded ? '' : undefined}
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
        // a press on the backdrop is never a sheet pull: the sheet element is
        // the box, and the area around it belongs to the dialog itself
        backdropDown.current = e.target === ref.current
        if (!backdropDown.current) sheetDrag.onPointerDown(e)
      }}
      onPointerMove={sheetDrag.onPointerMove}
      onPointerUp={(e) => sheetDrag.onPointerUp(e)}
      onPointerCancel={sheetDrag.onPointerCancel}
      onClick={(e) => {
        if (e.target === ref.current && backdropDown.current) void guarded()
      }}
    >
      {isSheet && (
        // The sheet's grabber: the drag affordance, and a plain button so the
        // pull has a single-tap alternative (WCAG 2.2 SC 2.5.1 / 2.5.7). The
        // pill is M3's 32x4; the hit area around it is 44px tall, because a
        // 4px target fails SC 2.5.8.
        <button
          type="button"
          aria-label={closeLabel}
          onClick={() => void guarded()}
          className="grid h-11 w-full shrink-0 place-items-center"
        >
          <span aria-hidden="true" className="h-1 w-8 rounded-full bg-t-muted/60" />
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
