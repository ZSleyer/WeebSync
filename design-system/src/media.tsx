import type { CSSProperties, ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface ArtProps {
  src: string
  alt?: string
  /** a halftone dot screen over the art, fading in from one side */
  dots?: boolean
  /** the side the dots gather at, as a gradient direction ("to top", "to left") */
  dotsFrom?: string
  /** the CSS object-position of the picture */
  position?: string
  loading?: 'eager' | 'lazy'
  className?: string
}

/**
 * Wide art (a banner, a backdrop) as one layer: the picture and its dot
 * screen together, drawn 5px past its frame on every side so an edge line
 * baked into the source never shows. Put it in a positioned frame that clips
 * (`overflow: hidden`). Inside a button or link the whole layer zooms on
 * hover, dots included, never the picture alone.
 */
export function Art({ src, alt = '', dots, dotsFrom, position, loading, className }: ArtProps) {
  return (
    <span
      className={cx('t-art', className)}
      style={dotsFrom ? ({ '--tone-dir': dotsFrom } as CSSProperties) : undefined}
    >
      <img src={src} alt={alt} loading={loading} style={position ? { objectPosition: position } : undefined} />
      {dots && <i aria-hidden className="t-art-dots" />}
    </span>
  )
}

export type CoverStatusKind = 'live' | 'soon' | 'done' | 'paused'

export interface CoverStatusProps {
  status: CoverStatusKind
  /** the word, in the host's language ("Läuft", "Bald", "Fertig") */
  children: ReactNode
  className?: string
}

/**
 * The status chip on a catalog cover, top left: a dot in the colour code
 * (airing teal, coming soon red, finished and paused neutral) and the word.
 */
export function CoverStatus({ status, children, className }: CoverStatusProps) {
  return (
    <span className={cx('t-cover-chip t-cover-status', className)} data-status={status}>
      {children}
    </span>
  )
}

export interface CoverScoreProps {
  /** the score as shown ("8.4", "84%") */
  value: ReactNode
  /** what the figure is, for a screen reader ("Bewertung") */
  label: string
  className?: string
}

/** The score on a catalog cover, top right, after a star. */
export function CoverScore({ value, label, className }: CoverScoreProps) {
  return (
    <span className={cx('t-cover-chip t-cover-score', className)}>
      <svg aria-hidden viewBox="0 0 24 24">
        <path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 17l-5.4 3 1.2-6-4.5-4.2 6.1-.7z" />
      </svg>
      <span className="sr-only">{label} </span>
      {value}
    </span>
  )
}

/** Clamp a share to 0..1; NaN and missing counts read as nothing. */
export function coverShare(have: number, total: number): number {
  if (!(total > 0) || !(have > 0)) return 0
  return Math.min(1, have / total)
}

export interface CoverBarProps {
  /** 0..1, e.g. the share of episodes on disk */
  value: number
  className?: string
}

/** A thin teal bar along a cover's foot: how much of it is here. Decorative; say the figure in text nearby. */
export function CoverBar({ value, className }: CoverBarProps) {
  return (
    <span aria-hidden className={cx('t-cover-bar', className)} style={{ '--p': value } as CSSProperties}>
      <i />
    </span>
  )
}
