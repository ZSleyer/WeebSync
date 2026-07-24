import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'

// Presentational wrappers around the Tempest classes in styles.css. Deliberately
// free of app concerns - no data fetching, no i18n, no router - so a component
// renders identically here, in the app and in a design tool. Every size comes
// from the --ctl-* variables; nothing here sets a height of its own.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SurfaceProps {
  children: ReactNode
  /** which palette to render on; omit to inherit the page's */
  theme?: 'dark' | 'light'
  /** drop the padding when the surface only has to supply the background */
  flush?: boolean
  className?: string
}

/**
 * The page surface every other component expects underneath it: the base
 * background plus its matching text colour. WeebSync is dark-first, so a
 * component dropped onto a white page loses its contrast - wrap a screen, a
 * section, or a preview in this and the palette is right by construction.
 */
export function Surface({ children, theme, flush, className }: SurfaceProps) {
  return (
    <div
      data-theme={theme}
      className={cx(flush ? undefined : 'p-4', className)}
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {children}
    </div>
  )
}

export type ButtonVariant = 'default' | 'primary' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** visual weight; primary is the one call to action per view */
  variant?: ButtonVariant
  /** small controls sit at --ctl-h-sm and pair with badges and divider rows */
  size?: 'md' | 'sm'
  /** clip the top-right corner - reserved for the primary action */
  cut?: boolean
}

export function Button({ variant = 'default', size = 'md', cut, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        't-btn',
        size === 'sm' && 't-btn--sm',
        variant === 'primary' && 't-btn--primary',
        variant === 'danger' && 't-btn--danger',
        cut && 't-cut',
        className,
      )}
    />
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** the icon; sized in em so it follows the button's font size */
  children: ReactNode
  /** icon-only buttons carry no text, so a label is mandatory */
  'aria-label': string
}

/** Square icon-only button, exactly the box of a small Button. */
export function IconButton({ className, ...rest }: IconButtonProps) {
  return <button type="button" {...rest} className={cx('t-iconbtn', className)} />
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...rest }: InputProps) {
  return <input {...rest} className={cx('t-input', className)} />
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode
}

/** Native select plus the chevron the wrapper draws. */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <span className="t-select-wrap block">
      <select {...rest} className={cx('t-select', className)}>
        {children}
      </select>
    </span>
  )
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** text next to the box; omit for a bare checkbox in a table cell */
  label?: ReactNode
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  const box = <input type="checkbox" {...rest} className={className} />
  if (!label) return box
  return (
    <label className="flex items-center gap-2 text-sm">
      {box}
      {label}
    </label>
  )
}

export interface FieldProps {
  /** caption above the control */
  label: ReactNode
  /** the control itself - Input, Select, or anything else */
  children: ReactNode
  /** id of the control, when the caption should point at it */
  htmlFor?: string
  className?: string
}

/**
 * Caption above a control, control pinned to the bottom. In a row of fields the
 * controls line up even when one caption wraps or carries a help button.
 */
export function Field({ label, children, htmlFor, className }: FieldProps) {
  return (
    <label className={cx('t-field text-xs text-t-muted', className)} htmlFor={htmlFor}>
      <span className="block">{label}</span>
      {children}
    </label>
  )
}

/** The grid every two-column form row uses, so the column edge never shifts. */
export const ROW_GRID = 'grid gap-3 sm:grid-cols-2'

export interface FieldRowProps {
  children: ReactNode
  className?: string
}

export function FieldRow({ children, className }: FieldRowProps) {
  return <div className={cx(ROW_GRID, className)}>{children}</div>
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** red corner brackets, for destructive areas */
  danger?: boolean
}

export function Panel({ danger, className, ...rest }: PanelProps) {
  return <div {...rest} className={cx('t-panel', danger && 't-panel--danger', className)} />
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

/** Uppercase micro-label chip. Height is fixed, so chips match across sections. */
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        't-label',
        tone === 'accent' && 't-label--accent',
        tone === 'ok' && 't-label--ok',
        tone === 'warn' && 't-label--warn',
        tone === 'err' && 't-label--err',
        className,
      )}
    />
  )
}

export interface DividerProps {
  /** the section chip on the left */
  label: ReactNode
  /** number shown at the right end of the rule */
  count?: number
  /** replaces the count - e.g. a link */
  trailing?: ReactNode
  className?: string
}

/** Section divider: chip, hairline rule, trailing count. */
export function Divider({ label, count, trailing, className }: DividerProps) {
  return (
    <div className={cx('t-divider', className)}>
      <Badge tone="accent">{label}</Badge>
      <span className="t-divider-rule" />
      {trailing ?? (count !== undefined && <span className="t-count">{count}</span>)}
    </div>
  )
}

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {}

/** One control row at a single compact height - filters, search, bulk actions. */
export function Toolbar({ className, ...rest }: ToolbarProps) {
  return <div {...rest} className={cx('t-toolbar', className)} />
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function Tabs({ className, children, ...rest }: TabsProps) {
  return (
    <div role="tablist" {...rest} className={cx('t-tabs', className)}>
      {children}
    </div>
  )
}

export interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
}

export function Tab({ selected, className, ...rest }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      {...rest}
      className={cx('t-tab', className)}
    />
  )
}

/** Tabular number, for counts next to a divider or in a stat row. */
export function Count({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={cx('t-count', className)} />
}
