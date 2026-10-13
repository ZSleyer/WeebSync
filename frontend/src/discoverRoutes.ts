// Entdecken lives under /discover, one address per section. The sections keep
// their English ids inside the app (they are the buckets of /api/suggestions);
// the address carries a German slug, as the page names them. The old
// /suggestions addresses (bookmarks, push links, the palette's history) are
// translated here, so every place that links a section goes through this.

export const DISCOVER_BASE = '/discover'

export const DISCOVER_SECTIONS = [
  { id: 'watchlist', slug: 'merkliste' },
  { id: 'recommended', slug: 'empfohlen' },
  { id: 'trending', slug: 'trending' },
  { id: 'upgrades', slug: 'upgrades' },
  { id: 'incomplete', slug: 'unvollstaendig' },
  { id: 'duplicates', slug: 'duplikate' },
  { id: 'assistant', slug: 'assistent' },
  { id: 'ignored', slug: 'ausgeblendet' },
] as const

export type DiscoverSection = (typeof DISCOVER_SECTIONS)[number]['id']
export type DiscoverSlug = (typeof DISCOVER_SECTIONS)[number]['slug']

/** The slug of a section id, e.g. `watchlist` -> `merkliste`. */
export const slugOf = (id: DiscoverSection): DiscoverSlug => DISCOVER_SECTIONS.find((s) => s.id === id)!.slug

/** The section a slug (or an old English id) names, if any. */
export function sectionOf(part: string | undefined | null): DiscoverSection | undefined {
  if (!part) return undefined
  return DISCOVER_SECTIONS.find((s) => s.slug === part || s.id === part)?.id
}

/** The address of a section. */
export const discoverPath = (id: DiscoverSection) => `${DISCOVER_BASE}/${slugOf(id)}`

/**
 * Where an old address of the same screen leads now: `/suggestions`,
 * `/suggestions/<id>` and `/suggestions?tab=<id>` land on /discover, the rest
 * of the query and the hash ride along. Anything else comes back unchanged.
 */
export function legacyDiscoverPath(path: string): string {
  const m = /^\/suggestions(?:\/([^/?#]*))?\/?([?#].*)?$/.exec(path)
  // deeper than a section never existed: the page itself
  if (!m) return /^\/suggestions\//.test(path) ? DISCOVER_BASE : path
  const [, part, rest = ''] = m
  const [query, hash = ''] = rest.startsWith('#') ? ['', rest.slice(1)] : rest.slice(1).split('#')
  const params = new URLSearchParams(query)
  const id = sectionOf(part) ?? sectionOf(params.get('tab'))
  params.delete('tab')
  const qs = params.toString()
  return `${id ? discoverPath(id) : DISCOVER_BASE}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`
}

// the section Entdecken opens on, per browser: where the user was last time
const LAST_KEY = 'ws-dsec'
const DEFAULT: DiscoverSection = 'watchlist'

/** The section the user had open last on this browser, Merkliste at first. */
export function lastSection(): DiscoverSection {
  try {
    return sectionOf(localStorage.getItem(LAST_KEY)) ?? DEFAULT
  } catch {
    return DEFAULT
  }
}

/** Remembers the open section for the next visit. */
export function rememberSection(id: DiscoverSection) {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // storage off: the next visit opens on the default
  }
}
