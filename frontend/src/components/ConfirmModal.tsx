import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from 'fluid-lycoris'
import './confirm.css'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

// The confirm box: a plain question with two answers, no header bar, no
// icons. Cancel comes first and holds the focus, so Enter on a destructive
// question keeps things as they are. Backdrop and Escape both cancel.
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
  // the message is the question itself: screen readers announce it with
  // the title when focus lands in the dialog
  const messageId = useId()
  return (
    <Dialog
      onClose={onCancel}
      width="max-w-md"
      className="ws-confirm"
      aria-labelledby={titleId}
      aria-describedby={messageId}
    >
      <div className="ws-confirm-in">
        <h2 id={titleId}>{title ?? t('common.confirmTitle')}</h2>
        <p id={messageId}>{message}</p>
        <div className="ws-confirm-foot">
          <Button onClick={onCancel} autoFocus>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'danger-fill' : 'primary'} onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
