import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

// The content layer of a page: section headings, lists of hairline rows,
// text links. Lists are not boxed in panels; covers are the only cards.

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

/** The two halves of the colour code: red for live, new and the main action, teal for sync and explanations. */
export type CodeTone = 'accent' | 'accent-2'

export interface SectionHeadingProps {
  title: ReactNode
  /** the marker's colour: red by default, teal in sync, rules and files areas */
  tone?: CodeTone
  /** at the right end: a TextLink ("All", "Week") or a count */
  action?: ReactNode
  level?: 2 | 3
  id?: string
  className?: string
  /** makes the title a disclosure button folding the section's body away */
  fold?: { open: boolean; onToggle: () => void; controls: string }
}

/**
 * A section's heading: sentence-case title after a small slanted marker in
 * the colour code, an optional link at the right. The title carries the wipe
 * class, so a page entering with `data-wipe="in"` reveals it (the marker
 * stands at once).
 */
export function SectionHeading({ title, tone = 'accent', action, level = 2, id, className, fold }: SectionHeadingProps) {
  const H = level === 3 ? 'h3' : 'h2'
  return (
    <div className={cx('t-sec-h', className)}>
      <H id={id} className="t-sec-title t-wipe" data-tone={tone === 'accent-2' ? 'accent-2' : undefined}>
        {fold ? (
          <button
            type="button"
            className="t-sec-fold"
            aria-expanded={fold.open}
            aria-controls={fold.controls}
            onClick={fold.onToggle}
          >
            {title}
          </button>
        ) : (
          title
        )}
      </H>
      {action}
    </div>
  )
}

type LinkOwn = { tone?: CodeTone; className?: string; children: ReactNode }
export type TextLinkProps =
  | (LinkOwn & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string })
  | (LinkOwn & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined })

/**
 * A text link in the colour code, no underline at rest. With `href` it is a
 * link, without one a button; either way the padding gives it a tall target.
 */
export function TextLink(props: TextLinkProps) {
  const { tone = 'accent', className, ...rest } = props
  const cls = cx('t-link', tone === 'accent-2' && 't-link--2', className)
  if (typeof rest.href === 'string') {
    return <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} className={cls} />
  }
  return <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} className={cls} />
}

export interface RowsProps extends HTMLAttributes<HTMLUListElement> {
  /** a denser list: 52px rows (agenda, files) instead of 60px */
  dense?: boolean
}

/** A list of hairline rows. No panel around it: the lines are the structure. */
export function Rows({ dense, className, ...rest }: RowsProps) {
  return <ul {...rest} className={cx('t-rows', dense && 't-rows--dense', className)} />
}

export type GlyphTone = 'err' | 'warn' | 'ok' | 'accent' | 'accent-2'

export interface RowProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title'> {
  /** a 28px icon box at the start, tinted by `tone` */
  leading?: ReactNode
  tone?: GlyphTone
  title?: ReactNode
  /** the quiet second line */
  sub?: ReactNode
  /** at the end: a RowAction, a figure, a switch */
  trailing?: ReactNode
  /** replaces the title block: the row's own layout */
  children?: ReactNode
}

/**
 * One row of a hairline list: leading glyph, a title with a quiet line under
 * it, and something at the end. The inner box carries the surface colour, so
 * a swipe ground can sit under it.
 */
export function Row({ leading, tone, title, sub, trailing, children, className, ...rest }: RowProps) {
  return (
    <li {...rest} className={cx('t-row', className)}>
      <div className="t-row-in">
        {leading !== undefined && (
          <span aria-hidden className="t-glyph" data-tone={tone}>
            {leading}
          </span>
        )}
        {children ?? (
          <div className="t-row-t">
            <strong>{title}</strong>
            {sub !== undefined && <span>{sub}</span>}
          </div>
        )}
        {trailing}
      </div>
    </li>
  )
}

export interface RowActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: CodeTone
}

/** The text button at the end of a row: its padding makes it a 44px target. */
export function RowAction({ tone = 'accent', className, ...rest }: RowActionProps) {
  return <button type="button" {...rest} className={cx('t-row-act', tone === 'accent-2' && 't-row-act--2', className)} />
}

/** A key of the keyboard, as in a shortcut hint: an outlined cap in the mono face. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd {...rest} className={cx('t-kbd', className)} />
}
