import { useEffect, useRef, type ReactNode } from 'react'

// The native <dialog> mechanics WeebSync repeats in every modal: open it as a
// modal on mount, close on a backdrop click but not on a drag that merely ended
// there, and report the outcome once through the dialog's own close event so
// every exit path behaves the same.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

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
  'aria-labelledby'?: string
  'aria-label'?: string
  className?: string
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
  className,
  ...aria
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // pointerdown started on the backdrop - a drag that began inside a control
  // and ended on the backdrop must not count as a click outside
  const backdropDown = useRef(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const guarded = async () => {
    if (onRequestClose && !(await onRequestClose())) return
    ref.current?.close()
  }

  return (
    <dialog
      ref={ref}
      {...aria}
      className={cx('w-full p-0', width, className)}
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
        if (e.target === ref.current && backdropDown.current) void guarded()
      }}
    >
      <div className={cx('flex flex-col', danger && 't-panel--danger')}>{children}</div>
    </dialog>
  )
}
