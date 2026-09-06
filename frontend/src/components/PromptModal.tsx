import { Check, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Input } from '@weebsync/design-system'

export interface PromptOptions {
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

// Text-input modal on the design system's Dialog (same mechanics as every
// other modal, including the Firefox Escape path), replacing window.prompt().
// Resolves the entered string, or null on cancel, backdrop or Escape.
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
  const titleId = useId()
  // the decision is taken by a button, but reported once through the
  // dialog's own close event, whatever closed it
  const submitted = useRef<string | null>(null)
  const dialog = useRef<HTMLDialogElement | null>(null)
  const [value, setValue] = useState(defaultValue ?? '')
  const close = (v: string | null) => {
    submitted.current = v
    dialog.current?.close()
  }
  return (
    <Dialog
      width="max-w-md"
      aria-labelledby={titleId}
      onClose={() => (submitted.current !== null ? onSubmit(submitted.current) : onCancel())}
    >
      <form
        className="flex flex-col"
        ref={(el) => {
          dialog.current = el?.closest('dialog') ?? null
        }}
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
          <Input autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button onClick={() => close(null)}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" cut>
            <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
