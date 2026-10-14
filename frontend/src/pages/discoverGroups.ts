// The sections of Entdecken as data: their groups, icons and counts. Apart
// from the page so the command palette, which lists them on every screen,
// does not pull the whole page into the first chunk.
import {
  Bookmark,
  Bot,
  CircleArrowUp,
  CircleDashed,
  Copy,
  EyeOff,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { api, type DismissedItem, type SuggestionsResponse } from '../api'
import { useAiStatus, usePersistedQuery } from '../hooks'
import { slugOf, type DiscoverSection } from '../discoverRoutes'
import type { SectionGroup } from '../components/SectionNav'

export type ListSection = Exclude<DiscoverSection, 'assistant' | 'ignored'>

export const useSuggestions = () =>
  usePersistedQuery<SuggestionsResponse>('suggestions', () => api.get('/api/suggestions'), {
    refetchInterval: (q) => (q.state.data?.building ? 4000 : false),
  })
export const useDismissed = () =>
  usePersistedQuery<DismissedItem[]>('dismissed', () => api.get('/api/suggestions/dismissed'))

// the sections in their groups, in the mock's order; the assistant only
// with a configured endpoint (the page itself explains when opened directly)
export const LAYOUT: { label: string; items: [DiscoverSection, string, LucideIcon][] }[] = [
  {
    label: 'suggestions.groupDiscover',
    items: [
      ['watchlist', 'suggestions.tabWatchlist', Bookmark],
      ['recommended', 'suggestions.tabRecommended', Sparkles],
      ['trending', 'suggestions.tabTrending', TrendingUp],
    ],
  },
  {
    label: 'suggestions.groupLibrary',
    items: [
      ['upgrades', 'suggestions.tabUpgrades', CircleArrowUp],
      ['incomplete', 'suggestions.tabIncomplete', CircleDashed],
      ['duplicates', 'suggestions.tabDuplicates', Copy],
    ],
  },
  {
    label: 'discover.groupAsk',
    items: [
      ['assistant', 'nav.assistant', Bot],
      ['ignored', 'suggestions.ignored', EyeOff],
    ],
  },
]

/** Every section with its count. The counts come from the blob, stale ones included, and show 0. */
export function useCounts(): Partial<Record<DiscoverSection, number>> {
  const { data } = useSuggestions()
  const { data: dismissed } = useDismissed()
  const n = (k: ListSection) => (data ? (data[k]?.length ?? 0) : undefined)
  return {
    watchlist: n('watchlist'),
    recommended: n('recommended'),
    trending: n('trending'),
    upgrades: n('upgrades'),
    incomplete: n('incomplete'),
    duplicates: n('duplicates'),
    ignored: dismissed?.length,
  }
}

/** The sections as the command palette lists them: groups of routes with icons and counts. */
export function useSuggestionGroups(): SectionGroup[] {
  const { data: ai } = useAiStatus()
  const counts = useCounts()
  return LAYOUT.map((g) => ({
    label: g.label,
    items: g.items
      .filter(([id]) => id !== 'assistant' || ai?.configured)
      .map(([id, key, icon]) => ({ to: slugOf(id), key, icon, hint: `suggestions.hub.${id}`, count: counts[id] })),
  })).filter((g) => g.items.length > 0)
}
