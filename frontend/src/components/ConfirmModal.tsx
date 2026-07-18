import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

// Custom confirmation modal on the native <dialog> (same look/behaviour as
// WatchDialog): CRT reveal, backdrop-click and Escape both cancel. The decision
// is read on the dialog's close event so the exit stays consistent with the
// rest of the app. Controlled: the parent unmounts it after onConfirm/onCancel.
export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const confirmed = useRef(false)
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not a drag out of a button
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const close = (ok: boolean) => {
    confirmed.current = ok
    ref.current?.close()
  }
  return (
    <dialog
      ref={ref}
      className="w-full max-w-md p-0"
      aria-labelledby="confirm-title"
      onClose={() => (confirmed.current ? onConfirm() : onCancel())}
      onPointerDown={(e) => (backdropDown.current = e.target === ref.current)}
      onClick={(e) => e.target === ref.current && backdropDown.current && close(false)}
    >
      <div className={`flex flex-col ${destructive ? 't-panel--danger' : ''}`}>
        <header className="flex items-center gap-2 border-b border-border-subtle px-5 py-4">
          {destructive && (
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0 text-err">
              <path
                d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <h3 id="confirm-title" className="font-display font-semibold tracking-wider">
            {title ?? t('common.confirmTitle')}
          </h3>
        </header>
        <div className="px-5 py-4 text-sm text-t-secondary">{message}</div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className="t-btn" onClick={() => close(false)} autoFocus>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={`t-btn t-cut ${destructive ? 't-btn--danger' : 't-btn--primary'}`}
            onClick={() => close(true)}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
