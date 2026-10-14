import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Schemas } from './api.gen'

// The linked AniList account and what the user lets WeebSync change on it.
// One query for the whole app: the settings, the suggestions, the series
// page and the thread reader all read the same answer.

export type AnilistMe = Schemas['api.anilistMeResponse']

export const ANILIST_ME_KEY = ['anilist-me']

/** Where the AniList connect and the write switches live. */
export const ANILIST_SETTINGS = '/settings/integrations#anilist'

export function useAnilistMe() {
  return useQuery({
    queryKey: ANILIST_ME_KEY,
    queryFn: () => api.get<AnilistMe>('/api/anilist/me'),
    staleTime: 60_000,
  })
}
