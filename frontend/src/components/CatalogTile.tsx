import { useEffect, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { CoverBar, CoverScore, CoverStatus, coverShare, riseDelay, type CoverStatusKind } from 'fluid-lycoris'
import type { Media } from '../api'
import { coverSet } from '../images'
import { CoverImg } from './SmartImg'
import './catalog.css'

// A title of the catalog grid: the cover with its status, score and the
// share on disk, the name, a facts line (year, format, episodes), and one
// quiet line for what this folder is to the user (Auto-Sync, versions, next
// episode). Studio and next airing slide up over the cover on hover and focus.

/** The cover chip a provider status shows as; undefined when it has none. */
export function coverStatusOf(status: string | undefined): CoverStatusKind | undefined {
  switch (status) {
    case 'RELEASING':
      return 'live'
    case 'NOT_YET_RELEASED':
      return 'soon'
    case 'HIATUS':
      return 'paused'
    case 'FINISHED':
    case 'CANCELLED':
      return 'done'
    default:
      return undefined
  }
}

/** The provider formats with a word of their own; anything else shows as given. */
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC', 'MANGA', 'NOVEL', 'ONE_SHOT'] as const

/** The facts line: "2026 · TV · 12 F.", leaving out what is unknown. */
export function catalogFacts(media: Media, format: (f: string) => string, episodes: (n: number) => string): string {
  return [
    media.seasonYear > 0 ? String(media.seasonYear) : '',
    media.format ? format(media.format) : '',
    media.episodes > 0 ? episodes(media.episodes) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * A view-transition name for a tile from its group key (a media key or a
 * folder path): a custom ident, so the key's slashes and colons are hashed away.
 */
export function vtName(key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return `cat-${h.toString(36)}`
}

export interface CatalogTileProps {
  media: Media
  name: string
  /** the quiet line under the facts */
  sub?: ReactNode
  /** episodes on disk, of the provider's count; no bar without both */
  have?: number
  onOpen: () => void
  /** a right click with a mouse: the tile's actions, as a long press lists them */
  onMenu?: () => void
  selected?: boolean
  /** on the first screen: load at once, the first one with high priority */
  eager?: boolean
  priority?: boolean
}

export function CatalogTile({
  media,
  name,
  sub,
  have = 0,
  onOpen,
  onMenu,
  selected,
  eager,
  priority,
}: CatalogTileProps) {
  const { t, i18n } = useTranslation()
  const status = coverStatusOf(media.status)
  const share = coverShare(have, media.episodes)
  const facts = catalogFacts(
    media,
    (f) => ((FORMATS as readonly string[]).includes(f) ? t(`catalog.format_${f}`) : f),
    (n) => t('catalog.episodesShort', { count: n }),
  )
  const next = media.nextAiringEpisode
  const at = next ? new Date(next.airingAt * 1000) : null
  const peek = [
    media.studios?.[0],
    next && at
      ? t('catalog.peekNext', {
          episode: next.episode,
          day: at.toLocaleDateString(i18n.language, { weekday: 'short' }),
          time: at.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
        })
      : '',
  ].filter(Boolean)
  return (
    <button
      type="button"
      className="ws-cat-tile"
      onClick={onOpen}
      onContextMenu={(e) => {
        if (!onMenu || !matchMedia('(pointer: fine)').matches) return
        // the long-press wrapper's handler only keeps the touch menu away
        e.preventDefault()
        e.stopPropagation()
        onMenu()
      }}
      data-sel={selected || undefined}
    >
      <span className="ws-cat-cover">
        <CoverImg
          set={coverSet(media.coverImage)}
          sizes="(width >= 40rem) 11rem, 33vw"
          tint={media.coverImage?.color}
          title={name}
          className="ws-cat-art"
          eager={eager}
          priority={priority}
        />
        {status && <CoverStatus status={status}>{t(`catalog.status_${status}`)}</CoverStatus>}
        {media.averageScore > 0 && <CoverScore value={media.averageScore} label={t('catalog.score')} />}
        {share > 0 && <CoverBar value={share} />}
        {peek.length > 0 && (
          <span aria-hidden className="ws-cat-peek">
            {peek.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </span>
        )}
      </span>
      <span className="ws-cat-name">{name}</span>
      {facts && <span className="ws-cat-facts">{facts}</span>}
      {sub && <span className="ws-cat-sub">{sub}</span>}
      {share > 0 && <span className="sr-only">{t('catalog.onDisk', { have, of: media.episodes })}</span>}
      {peek.length > 0 && <span className="sr-only">{peek.join(', ')}</span>}
    </button>
  )
}

/** A folder still being matched: a skeleton cover under the folder's name. */
export function CatalogPendingTile({ name }: { name: string }) {
  const { t } = useTranslation()
  return (
    <div className="ws-cat-tile ws-cat-tile--pending" aria-busy="true">
      <span className="ws-cat-cover ws-cat-sk" />
      <span className="ws-cat-name">{name}</span>
      <span className="ws-cat-sub">{t('catalog.matching')}</span>
    </div>
  )
}

const still = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/**
 * The page-entry rise of a grid's tiles, played when `key` changes (entering
 * the catalog, another folder, the data landing), never on a sort or filter
 * change, which morph instead. The tiles wait hidden through the first paint;
 * two frames later every tile is measured in one pass, and the ones on screen
 * rise in one wave from left to right (riseDelay). The tiles carry the scroll
 * reveal too: a CSS rise would fight it, so this runs as its own animation.
 */
export function useTileRise(box: RefObject<HTMLElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const el = box.current
    if (!el || still()) return
    el.setAttribute('data-rise-wait', '')
    return () => {
      el.removeAttribute('data-rise-wait')
    }
  }, [box, key])
  useEffect(() => {
    const el = box.current
    if (!el) return
    let a = 0
    let b = 0
    a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => {
        if (!el.hasAttribute('data-rise-wait')) return
        const cells = [...el.children] as HTMLElement[]
        const boxes = cells.map((c) => c.getBoundingClientRect())
        const w = innerWidth
        const h = innerHeight
        const easing = getComputedStyle(document.documentElement).getPropertyValue('--spring-calm').trim()
        cells.forEach((c, i) => {
          const r = boxes[i]
          if (r.bottom <= 0 || r.top >= h || typeof c.animate !== 'function') return
          const frames = [
            { opacity: 0, translate: '0 14px' },
            { opacity: 1, translate: '0 0' },
          ]
          const timing = { duration: 520, delay: riseDelay(r.left, w), fill: 'backwards' as const }
          try {
            c.animate(frames, { ...timing, easing: easing || 'cubic-bezier(.2,.8,.2,1)' })
          } catch {
            c.animate(frames, timing)
          }
        })
        el.removeAttribute('data-rise-wait')
      })
    })
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [box, key])
}
