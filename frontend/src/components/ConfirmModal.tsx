import { Check, Trash2, X } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '@weebsync/design-system'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

// Custom confirmation modal on the design system's <Dialog> (same mechanics as
// every other modal): CRT reveal, backdrop-click and Escape both cancel.
// Controlled: the parent unmounts it after onConfirm/onCancel.
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
  const titleId = useId()
  // Escape and the backdrop both close the dialog, and both mean "cancel";
  // the two buttons report their decision and let the parent unmount us.
  return (
    <Dialog onClose={onCancel} danger={destructive} width="max-w-md" aria-labelledby={titleId}>
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
        <h3 id={titleId} className="font-display font-semibold tracking-wider">
          {title ?? t('common.confirmTitle')}
        </h3>
      </header>
      <div className="px-5 py-4 text-sm text-t-secondary">{message}</div>
      <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
        <Button onClick={onCancel} autoFocus>
          <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button cut variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
          {destructive ? (
            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          ) : (
            <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          )}
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </footer>
    </Dialog>
  )
}
