import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { NavLink } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { enterPage } from 'fluid-lycoris'
import { api } from '../api'
import { useToast, useFailToast } from '../components/toast'
import { CoverImg } from '../components/SmartImg'
import type { ImgSet } from '../images'
import { DISCOVER_BASE, type DiscoverSection } from '../discoverRoutes'

// The parts every Entdecken section is built from: the sections menu, the
// head, the group, the suggestion row, the empty line and the loading rows.

export interface DiscoverNavItem {
  id: DiscoverSection | 'hub'
  to: string
  label: string
  count?: number
}

export interface DiscoverNavGroup {
  label: string
  items: DiscoverNavItem[]
}

/**
 * The sections menu: on a phone one sticky strip that scrolls sideways, the
 * open section turned to the middle; from 64rem a column with the group names
 * and the counts at the right. A change replaces the history entry, so the
 * back gesture leaves the page instead of walking back through the sections.
 */
export function DiscoverNav({
  label,
  groups,
  current,
}: {
  label: string
  groups: DiscoverNavGroup[]
  current?: string
}) {
  const { i18n } = useTranslation()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="page"]')
    // only the strip scrolls: the column has nothing to turn to
    if (el && ref.current && ref.current.scrollWidth > ref.current.clientWidth) {
      // sideways on the strip itself: scrollIntoView would move the page too
      const nav = ref.current
      nav.scrollTo?.({
        left:
          nav.scrollLeft +
          el.getBoundingClientRect().left -
          nav.getBoundingClientRect().left -
          (nav.clientWidth - el.offsetWidth) / 2,
        behavior: 'smooth',
      })
    }
  }, [current])
  return (
    <nav ref={ref} className="dc-nav" aria-label={label}>
      {groups.map((g) => [
        g.label && (
          <p key={`g-${g.label}`} className="dc-g" aria-hidden>
            {g.label}
          </p>
        ),
        // the overview is /discover itself: current only there, not under it
        ...g.items.map((i) => (
          <NavLink key={i.id} to={i.to ? `${DISCOVER_BASE}/${i.to}` : DISCOVER_BASE} end={!i.to} replace>
            <span>{i.label}</span>
            {i.count != null && <span className="dc-count">{i.count.toLocaleString(i18n.language)}</span>}
          </NavLink>
        )),
      ])}
    </nav>
  )
}

/** A section's head: the title (wiped in on entry, the text only) and a quiet line under it. */
export function DiscoverHead({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="dc-head">
      <div className="dc-head-row">
        <h2>
          <span className="t-wipe">{title}</span>
        </h2>
        {action}
      </div>
      {sub && <p>{sub}</p>}
    </div>
  )
}

/** Nothing to list: a bold line and an optional quiet one. */
export function EmptyNote({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="dc-empty" role="status">
      <b>{title}</b>
      {sub && <span>{sub}</span>}
    </div>
  )
}

/** Rows of the real height while the lists load, so nothing below jumps. */
export function SkeletonRows({ n = 6 }: { n?: number }) {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy="true" aria-label={t('app.loading')}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="dc-sk" aria-hidden>
          <i />
          <span>
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A group of rows under a hairline: a 48px summary with its count and a turning chevron. */
export function DiscoverGroup({
  title,
  count,
  open = true,
  children,
}: {
  title: ReactNode
  count: number
  open?: boolean
  children: ReactNode
}) {
  const { i18n } = useTranslation()
  return (
    <details className="dc-grp" open={open}>
      <summary>
        <span>{title}</span>
        <span className="dc-count">{count.toLocaleString(i18n.language)}</span>
      </summary>
      {children}
    </details>
  )
}

export interface SugRowProps {
  title: string
  /** "Staffel 2" after the title, quiet */
  season?: string
  meta?: string
  cover?: ImgSet
  coverTint?: string | null
  /** opens the series card from the cover and the title */
  onOpen?: () => void
  openLabel?: string
  /** the lines under the meta line and the actions row */
  children?: ReactNode
  /** the first rows of a list load their covers at once */
  eager?: boolean
}

/**
 * One suggestion: a 52px cover, the title with the season after it, the meta
 * line, and whatever the section adds under it (why, the server copy, the
 * actions). A hairline row, no card.
 */
export function SugRow({ title, season, meta, cover, coverTint, onOpen, openLabel, children, eager }: SugRowProps) {
  const art = <CoverImg set={cover} tint={coverTint} title={title} sizes="3.25rem" eager={eager} className="sg-art" />
  return (
    <li className="t-row sg">
      <div className="t-row-in">
        {onOpen ? (
          <button type="button" className="sg-cov" onClick={onOpen} aria-hidden tabIndex={-1}>
            {art}
          </button>
        ) : (
          <span className="sg-cov">{art}</span>
        )}
        <span className="sg-t">
          <strong>
            {onOpen ? (
              <button type="button" onClick={onOpen} aria-label={openLabel}>
                {title}
              </button>
            ) : (
              title
            )}
            {season && <span className="sg-season"> {season}</span>}
          </strong>
          {meta && <span className="sg-meta">{meta}</span>}
          {children}
        </span>
      </div>
    </li>
  )
}

const still = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/**
 * Slides a row out to the left (180ms, ease-in) before it is taken off the
 * list; at once when motion is reduced or the row is gone already.
 */
export function slideOut(el: Element | null | undefined): Promise<void> {
  const row = el?.closest('li')
  if (!row || still() || typeof row.animate !== 'function') return Promise.resolve()
  return row
    .animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateX(-24px)' },
      ],
      { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
    )
    .finished.then(
      () => undefined,
      () => undefined,
    )
}

export type DismissKind = 'suggestion' | 'upgrade' | 'duplicate'

/**
 * Hiding a suggestion, an upgrade or a duplicate: the row slides out and is
 * gone, the toast's undo brings it back. Cover and section ride along, so the
 * restore list can show them.
 */
export function useDismiss() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useFailToast()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
  }
  return async (
    item: { kind: DismissKind; refKey: string; label: string; cover?: string; section: DiscoverSection },
    from?: Element | null,
  ) => {
    try {
      await api.post('/api/suggestions/dismiss', item)
      await slideOut(from)
      refresh()
      toast({
        message: t('suggestions.hidden', { name: item.label }),
        undo: () =>
          void api.del('/api/suggestions/dismiss', { kind: item.kind, refKey: item.refKey }).then(refresh, fail),
      })
    } catch (e) {
      refresh()
      fail(e)
    }
  }
}

/**
 * The rise for rows that arrive after the loading rows: the route's own
 * entry played over the skeleton, so the list plays it once more when it
 * lands. Not on a mount that already has the data (the route plays then).
 */
export function useLateRise(ref: { current: HTMLElement | null }, ready: boolean) {
  const was = useRef(ready)
  useLayoutEffect(() => {
    if (was.current || !ready) {
      was.current = ready
      return
    }
    was.current = true
    const el = ref.current
    if (!el) return
    let id: ReturnType<typeof setTimeout> | undefined
    const f = requestAnimationFrame(() => {
      enterPage(el)
      id = setTimeout(() => el.removeAttribute('data-wipe'), 1200)
    })
    return () => {
      cancelAnimationFrame(f)
      clearTimeout(id)
    }
  }, [ref, ready])
}
