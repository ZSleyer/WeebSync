import type { ReactNode } from 'react'
import { Dialog } from 'fluid-lycoris'

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
 * overflow button opens where there is no room for an anchored menu. The
 * title is the item's name, the actions 52px rows between hairlines.
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
      <header className="px-5 pt-4 pb-2">
        <h2 id="action-sheet-title" className="font-display text-lg font-semibold break-words">
          {title}
        </h2>
      </header>
      <ul className="grid px-4 pb-3">
        {actions.map((a) => (
          <li key={a.key} className="border-b border-border-subtle last:border-b-0">
            <button
              type="button"
              className={`flex min-h-13 w-full items-center gap-3.5 px-1 text-left text-[0.9375rem] hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${
                a.danger ? 'text-err' : 'text-t-primary'
              } [&_svg]:size-5 [&_svg]:shrink-0`}
              onClick={() => {
                onClose()
                a.onClick()
              }}
            >
              {a.icon}
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
