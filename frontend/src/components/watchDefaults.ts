import { useQuery } from '@tanstack/react-query'
import { api, type WatchDefaults } from '../api'
import type { WatchFields } from './WatchDialog'

export type WatchKind = keyof WatchDefaults['kinds']

// The user's auto-sync defaults (settings › auto-sync defaults), cached for
// the session: every dialog that opens without a plan of its own reads them.
export function useWatchDefaults() {
  return useQuery<WatchDefaults>({ queryKey: ['watch-defaults'], queryFn: () => api.get('/api/auth/watch-defaults'), staleTime: 5 * 60_000 })
}

// The media kind the catalog matched a remote folder to, from the same
// endpoint; anime series when unmatched.
export function useFolderKind(serverId: number, path: string | undefined) {
  return useQuery<{ kind?: string; title?: string }>({
    queryKey: ['watch-defaults', serverId, path],
    queryFn: () => api.get(`/api/auth/watch-defaults?serverId=${serverId}&path=${encodeURIComponent(path ?? '')}`),
    enabled: !!path,
    staleTime: 5 * 60_000,
  })
}

// suggestionKind maps a suggestion's grouping category onto a defaults kind.
export function suggestionKind(category: string): WatchKind {
  if (category === 'anime-movie') return 'anime-movie'
  if (category === 'anime-tv') return 'anime-series'
  if (category.endsWith('movie')) return 'movie'
  if (category === 'anime-series' || category === 'series') return category
  return 'series'
}

// applyDefaults mirrors the backend's apply: the kind's folder and naming
// only when no folder was chosen yet (a plan that found the library folder
// keeps it), then every common field that is still blank.
export function applyDefaults(f: WatchFields, kind: string | undefined, d: WatchDefaults | undefined): WatchFields {
  if (!d) return f
  const out = { ...f }
  const k = d.kinds[(kind as WatchKind) ?? 'anime-series'] ?? d.kinds['anime-series']
  if (k && !out.localPath && k.localPath) {
    out.localPath = k.localPath
    out.subfolder = k.subfolder
    // the choice travels, the folder is named where the series is known
    out.subfolderSource = k.subfolderSource
    out.subfolderSeparator = k.subfolderSeparator
    if (!out.template) {
      out.template = k.template
      out.separator = k.separator
    }
  }
  const c = d.common
  const fill = <K extends keyof WatchFields & keyof WatchDefaults['common']>(key: K) => {
    if (!out[key] && c[key]) (out as Record<K, WatchFields[K]>)[key] = c[key] as WatchFields[K]
  }
  fill('renameProvider')
  fill('renameOrdering')
  fill('renameTitleLang')
  fill('wantDub')
  fill('wantSub')
  fill('plexAudioLang')
  fill('plexSubLang')
  if (c.airedMapping) out.airedMapping = true
  return out
}
