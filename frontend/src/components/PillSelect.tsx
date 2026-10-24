import { ChevronDown } from 'lucide-react'
import { useEffect, type KeyboardEvent, type ReactNode } from 'react'
import { Menu, MenuItem, useMenu } from 'fluid-lycoris'

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
  const trigger = () => ref.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()

  // APG listbox popup: the list takes the focus on the chosen option (else the
  // first), so the arrow keys work at once
  useEffect(() => {
    if (!open) return
    const list = ref.current?.querySelector<HTMLElement>('[role="listbox"]')
    const at = list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('button')
    at?.focus({ preventScroll: true })
  }, [open, ref])

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
    }
  }
  // Tab leaves the list: close it with the focus on the trigger, where Tab
  // carries on from
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab' && open) {
      trigger()
      setOpen(false)
    }
  }
  return (
    <div className={`relative min-w-0 ${className ?? ''}`} ref={ref} style={anchorStyle} onKeyDown={onListKey}>
      <button
        type="button"
        className="t-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={`${label}: ${current?.label ?? placeholder ?? ''}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
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
                trigger()
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
