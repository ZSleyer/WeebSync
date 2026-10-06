import { Ellipsis } from 'lucide-react'
import { IconButton, Menu, MenuItem, SHEET_MQ, useMediaQuery, useMenu } from '@weebsync/design-system'
import ActionSheet, { type SheetAction } from './ActionSheet'

/**
 * The ⋯ button of a row: all of the row's actions, as a menu anchored to the
 * button on a desktop and as a bottom sheet on a phone - the same sheet a long
 * press on the row opens, so the visible way and the shortcut agree.
 */
export default function ActionMenu({
  label,
  title,
  actions,
}: {
  label: string
  title: string
  actions: SheetAction[]
}) {
  const narrow = useMediaQuery(SHEET_MQ)
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  if (actions.length === 0) return null
  return (
    <div className="relative shrink-0" ref={ref} style={anchorStyle}>
      <IconButton
        aria-label={label}
        title={label}
        aria-haspopup={narrow ? 'dialog' : 'menu'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis aria-hidden size="1.2em" />
      </IconButton>
      {open &&
        (narrow ? (
          <ActionSheet title={title} actions={actions} onClose={() => setOpen(false)} />
        ) : (
          <Menu anchor={anchor} placement="bottom-end" aria-label={label}>
            {actions.map((a) => (
              <MenuItem
                key={a.key}
                onClick={() => {
                  setOpen(false)
                  a.onClick()
                }}
              >
                <span className={`flex items-center gap-2 ${a.danger ? 'text-err' : ''}`}>
                  {a.icon}
                  {a.label}
                </span>
              </MenuItem>
            ))}
          </Menu>
        ))}
    </div>
  )
}
