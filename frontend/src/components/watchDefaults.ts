import { useQuery } from '@tanstack/react-query'
import { api, type WatchDefaults } from '../api'
import type { WatchFields } from './WatchDialog'
import { pinSeason, seasonInPath } from './useTargetFolder'

export type WatchKind = keyof WatchDefaults['kinds']

// The user's auto-sync defaults (settings › auto-sync defaults), cached for
// the session: every dialog that opens without a plan of its own reads them.
export function useWatchDefaults() {
  return useQuery<WatchDefaults>({ queryKey: ['watch-defaults'], queryFn: () => api.get('/api/auth/watch-defaults'), staleTime: 5 * 60_000 })
}

// FolderTarget is what the catalog knows about a remote folder: its kind and
// show title, the season it holds and that season's folder, and the show root
// when the library already holds another season of the show.
export interface FolderTarget {
  kind?: string
  title?: string
  season?: number
  /** "Season 02", or spelled like the library's sibling season; absent for a movie or a whole-show folder */
  seasonFolder?: string
  /** the show root the library holds; the sync goes there, not to the kind's default */
  libraryDir?: string
}

// What the catalog knows about a remote folder, from the same endpoint as the
// defaults; anime series when unmatched.
export function useFolderKind(serverId: number, path: string | undefined) {
  return useQuery<FolderTarget>({
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

// applyDefaults mirrors the backend's apply. The folder comes first: the
// library's own show root when it holds the show, else the kind's default -
// and only when no folder was chosen yet (a plan that found the library
// folder keeps it); then the kind's naming and every common field still
// blank. The season goes into the path and the template together, or into
// neither (seasonInPath).
export function applyDefaults(f: WatchFields, kind: string | undefined, d: WatchDefaults | undefined, folder?: FolderTarget): WatchFields {
  const out = { ...f }
  const k = d?.kinds[(kind as WatchKind) ?? 'anime-series'] ?? d?.kinds['anime-series']
  if (k && !out.template) {
    out.template = k.template
    out.separator = k.separator
  }
  const inPath = seasonInPath(out.template, out.airedMapping || !!d?.common.airedMapping)
  if (!out.localPath && folder?.libraryDir) {
    out.localPath = inPath && folder.seasonFolder ? `${folder.libraryDir}/${folder.seasonFolder}` : folder.libraryDir
    out.subfolder = false
    out.subfolderSource = 'none'
  } else if (k && !out.localPath && k.localPath) {
    out.localPath = k.localPath
    out.subfolder = k.subfolder
    // the choice travels, the folder is named where the series is known
    out.subfolderSource = k.subfolderSource
    out.subfolderSeparator = k.subfolderSeparator
  }
  if (inPath && folder?.season) {
    out.seasonFolder = folder.seasonFolder
    out.template = pinSeason(out.template, folder.season)
  }
  if (!d) return out
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
