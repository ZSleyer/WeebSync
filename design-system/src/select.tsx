import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { useMenu } from './useMenu'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// A select that never shows the browser's own popup: the APG "select-only
// combobox". Focus stays on the trigger, the options sit in a listbox in the
// top layer (glass, the picked one in the accent with a check), and the
// active option is announced through aria-activedescendant. It takes the
// same <option> children and the same change handler as a native <select>,
// so a form or a caller written for one keeps working.

export interface SelectOption {
  value: string
  label: ReactNode
  /** the plain text, for type-ahead */
  text: string
  disabled: boolean
  /** shown as the value but never listed, like a native `<option hidden>`:
   * a "choose one" prompt that is not itself a choice */
  hidden: boolean
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** The <option> elements among a select's children, through fragments, arrays and optgroups. */
export function selectOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = []
  const walk = (nodes: ReactNode) =>
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return
      const el = child as ReactElement<{ children?: ReactNode; value?: unknown; disabled?: boolean; hidden?: boolean }>
      if (el.type === Fragment || el.type === 'optgroup') return walk(el.props.children)
      if (el.type !== 'option') return
      const text = textOf(el.props.children)
      out.push({
        value: el.props.value === undefined ? text : String(el.props.value),
        label: el.props.children,
        text,
        // a hidden option cannot be reached by the keys either
        disabled: !!el.props.disabled || !!el.props.hidden,
        hidden: !!el.props.hidden,
      })
    })
  walk(children)
  return out
}

/**
 * The next enabled option from `from` in direction `dir` (1 down, -1 up),
 * staying put at the ends; -1 when there is none.
 */
export function stepOption(options: SelectOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i
  return from >= 0 && from < options.length && !options[from].disabled ? from : -1
}

/** The first enabled option whose text starts with `query`, searching on after `from` and wrapping. */
export function typeAhead(options: SelectOption[], from: number, query: string): number {
  const q = query.toLocaleLowerCase()
  const n = options.length
  // a repeated single letter cycles through the options with that letter
  const start = q.length > 1 ? from : from + 1
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    if (!options[i].disabled && options[i].text.toLocaleLowerCase().startsWith(q)) return i
  }
  return -1
}

// How the listbox is placed. anchor: in the top layer, attached by anchor
// positioning. fixed: in the top layer, placed from the trigger's box (an
// engine with popovers but without anchor positioning, e.g. Firefox).
// inline: under the trigger in the page (no popover support at all, jsdom).
type Placement = 'anchor' | 'fixed' | 'inline'
function placement(): Placement {
  if (typeof HTMLElement === 'undefined' || !('showPopover' in HTMLElement.prototype)) return 'inline'
  return typeof CSS !== 'undefined' && CSS.supports('anchor-name: --a') ? 'anchor' : 'fixed'
}

/** Where a fixed list goes: under the trigger, or above it when it would leave the viewport and there is more room above. */
export function listPosition(
  trigger: { left: number; top: number; bottom: number; width: number },
  listHeight: number,
  viewportHeight: number,
  gap = 4,
): { left: number; top: number; minWidth: number } {
  const below = viewportHeight - trigger.bottom - gap
  const above = trigger.top - gap
  const up = listHeight > below && above > below
  return {
    left: trigger.left,
    top: up ? Math.max(gap, trigger.top - gap - listHeight) : trigger.bottom + gap,
    minWidth: trigger.width,
  }
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  children: ReactNode
  size?: 'md' | 'sm'
  /** class for the wrapper that draws the chevron */
  wrapperClassName?: string
}

const Check = () => (
  <svg aria-hidden viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
)

/** One value out of a list, without the browser's native popup. */
export function Select({
  size = 'md',
  className,
  wrapperClassName,
  children,
  value,
  defaultValue,
  onChange,
  name,
  disabled,
  id,
  ...rest
}: SelectProps) {
  const options = selectOptions(children)
  const firstEnabled = options.findIndex((o) => !o.disabled)
  const [own, setOwn] = useState(() =>
    defaultValue !== undefined ? String(defaultValue) : (options[Math.max(firstEnabled, 0)]?.value ?? ''),
  )
  const current = value !== undefined ? String(value) : own
  const picked = options.findIndex((o) => o.value === current)
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu<HTMLSpanElement>()
  const [active, setActive] = useState(-1)
  // keys moved the highlight last (not the pointer): only then it carries a focus ring
  const [byKey, setByKey] = useState(false)
  const listId = `${useId().replace(/[^A-Za-z0-9_-]/g, '')}-list`
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const typed = useRef({ q: '', at: 0 })
  const mode = placement()
  const [fixedAt, setFixedAt] = useState<{ left: number; top: number; minWidth: number } | null>(null)

  // only the forwarded aria-* and data-* attributes reach the trigger
  const passthrough = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('aria-') || k.startsWith('data-') || k === 'title'))

  useEffect(() => {
    if (!open) return
    if (mode === 'inline') return
    try {
      list.current?.showPopover?.()
    } catch {
      /* already shown */
    }
    if (mode === 'fixed' && trigger.current && list.current) {
      setFixedAt(listPosition(trigger.current.getBoundingClientRect(), list.current.offsetHeight, innerHeight))
    }
  }, [open, mode])

  // the active option stays in view while the keys walk the list
  useEffect(() => {
    if (!open || active < 0) return
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const show = (at: number) => {
    setActive(at)
    setFixedAt(null)
    setOpen(true)
  }
  const pick = (i: number) => {
    const o = options[i]
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
    if (!o || o.disabled || o.value === current) return
    if (value === undefined) setOwn(o.value)
    const target = { value: o.value, name: name ?? '' }
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) setByKey(true)
    const from = active >= 0 ? active : picked
    const last = stepOption(options, options.length, -1)
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== ' ' || typed.current.q)) {
      const now = Date.now()
      typed.current.q = now - typed.current.at > 500 ? e.key : typed.current.q + e.key
      typed.current.at = now
      const hit = typeAhead(options, from, typed.current.q)
      e.preventDefault()
      if (hit >= 0) show(hit)
      else if (!open) show(from)
      return
    }
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        show(from >= 0 ? from : firstEnabled)
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        show(e.key === 'Home' ? firstEnabled : last)
      }
      return
    }
    const moves: Record<string, number> = {
      ArrowDown: stepOption(options, from, 1),
      ArrowUp: stepOption(options, from, -1),
      Home: firstEnabled,
      End: last,
      PageDown: stepOption(options, Math.min(from + 9, options.length - 1), 1),
      PageUp: stepOption(options, Math.max(from - 9, 0), -1),
    }
    if (e.key in moves) {
      e.preventDefault()
      setActive(moves[e.key])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(from)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
    // Escape: useMenu closes and keeps focus on the trigger
  }

  return (
    <span ref={ref} className={cx('t-select-wrap block', wrapperClassName)} style={anchorStyle}>
      <button
        ref={trigger}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        disabled={disabled}
        {...passthrough}
        onClick={() => {
          setByKey(false)
          if (open) setOpen(false)
          else show(picked >= 0 ? picked : firstEnabled)
        }}
        onKeyDown={onKeyDown}
        className={cx('t-select', size === 'sm' && 't-select--sm', className)}
      >
        <span className="t-select-value">{options[picked]?.label ?? ''}</span>
      </button>
      {name !== undefined && <input type="hidden" name={name} value={current} disabled={disabled} />}
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-labelledby={id}
          aria-label={id ? undefined : (rest['aria-label'] as string | undefined)}
          tabIndex={-1}
          data-keys={byKey ? '' : undefined}
          {...(mode !== 'inline' ? { popover: 'manual' } : {})}
          style={
            mode === 'anchor'
              ? { positionAnchor: anchor, minWidth: 'anchor-size(width)' }
              : mode === 'fixed'
                ? { position: 'fixed', margin: 0, inset: 'auto', ...(fixedAt ?? { visibility: 'hidden' }) }
                : undefined
          }
          className={cx(
            't-pop t-glass t-listbox max-h-[min(60dvh,20rem)] overflow-x-clip overflow-y-auto rounded-lg border py-1',
            mode === 'anchor' ? 't-menu' : mode === 'inline' && 'absolute top-full left-0 z-20 mt-1 min-w-full',
          )}
        >
          {options.map((o, i) =>
            o.hidden ? null : (
            <li
              key={`${o.value}-${i}`}
              id={`${listId}-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === picked}
              aria-disabled={o.disabled || undefined}
              data-active={i === active ? '' : undefined}
              className="t-option"
              // the trigger keeps focus: a press on an option must not take it
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !o.disabled && pick(i)}
              onMouseMove={() => {
                setByKey(false)
                if (!o.disabled && i !== active) setActive(i)
              }}
            >
              <span className="min-w-0 flex-1">{o.label}</span>
              {i === picked && <Check />}
            </li>
            ),
          )}
        </ul>
      )}
    </span>
  )
}
