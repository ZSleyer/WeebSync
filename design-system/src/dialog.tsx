import { useEffect, useRef, useState, type ReactNode } from 'react'

// The native <dialog> mechanics WeebSync repeats in every modal: open it as a
// modal on mount, close on a backdrop click but not on a drag that merely ended
// there, and report the outcome once through the dialog's own close event so
// every exit path behaves the same.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// The width below which a sheet-sized dialog covers the screen. Must match the
// `dialog.dialog-sheet` media query in the stylesheet.
const SHEET_MQ = '(max-width: 40rem)'

// Widths small enough to stay a centred box on a phone. Anything wider - the
// watch editor, the remote browser - fills the screen instead, where a centred
// box would only be a thin margin around a full-height panel anyway.
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
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia(SHEET_MQ).matches,
  )
  const isSheet = asSheet && narrow

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(SHEET_MQ)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const guarded = async () => {
    if (onRequestClose && !(await onRequestClose())) return
    ref.current?.close()
  }

  return (
    <dialog
      ref={ref}
      {...aria}
      className={cx('w-full p-0', width, asSheet && 'dialog-sheet', className)}
      onClose={onClose}
      onCancel={
        onRequestClose
          ? (e) => {
              e.preventDefault() // Escape goes through the same guard
              void guarded()
            }
          : undefined
      }
      onPointerDown={(e) => (backdropDown.current = e.target === ref.current)}
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
          className="absolute top-1 right-1 z-10 flex h-11 w-11 items-center justify-center bg-bg-card/90 text-t-muted hover:text-t-primary"
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
      {/* overflow-x-hidden is not redundant beside overflow-y-auto: a box that
          scrolls in one axis computes the other to auto, so a body a couple of
          pixels too wide - a chip row, a long slug, a font whose metrics differ
          from the one it was measured against - lets the reader drag the whole
          sheet sideways. A dialog never scrolls horizontally. */}
      <div className={cx('flex flex-col overflow-y-auto overflow-x-hidden', danger && 't-panel--danger', bodyClassName)}>
        {children}
      </div>
    </dialog>
  )
}
