import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
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

/**
 * The button's class string on its own. For the cases a real `<button>` is the
 * wrong element - a router link, a file-input label, a NavLink whose className
 * is a function - and where wrapping would break the element's semantics.
 */
export function buttonClass(opts: Pick<ButtonProps, 'variant' | 'size' | 'cut'> & { className?: string } = {}) {
  const { variant = 'default', size = 'md', cut, className } = opts
  return cx(
    't-btn',
    size === 'sm' && 't-btn--sm',
    variant === 'primary' && 't-btn--primary',
    variant === 'danger' && 't-btn--danger',
    cut && 't-cut',
    className,
  )
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  cut?: boolean
}

/** A link that looks like a button - navigation, not an action. */
export function ButtonLink({ variant, size, cut, className, ...rest }: ButtonLinkProps) {
  return <a {...rest} className={buttonClass({ variant, size, cut, className })} />
}

export interface ButtonLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  cut?: boolean
}

/**
 * A label styled as a button, for the file-input pattern: the real `<input
 * type="file">` is visually hidden inside, so the label must stay a label to
 * keep the click and the focus ring working.
 */
export function ButtonLabel({ variant, size, cut, className, ...rest }: ButtonLabelProps) {
  return (
    <label
      {...rest}
      className={buttonClass({
        variant,
        size,
        cut,
        className: cx(
          'inline-flex cursor-pointer items-center',
          'focus-within:outline focus-within:outline-1 focus-within:outline-offset-2 focus-within:outline-accent',
          className,
        ),
      })}
    />
  )
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

// the native `size` attribute (character width / visible rows) is dropped in
// favour of the design-system size step
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** compact field for dense rows; matches a small Button in the same row */
  size?: 'md' | 'sm'
}

export function Input({ size = 'md', className, ...rest }: InputProps) {
  return <input {...rest} className={cx('t-input', size === 'sm' && 't-input--sm', className)} />
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  children: ReactNode
  size?: 'md' | 'sm'
  /** class for the wrapper that draws the chevron, not the select itself */
  wrapperClassName?: string
}

/** Native select plus the chevron the wrapper draws. */
export function Select({ size = 'md', className, wrapperClassName, children, ...rest }: SelectProps) {
  return (
    <span className={cx('t-select-wrap block', wrapperClassName)}>
      <select {...rest} className={cx('t-select', size === 'sm' && 't-select--sm', className)}>
        {children}
      </select>
    </span>
  )
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** text next to the box; omit for a bare checkbox in a table cell */
  label?: ReactNode
  /** extra classes for the label around box and text - colour, truncation */
  labelClassName?: string
}

export function Checkbox({ label, labelClassName, className, ...rest }: CheckboxProps) {
  const box = <input type="checkbox" {...rest} className={className} />
  if (!label) return box
  return (
    <label className={cx('flex items-center gap-2 text-sm', labelClassName)}>
      {box}
      {label}
    </label>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

/** Multi-line input; same border, focus ring and padding as Input. */
export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea {...rest} className={cx('t-input', className)} />
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

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  /** red corner brackets, for destructive areas */
  danger?: boolean
  /**
   * The element to render. A panel is often a form or a labelled section, and
   * forcing a div there would break the submit or drop the landmark.
   */
  as?: 'div' | 'section' | 'form' | 'article' | 'aside' | 'li'
}

export function Panel({ as: Tag = 'div', danger, className, ...rest }: PanelProps) {
  return <Tag {...rest} className={cx('t-panel', danger && 't-panel--danger', className)} />
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err'

export interface BadgeProps extends HTMLAttributes<HTMLElement> {
  tone?: BadgeTone
  /** a chip that labels a control has to be a real <label>, a fieldset's a <legend> */
  as?: 'span' | 'label' | 'div' | 'legend' | 'a' | 'h3' | 'h4' | 'button'
  /** only with as="label" */
  htmlFor?: string
  /** only with as="a" - a chip that links out to a provider page */
  href?: string
  target?: string
  rel?: string
}

/** Uppercase micro-label chip. Height is fixed, so chips match across sections. */
export function Badge({ tone = 'neutral', as: Tag = 'span', className, ...rest }: BadgeProps) {
  return (
    <Tag
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
