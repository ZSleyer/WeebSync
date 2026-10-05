import type { ReactNode } from 'react'
import { Button, Dialog } from '@weebsync/design-system'

export interface SheetAction {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  onClick: () => void
}

/**
 * Every action of one item as a list in a dialog - a bottom sheet on a phone.
 * What a long press on a row or tile opens (useLongPress), and what the
 * overflow button opens where there is no room for an anchored menu.
 */
export default function ActionSheet({
  title,
  actions,
  onClose,
}: {
  title: string
  actions: SheetAction[]
  onClose: () => void
}) {
  return (
    <Dialog width="max-w-sm" onClose={onClose} aria-labelledby="action-sheet-title">
      <header className="border-b border-border-subtle px-5 py-4">
        <h3 id="action-sheet-title" className="truncate font-display font-semibold tracking-wider">
          {title}
        </h3>
      </header>
      <div className="flex flex-col gap-1 p-2">
        {actions.map((a) => (
          <Button
            key={a.key}
            variant={a.danger ? 'danger' : 'default'}
            className="justify-start gap-2"
            onClick={() => {
              onClose()
              a.onClick()
            }}
          >
            {a.icon}
            {a.label}
          </Button>
        ))}
      </div>
    </Dialog>
  )
}
