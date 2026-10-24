import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
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

  // where the list puts the focus when it opens: the chosen option for a click
  // and ArrowDown, else the first or last (APG select-only combobox)
  const from = useRef<'selected' | 'first' | 'last'>('selected')
  useEffect(() => {
    if (!open) return
    const list = ref.current?.querySelector<HTMLElement>('[role="listbox"]')
    const all = [...(list?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at =
      from.current === 'first'
        ? all[0]
        : from.current === 'last'
          ? all[all.length - 1]
          : (list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? all[0])
    from.current = 'selected'
    at?.focus({ preventScroll: true })
  }, [open, ref])

  const onTriggerKey = (e: KeyboardEvent) => {
    const to = { ArrowDown: 'selected', ArrowUp: 'first', Home: 'first', End: 'last' } as const
    if (e.key in to && !open) {
      e.preventDefault()
      from.current = to[e.key as keyof typeof to]
      setOpen(true)
    }
  }
  // inside the open list the arrows stop at the ends (the list itself wraps)
  const onListKeyCapture = (e: KeyboardEvent) => {
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="listbox"] button') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (at < 0 || (e.key === 'ArrowDown' ? at !== all.length - 1 : at !== 0)) return
    e.preventDefault()
    e.stopPropagation()
  }
  // Tab chooses the focused option, closes the list and moves on from the
  // trigger (APG select-only combobox)
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !open) return
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="listbox"] button') ?? [])]
    const o = options[all.indexOf(document.activeElement as HTMLElement)]
    if (o && o.value !== value) onChange(o.value)
    trigger()
    setOpen(false)
  }
  return (
    <div
      className={`relative min-w-0 ${className ?? ''}`}
      ref={ref}
      style={anchorStyle}
      onKeyDown={onListKey}
      onKeyDownCapture={onListKeyCapture}
    >
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
