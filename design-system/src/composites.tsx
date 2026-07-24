import type { HTMLAttributes, ReactNode } from 'react'
import { Badge, Panel } from './primitives'

// The composed surfaces WeebSync reuses across pages: media tiles, the file
// browser, calendar entries, menus and modals. Same markup the app renders,
// with every piece of data arriving as a prop - no fetching, no router, no i18n.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface CoverProps {
  /** poster URL; omitted or failing, the hatched placeholder stands in */
  src?: string
  /** list tiles use 'md', calendar rows 'sm' */
  size?: 'md' | 'sm'
  alt?: string
}

/** Poster thumbnail with the hatched placeholder the app falls back to. */
export function Cover({ src, size = 'md', alt = '' }: CoverProps) {
  const box = size === 'sm' ? 'h-14 w-10' : 'h-20 w-14'
  if (!src) return <div className={cx('t-hatch shrink-0', box)} />
  return <img src={src} alt={alt} className={cx('shrink-0 object-cover', box)} />
}

export interface MediaCardProps {
  /** series or movie title */
  title: ReactNode
  /** source and target, rendered monospaced under the title */
  path?: ReactNode
  /** one line of status text, e.g. when it was last checked */
  meta?: ReactNode
  /** poster URL */
  cover?: string
  /** status chips - use Badge with the tone that fits */
  badges?: ReactNode
  /** row of buttons on the right */
  actions?: ReactNode
  className?: string
}

/**
 * A watched series or movie: poster, title, path, status chips, actions.
 * The workhorse tile of the auto-sync list.
 */
export function MediaCard({ title, path, meta, cover, badges, actions, className }: MediaCardProps) {
  return (
    <Panel className={cx('flex flex-wrap items-center gap-4 p-3', className)}>
      <Cover src={cover} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-t-primary">{title}</h3>
        {path && <p className="truncate font-mono text-[11px] text-t-muted">{path}</p>}
        {meta && <p className="mt-1 text-[11px] text-t-muted">{meta}</p>}
        {badges && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">{badges}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </Panel>
  )
}

export interface SuggestionCardProps {
  title: ReactNode
  /** release year, shown muted behind the title */
  year?: number
  cover?: string
  /** where the suggestion came from, or what it would improve */
  badges?: ReactNode
  /** short explanation under the title */
  detail?: ReactNode
  actions?: ReactNode
  className?: string
}

/** A recommendation: same tile, top-aligned, with the year behind the title. */
export function SuggestionCard({ title, year, cover, badges, detail, actions, className }: SuggestionCardProps) {
  return (
    <Panel className={cx('flex flex-wrap items-start gap-4 p-3', className)}>
      <Cover src={cover} />
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium text-t-primary">
          {title}
          {year ? <span className="text-t-muted"> ({year})</span> : null}
        </h4>
        {badges && <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">{badges}</p>}
        {detail && <p className="mt-1 text-[11px] text-t-muted">{detail}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </Panel>
  )
}

export interface CalendarEntryProps {
  title: ReactNode
  /** which episode airs, e.g. "Folge 12" */
  episode?: ReactNode
  cover?: string
  /** airing time, monospaced on the right */
  time: ReactNode
  /** countdown under the time, in the accent colour */
  countdown?: ReactNode
  className?: string
}

/** One scheduled release inside a calendar day. */
export function CalendarEntry({ title, episode, cover, time, countdown, className }: CalendarEntryProps) {
  return (
    <Panel className={cx('flex items-center gap-3 p-2', className)}>
      <Cover src={cover} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-t-primary">{title}</p>
        {episode && <p className="text-[11px] text-t-muted">{episode}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm text-t-secondary">{time}</p>
        {countdown && <p className="text-[11px] text-accent">{countdown}</p>}
      </div>
    </Panel>
  )
}

export interface CalendarDayProps {
  /** the day heading, e.g. "Freitag, 25.07." */
  day: ReactNode
  /** CalendarEntry elements */
  children: ReactNode
  className?: string
}

/** A day column: chip heading plus its releases. */
export function CalendarDay({ day, children, className }: CalendarDayProps) {
  return (
    <section className={cx('min-w-0', className)}>
      <h3 className="t-label t-label--accent mb-2">{day}</h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  )
}

export interface BreadcrumbProps {
  /** path segments, root excluded - it is always drawn first */
  segments: string[]
  onNavigate?: (path: string) => void
  /** trailing control, e.g. an edit button */
  trailing?: ReactNode
  className?: string
}

/** Path bar of the file browser: root, segments, optional trailing action. */
export function Breadcrumb({ segments, onNavigate, trailing, className }: BreadcrumbProps) {
  return (
    <nav
      className={cx(
        'flex flex-wrap items-center border-b border-border-subtle px-2 py-1 font-mono text-xs',
        className,
      )}
      aria-label="Pfad"
    >
      {/* every crumb keeps a 24px target (WCAG 2.5.8) */}
      <button type="button" className="min-h-6 min-w-6 px-1.5 text-accent hover:underline" onClick={() => onNavigate?.('')}>
        /
      </button>
      {segments.map((c, i) => (
        <span key={i} className="flex items-center">
          <button
            type="button"
            className="min-h-6 max-w-40 truncate px-1.5 text-accent hover:underline"
            onClick={() => onNavigate?.(segments.slice(0, i + 1).join('/'))}
          >
            {c}
          </button>
          {i < segments.length - 1 && <span className="text-t-faint">/</span>}
        </span>
      ))}
      {trailing && <span className="ml-auto flex items-center">{trailing}</span>}
    </nav>
  )
}

export interface FileRowProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  name: ReactNode
  /** leading icon - a folder or a file glyph */
  icon?: ReactNode
  /** right-aligned size or date */
  detail?: ReactNode
  selected?: boolean
}

/** One entry in a browser listing. */
export function FileRow({ name, icon, detail, selected, className, ...rest }: FileRowProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-bg-hover',
        selected ? 'text-accent' : 'text-t-secondary',
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail && <span className="shrink-0 text-t-muted">{detail}</span>}
    </button>
  )
}

export interface FileBrowserProps {
  /** the Breadcrumb for the current directory */
  breadcrumb: ReactNode
  /** FileRow elements */
  children: ReactNode
  /** shown instead of the rows when the directory is empty */
  empty?: ReactNode
  className?: string
}

/** Framed listing: path bar on top, scrollable rows below. */
export function FileBrowser({ breadcrumb, children, empty, className }: FileBrowserProps) {
  return (
    <div className={cx('flex max-h-56 flex-col overflow-hidden border border-border-subtle bg-bg-secondary/40', className)}>
      {breadcrumb}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? <p className="p-2 text-xs text-t-muted">{empty}</p> : children}
      </div>
    </div>
  )
}

export interface MenuProps {
  /** MenuItem elements */
  children: ReactNode
  'aria-label': string
  className?: string
}

/** Dropdown list - sort pickers, overflow menus. Position it yourself. */
export function Menu({ children, className, ...rest }: MenuProps) {
  return (
    <ul role="listbox" {...rest} className={cx('min-w-44 border border-border-subtle bg-bg-card py-1 shadow-lg', className)}>
      {children}
    </ul>
  )
}

export interface MenuItemProps extends HTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  /** trailing mark, e.g. a check on the active option */
  trailing?: ReactNode
}

export function MenuItem({ selected, trailing, children, className, ...rest }: MenuItemProps) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        {...rest}
        className={cx(
          'flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm hover:bg-bg-secondary',
          selected ? 'text-accent' : 'text-t-secondary',
          className,
        )}
      >
        {children}
        {selected && trailing}
      </button>
    </li>
  )
}

export interface NavItemProps extends HTMLAttributes<HTMLAnchorElement> {
  icon?: ReactNode
  active?: boolean
  href?: string
}

/** Sidebar entry: accent bar and tinted background mark the active route. */
export function NavItem({ icon, active, children, className, ...rest }: NavItemProps) {
  return (
    <a
      {...rest}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2 whitespace-nowrap border-l-2 px-4 py-2 font-display text-sm transition-colors',
        active
          ? 'border-accent bg-bg-hover text-accent'
          : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary',
        className,
      )}
    >
      {icon}
      {children}
    </a>
  )
}

export interface ModalProps {
  title: ReactNode
  /** context lines under the title */
  info?: ReactNode
  children: ReactNode
  /** buttons in the sticky footer */
  footer?: ReactNode
  className?: string
}

/**
 * The dialog body WeebSync renders inside a native `<dialog>`: fixed header,
 * scrollable content, sticky footer. Shown here as a static panel so the layout
 * is visible without opening a real dialog.
 */
export function Modal({ title, info, children, footer, className }: ModalProps) {
  return (
    <div className={cx('flex max-h-[80vh] w-full max-w-lg flex-col bg-bg-card', className)}>
      <header className="border-b border-border-subtle px-5 py-4">
        <h3 className="font-display font-semibold tracking-wider">{title}</h3>
        {info && <p className="mt-1 text-[11px] text-t-secondary">{info}</p>}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
      {footer && (
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">{footer}</footer>
      )}
    </div>
  )
}

export interface EmptyStateProps {
  /** short chip heading */
  label?: ReactNode
  children: ReactNode
  className?: string
}

/** Centred placeholder for an empty list. */
export function EmptyState({ label, children, className }: EmptyStateProps) {
  return (
    <Panel className={cx('p-8 text-center', className)}>
      {label && (
        <Badge tone="accent" className="mb-3">
          {label}
        </Badge>
      )}
      <p className="text-sm text-t-muted">{children}</p>
    </Panel>
  )
}
