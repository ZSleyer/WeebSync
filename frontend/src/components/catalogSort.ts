import { useState } from 'react'
import { mediaTitle, type CatalogItem, type Media } from '../api'

// Sort orders for the catalog grid, mirroring AniChart's dropdown so the
// vocabulary is the one users of that site already know.
export const CATALOG_SORTS = [
  'title',
  'nextAiring',
  'popularity',
  'score',
  'studio',
  'startDate',
  'endDate',
  'added',
] as const

export type CatalogSort = (typeof CATALOG_SORTS)[number]

// A sortable card: the folders bundled under one match, plus that match's
// metadata (absent while a folder is still unmatched or pending).
export interface SortableGroup {
  media?: Media
  items: CatalogItem[]
}

const title = (g: SortableGroup) => mediaTitle(g.media, g.items[0]?.entry.name ?? '').toLocaleLowerCase()

// added is the folder's own timestamp: the newest of the bundled versions, so
// a title with a fresh release does not sort by its oldest folder.
const added = (g: SortableGroup) =>
  g.items.reduce((max, i) => Math.max(max, Date.parse(i.entry.modTime) || 0), 0)

// asc flips a value for the descending comparator below, for the fields read
// oldest/soonest first. 0 stays 0 so it still counts as missing.
const asc = (v: number | undefined) => (v ? -v : null)

// keys return a number to order by descending, or null when the field is
// missing - those groups always land last, whatever the order.
const keys: Record<Exclude<CatalogSort, 'title' | 'studio'>, (g: SortableGroup) => number | null> = {
  nextAiring: (g) => asc(g.media?.nextAiringEpisode?.airingAt),
  popularity: (g) => g.media?.popularity || null,
  score: (g) => g.media?.averageScore || null,
  startDate: (g) => asc(g.media?.startDate), // chronological, like a timeline
  endDate: (g) => asc(g.media?.endDate),
  added: (g) => added(g) || null, // newest folder first
}

// sortGroups orders a copy of groups. Ties fall back to the title, so the grid
// never reshuffles between renders of the same data.
export function sortGroups<T extends SortableGroup>(groups: T[], sort: CatalogSort): T[] {
  const byTitle = (a: T, b: T) => title(a).localeCompare(title(b))
  if (sort === 'title') return [...groups].sort(byTitle)
  if (sort === 'studio')
    return [...groups].sort((a, b) => {
      const [x, y] = [a.media?.studios?.[0] ?? '', b.media?.studios?.[0] ?? '']
      if (!x !== !y) return x ? -1 : 1
      return x.localeCompare(y) || byTitle(a, b)
    })
  const key = keys[sort]
  return [...groups].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    if (x === null || y === null) return x === y ? byTitle(a, b) : x === null ? 1 : -1
    return y - x || byTitle(a, b)
  })
}

// useCatalogSort keeps the chosen order for the session and across reloads:
// it is a viewing preference, not folder state, so localStorage is enough.
// Unset, it opens on popularity, the same default AniChart uses.
export function useCatalogSort() {
  const [sort, setSort] = useState<CatalogSort>(() => {
    const saved = localStorage.getItem(SORT_KEY)
    return CATALOG_SORTS.includes(saved as CatalogSort) ? (saved as CatalogSort) : 'popularity'
  })
  return [
    sort,
    (next: CatalogSort) => {
      localStorage.setItem(SORT_KEY, next)
      setSort(next)
    },
  ] as const
}

const SORT_KEY = 'catalogSort'
