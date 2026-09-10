import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { Menu, MenuItem, useMenu } from '@weebsync/design-system'

export interface PillOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

// PillSelect is a choice that reads as a chip rather than as a form field: the
// current value with a chevron, the list on tap. The same shape the source and
// the assistant's model use, so a toolbar of them lines up instead of mixing
// labelled selects with buttons.
export default function PillSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder,
  icon,
  className,
}: {
  value: T
  options: PillOption<T>[]
  onChange: (v: T) => void
  /** what the choice is about - the control's accessible name */
  label: string
  /** shown while nothing is chosen yet */
  placeholder?: string
  /** in front of the value, e.g. the sort mark */
  icon?: ReactNode
  className?: string
}) {
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  const current = options.find((o) => o.value === value)
  return (
    <div className={`relative min-w-0 ${className ?? ''}`} ref={ref} style={anchorStyle}>
      <button
        type="button"
        className="flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-border-input px-3 text-sm text-t-primary hover:border-accent/60"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={`${label}: ${current?.label ?? placeholder ?? ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.icon ?? icon}
        <span className={`truncate ${current ? '' : 'text-t-muted'}`}>{current?.label ?? placeholder ?? label}</span>
        <ChevronDown aria-hidden size="0.9em" className="shrink-0 text-t-muted" />
      </button>
      {open && (
        <Menu anchor={anchor} aria-label={label}>
          {options.map((o) => (
            <MenuItem
              key={o.value}
              selected={o.value === value}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span className="flex items-center gap-2">
                {o.icon}
                <span className="truncate">{o.label}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}
