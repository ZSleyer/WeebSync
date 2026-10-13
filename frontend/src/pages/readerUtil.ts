// Pure pieces of the reader, kept apart so they can be tested without a DOM.

/**
 * The volume number a book's file name carries ("Vol. 05", "Band 12",
 * "One Piece 105.cbz"), or null. An explicit marker wins; a lone number in
 * the name is the fallback, never a resolution or a year in brackets.
 */
export function volumeOf(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '')
  const marked = /(?:\b(?:vol(?:ume)?|band|bd|tome|tomo)\.?\s*|\bv)(\d{1,4})\b/i.exec(base)
  if (marked) return Number(marked[1])
  // without brackets: "[Group] Title - 05 [1080p]" keeps only "Title - 05"
  const bare = base.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  const lone = [...bare.matchAll(/(?:^|[\s_-])(\d{1,4})(?=[\s_-]|$)/g)].map((m) => Number(m[1]))
  return lone.length ? lone[lone.length - 1] : null
}

/** What a horizontal drag does when it is let go: turn to the left or right page, or spring back. */
export type DragOutcome = 'left' | 'right' | null

/**
 * Whether a drag turns the page: past a fifth of the width, or flicked fast
 * enough (0.4 px/ms). A drag to the left brings in the page on the right.
 */
export function dragOutcome(dx: number, ms: number, width: number): DragOutcome {
  if (!(width > 0) || dx === 0) return null
  const fast = ms > 0 && Math.abs(dx) / ms >= 0.4
  if (Math.abs(dx) < width * 0.2 && !fast) return null
  return dx < 0 ? 'right' : 'left'
}

/** The reader's backgrounds; dark is the default for everything but an EPUB that asks otherwise. */
export const READER_THEMES = ['dark', 'sepia', 'light'] as const
export type ReaderTheme = (typeof READER_THEMES)[number]

/** The look an EPUB chapter is asked for: the server writes it into the chapter (see reader_look.go). */
export interface BookLook {
  size: number
  lead: number
  theme: ReaderTheme
  font: 'serif' | 'sans'
}

/** The chapter's address with the look in its query. */
export function lookedUrl(url: string, look: BookLook): string {
  const q = new URLSearchParams({
    look: '1',
    size: String(look.size),
    lead: look.lead.toFixed(1),
    theme: look.theme,
    font: look.font,
  })
  return `${url}${url.includes('?') ? '&' : '?'}${q}`
}

/** A stored size or line height back inside its range, so an old or hand-edited value never breaks the request. */
export const clampTo = (v: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt
