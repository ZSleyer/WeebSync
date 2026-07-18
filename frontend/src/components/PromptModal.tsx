import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface PromptOptions {
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

// Text-input modal on the native <dialog> (same look as ConfirmModal), replacing
// window.prompt(). Resolves the entered string, or null on cancel/backdrop/Escape.
export default function PromptModal({
  title,
  message,
  defaultValue,
  placeholder,
  confirmLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: PromptOptions & { onSubmit: (value: string) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const submitted = useRef<string | null>(null)
  const backdropDown = useRef(false)
  const [value, setValue] = useState(defaultValue ?? '')
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const close = (v: string | null) => {
    submitted.current = v
    ref.current?.close()
  }
  return (
    <dialog
      ref={ref}
      className="w-full max-w-md p-0"
      aria-labelledby={titleId}
      onClose={() => (submitted.current !== null ? onSubmit(submitted.current) : onCancel())}
      onCancel={(e) => {
        e.preventDefault()
        close(null)
      }}
      onPointerDown={(e) => (backdropDown.current = e.target === ref.current)}
      onClick={(e) => e.target === ref.current && backdropDown.current && close(null)}
    >
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          close(value)
        }}
      >
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 id={titleId} className="font-display font-semibold tracking-wider">
            {title}
          </h3>
        </header>
        <div className="px-5 py-4">
          {message && <p className="mb-2 text-sm text-t-secondary">{message}</p>}
          <input
            className="t-input"
            autoFocus
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className="t-btn" onClick={() => close(null)}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button type="submit" className="t-btn t-btn--primary t-cut">
            {confirmLabel ?? t('common.confirm')}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
