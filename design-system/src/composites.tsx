import type { HTMLAttributes, ReactNode } from 'react'
import { Badge, Panel } from './primitives'

// The composed surfaces WeebSync reuses across pages: media tiles, the file
// browser, calendar entries, menus and modals. Same markup the app renders,
// with every piece of data arriving as a prop - no fetching, no router, no i18n.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface CoverProps {
  /** poster URL; omitted or failing, the hatched placeholder stands in */
  src?: string
  /** list tiles use 'md', calendar rows 'sm', grid tiles 'fill' */
  size?: 'md' | 'sm' | 'lg' | 'fill'
  alt?: string
  /** defer offscreen posters - grids of dozens of tiles */
  loading?: 'eager' | 'lazy'
  /** shown over the placeholder, e.g. a matching hint */
  children?: ReactNode
  className?: string
}

const COVER_BOX = {
  sm: 'h-14 w-10',
  md: 'h-20 w-14',
  lg: 'h-24 w-16',
  fill: 'aspect-2/3 w-full',
} as const

/**
 * Poster thumbnail in a fixed frame. The frame decides the size and the image
 * is cropped into it, so a poster of any aspect ratio leaves the layout alone.
 */
export function Cover({ src, size = 'md', alt = '', loading, children, className }: CoverProps) {
  const box = cx(COVER_BOX[size], size === 'fill' ? undefined : 'shrink-0', className)
  if (!src) {
    return (
      <div className={cx('t-hatch grid place-items-center', box)}>{children}</div>
    )
  }
  return <img src={src} alt={alt} loading={loading} className={cx('object-cover', box)} />
}

export interface MediaCardProps {
  /** series or movie title */
  title: ReactNode
  /** source and target, rendered monospaced under the title */
  path?: ReactNode
  /** title attribute for the path, which is usually truncated */
  pathTitle?: string
  /** one line of status text, e.g. when it was last checked */
  meta?: ReactNode
  /** poster URL */
  cover?: string
  /** status chips - use Badge with the tone that fits */
  badges?: ReactNode
  /** right-aligned counters between the text block and the actions */
  status?: ReactNode
  /** row of buttons; full width below the sm breakpoint, inline above it */
  actions?: ReactNode
  className?: string
}

/**
 * A watched series or movie: poster, title, path, status chips, counters and
 * actions. The workhorse tile of the auto-sync list.
 */
export function MediaCard({
  title,
  path,
  pathTitle,
  meta,
  cover,
  badges,
  status,
  actions,
  className,
}: MediaCardProps) {
  return (
    <Panel className={cx('flex flex-wrap items-center gap-4 p-3', className)}>
      <Cover src={cover} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-t-primary">{title}</h3>
        {path && (
          <p className="truncate font-mono text-[11px] text-t-muted" title={pathTitle}>
            {path}
          </p>
        )}
        {meta && <p className="mt-1 text-[11px] text-t-muted">{meta}</p>}
        {badges && <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">{badges}</div>}
      </div>
      {/* on a phone the counters take a row of their own: as a third column they
          left the chip row barely 170px, which is what made the status chips
          wrap into three lines */}
      {status && <div className="order-1 basis-full text-xs sm:order-none sm:basis-auto sm:text-right">{status}</div>}
      {/* the action row wraps as a row - two buttons per line - instead of
          letting each button wrap its own label; the basis is the widest label
          this tile carries. The important suffix is required: `.t-btn--sm` sets
          a min-width unlayered, which otherwise beats any utility. */}
      {actions && (
        <div className="flex w-full flex-wrap gap-1 sm:w-auto sm:flex-nowrap [&>.t-btn]:min-w-[7.5rem]! sm:[&>.t-btn]:min-w-0!">
          {actions}
        </div>
      )}
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
  /** anything below the text: candidate lists, option groups, quality grids */
  children?: ReactNode
  actions?: ReactNode
  /**
   * "inline" keeps the buttons in the text column under the content (the
   * suggestion list); "side" puts them at the right edge of the tile.
   */
  actionsPlacement?: 'inline' | 'side'
  /** the upgrade tile titles in the display face without a year */
  titleStyle?: 'plain' | 'display'
  className?: string
}

/** A recommendation: same tile, top-aligned, with the year behind the title. */
export function SuggestionCard({
  title,
  year,
  cover,
  badges,
  detail,
  children,
  actions,
  actionsPlacement = 'side',
  titleStyle = 'plain',
  className,
}: SuggestionCardProps) {
  const heading =
    titleStyle === 'display'
      ? 'truncate font-display text-sm font-semibold tracking-wider text-t-primary'
      : 'truncate text-sm font-medium text-t-primary'
  return (
    <Panel className={cx('flex flex-wrap items-start gap-4 p-3', className)}>
      <Cover src={cover} />
      <div className="min-w-0 flex-1">
        <h4 className={heading}>
          {title}
          {year ? <span className="text-t-muted"> ({year})</span> : null}
        </h4>
        {badges && <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">{badges}</p>}
        {detail && <p className="mt-1 text-[11px] text-t-muted">{detail}</p>}
        {children}
        {actions && actionsPlacement === 'inline' && (
          <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>
        )}
      </div>
      {actions && actionsPlacement === 'side' && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
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
  /** clicking the empty area starts editing; each crumb keeps navigating */
  onStartEdit?: () => void
  /** accessible name of the bar - the app passes its translated label */
  label?: string
  className?: string
}

/**
 * Path bar of the file browser: root, segments, optional trailing action. With
 * onStartEdit the empty area turns into a hit area for the path editor, while
 * the crumbs keep navigating (they stop the click from bubbling).
 */
export function Breadcrumb({
  segments,
  onNavigate,
  trailing,
  onStartEdit,
  label = 'Pfad',
  className,
}: BreadcrumbProps) {
  const crumb = (text: string, target: string, extra?: string) => (
    <button
      type="button"
      className={cx('min-h-6 px-1.5 text-accent hover:underline', extra)}
      onClick={(e) => {
        e.stopPropagation()
        onNavigate?.(target)
      }}
    >
      {text}
    </button>
  )
  return (
    <nav
      className={cx(
        'flex flex-wrap items-center border-b border-border-subtle px-2 py-1 font-mono text-xs',
        onStartEdit && 'cursor-text',
        className,
      )}
      aria-label={label}
      onClick={onStartEdit}
    >
      {/* every crumb keeps a 24px target (WCAG 2.5.8) */}
      {crumb('/', '', 'min-w-6')}
      {segments.map((c, i) => (
        <span key={i} className="flex items-center">
          {crumb(c, segments.slice(0, i + 1).join('/'), 'max-w-40 truncate')}
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
  /**
   * "comfortable" is the browser listing (text-sm), "compact" the monospaced
   * picker rows inside a dialog.
   */
  density?: 'comfortable' | 'compact'
  /** trailing controls outside the clickable row, e.g. a select button */
  actions?: ReactNode
  onDoubleClick?: HTMLAttributes<HTMLButtonElement>['onDoubleClick']
}

/** One entry in a browser listing. */
export function FileRow({
  name,
  icon,
  detail,
  selected,
  density = 'comfortable',
  actions,
  className,
  ...rest
}: FileRowProps) {
  const row = (
    <button
      type="button"
      {...rest}
      className={cx(
        'flex min-w-0 flex-1 items-center gap-2 text-left transition-colors',
        density === 'compact' ? 'px-2 py-1 font-mono text-xs' : 'px-3 py-1.5 text-sm',
        selected ? 'bg-bg-hover text-accent' : 'text-t-secondary hover:bg-bg-hover',
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail && <span className="shrink-0 text-t-muted">{detail}</span>}
    </button>
  )
  if (!actions) return row
  return (
    <li className="flex items-stretch border-b border-border-subtle/50 last:border-b-0">
      {row}
      {actions}
    </li>
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

export type NavVariant = 'sidebar' | 'bottomTab' | 'sheet'

export interface NavItemProps {
  icon?: ReactNode
  children: ReactNode
  active?: boolean
  /**
   * sidebar: accent bar on the left edge (desktop rail and settings menu)
   * bottomTab: icon over label, accent bar on top (phone tab bar)
   * sheet: tall touch row in the overflow sheet
   */
  variant?: NavVariant
  className?: string
}

const NAV_BASE: Record<NavVariant, string> = {
  sidebar: 'flex items-center gap-2 whitespace-nowrap border-l-2 px-4 py-2 font-display text-sm transition-colors',
  bottomTab: 'flex flex-1 flex-col items-center gap-0.5 border-t-2 px-1 py-2 font-display text-[11px] transition-colors',
  sheet: 'flex min-h-14 items-center gap-3 px-5 font-display text-sm transition-colors',
}
const NAV_ACTIVE: Record<NavVariant, string> = {
  sidebar: 'border-accent bg-bg-hover text-accent',
  bottomTab: 'border-accent text-accent',
  sheet: 'bg-bg-hover text-accent',
}
const NAV_IDLE: Record<NavVariant, string> = {
  sidebar: 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary',
  bottomTab: 'border-transparent text-t-muted',
  sheet: 'text-t-muted hover:bg-bg-hover hover:text-t-primary',
}

/**
 * The class string of a navigation entry. The app renders its entries as
 * react-router NavLinks, whose className is a function of the active state -
 * so the styling has to be available without the element.
 */
export function navItemClass(variant: NavVariant, active: boolean, className?: string) {
  return cx(NAV_BASE[variant], active ? NAV_ACTIVE[variant] : NAV_IDLE[variant], className)
}

/** Navigation entry as a plain anchor, for previews and non-router use. */
export function NavItem({ icon, children, active, variant = 'sidebar', className, ...rest }: NavItemProps & HTMLAttributes<HTMLAnchorElement> & { href?: string }) {
  return (
    <a {...rest} aria-current={active ? 'page' : undefined} className={navItemClass(variant, !!active, className)}>
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
    <div className={cx('dialog-body w-full max-w-lg bg-bg-card', className)}>
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
  /** the message; may carry links, so it is rendered inline, not wrapped */
  children: ReactNode
  className?: string
}

/**
 * Centred placeholder for an empty list. The muted colour sits on the panel so
 * a message with an embedded link keeps its accent colour.
 */
export function EmptyState({ label, children, className }: EmptyStateProps) {
  return (
    <Panel className={cx('p-8 text-center text-t-muted', className)}>
      {label && (
        <Badge tone="accent" className="mb-3">
          {label}
        </Badge>
      )}
      {children}
    </Panel>
  )
}

export interface AppShellProps {
  /** the desktop sidebar; the app hides it below `lg` itself */
  sidebar?: ReactNode
  /** the phone's top bar - see `AppBar` */
  bar?: ReactNode
  /** the phone's bottom tab bar - see `TabBar` */
  tabs?: ReactNode
  /** remounts <main> when it changes; the app keys it on the route */
  mainKey?: string
  /** anything that has to live inside the shell but outside <main> */
  before?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * The application frame: sidebar or top bar, the scrolling <main>, and the
 * phone's tab bar as the last row.
 *
 * The bars are ordinary rows, not `fixed` overlays. A fixed element is
 * positioned against the visual viewport, and Firefox for Android does not
 * re-resolve that while its URL bar slides away - the tab bar kept the offset
 * the collapsed toolbar left behind and floated above the real bottom edge.
 * Below `lg` the stylesheet gives `.app-shell` one dynamic viewport of height
 * and makes <main> the scroller, so the rows sit where the box ends.
 */
export function AppShell({ sidebar, bar, tabs, mainKey, before, children, className }: AppShellProps) {
  return (
    <div className={cx('app-shell t-hatch flex min-h-dvh flex-col lg:flex-row', className)}>
      {before}
      {sidebar}
      {bar}
      {/* a flex column, so a page that wants the rest of the screen (the file
          browsers) says `flex-1` instead of subtracting the bars by hand - the
          hand-computed value was 19px off, and those 19px were exactly the
          phantom scroll that toggles a phone's URL bar */}
      <main key={mainKey} className="flex min-w-0 flex-1 flex-col overflow-x-clip p-4 lg:p-6">
        {children}
      </main>
      {tabs}
    </div>
  )
}

export interface AppBarProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode
}

/**
 * The phone's top bar. Padded past the status bar for the installed PWA
 * (`viewport-fit=cover` puts the page under it; in a browser tab the inset is
 * 0). Not sticky: it is the shell's first row and the shell does not scroll.
 */
export function AppBar({ children, className, ...rest }: AppBarProps) {
  return (
    <header
      {...rest}
      className={cx(
        'flex items-center justify-between border-b border-border-subtle bg-bg-secondary px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] lg:hidden',
        className,
      )}
    >
      {children}
    </header>
  )
}

export interface TabBarProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode
}

/**
 * The phone's bottom tab bar: the shell's last row, padded past the gesture
 * area. Its entries are `NavItem`s with `variant="bottomTab"`; a sheet that
 * opens above them is just markup placed before them.
 */
export function TabBar({ children, className, ...rest }: TabBarProps) {
  return (
    <nav
      {...rest}
      className={cx(
        'z-50 shrink-0 border-t border-border-subtle bg-bg-secondary pb-[env(safe-area-inset-bottom)] lg:hidden',
        className,
      )}
    >
      {children}
    </nav>
  )
}
