import { useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, type ScopeInfo } from '../api'
import { useFailToast } from './toast'

// The three folder view modes, shared by the Remote and Local browsers:
// - classic: plain file list (the default for unmarked folders)
// - catalogOnce: catalog view now, not persisted (session only)
// - catalogPersist: catalog view now AND saved, so the folder reopens in the
//   catalog next time (server-side catalog_scopes mark, shared across users)
export type CatalogViewValue = 'classic' | 'catalogOnce' | 'catalogPersist'

// A folder's scope lives in two caches: the cheap probe below and the catalog
// listing itself. A mark changes both, and a scope rule reaches its sibling
// folders (an alphabet shelf its parent's), so a change clears every folder of
// the server in both, plus the rule list and the dashboard hints. With only
// one of them cleared, pinning read a stale "unmarked" and overwrote a tv mark
// with anime.
export const scopeChanged = (qc: QueryClient, serverId: number) => {
  qc.invalidateQueries({ queryKey: ['catalog', serverId] })
  qc.invalidateQueries({ queryKey: ['catalog-scope', serverId] })
  qc.invalidateQueries({ queryKey: ['scope-rules'] })
  qc.invalidateQueries({ queryKey: ['scope-hints'] })
}

// useScopeInfo is the cheap scope probe (no listing, no matching): the mark,
// and the scope rule a folder could seed or is covered by. Previous data
// carries over while the next probe loads so the view does not flicker.
export function useScopeInfo(serverId: number, path: string) {
  return useQuery<ScopeInfo>({
    queryKey: ['catalog-scope', serverId, path],
    queryFn: () =>
      api.get(`/api/servers/${serverId}/catalog/scope${path ? `?path=${encodeURIComponent('/' + path)}` : ''}`),
    enabled: serverId >= 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

// useCatalogView derives a folder's effective view from its saved catalog scope
// (a marked folder defaults to catalog, everything else to classic) plus a
// per-navigation override, and exposes set() to switch/persist the mode. Works
// for real servers and the local pseudo server (serverId 0).
export function useCatalogView(serverId: number, path: string) {
  const qc = useQueryClient()
  // the transient override remembers the folder it was set for, so a "once"
  // peek does not leak into the next folder or source
  const folder = `${serverId}:${path}`
  const [peek, setPeek] = useState<{ folder: string; view: 'classic' | 'catalog' } | null>(null)
  const override = peek?.folder === folder ? peek.view : null
  const setOverride = (view: 'classic' | 'catalog') => setPeek({ folder, view })

  const { data: scopeInfo } = useScopeInfo(serverId, path)
  const scoped = !!scopeInfo?.scope

  const view: 'classic' | 'catalog' = override ?? (scoped ? 'catalog' : 'classic')
  const value: CatalogViewValue =
    override === 'catalog'
      ? scoped
        ? 'catalogPersist'
        : 'catalogOnce'
      : override === 'classic'
        ? 'classic'
        : scoped
          ? 'catalogPersist'
          : 'classic'

  const fail = useFailToast()
  const putScope = async (kind: string) => {
    try {
      await api.put(`/api/servers/${serverId}/catalog/scope`, { path: path ? '/' + path : '', kind })
      scopeChanged(qc, serverId)
    } catch (e) {
      fail(e)
    }
  }

  const set = async (next: CatalogViewValue) => {
    if (next === 'classic') {
      setOverride('classic')
      // clear the mark: folder is classic again (under a scope rule the server
      // stores "none" instead, or the rule would mark it again at once)
      if (scoped) await putScope('')
    } else if (next === 'catalogOnce') {
      setOverride('catalog') // transient, no persistence
      // unpinning a saved folder drops its mark (a tv/movie/tvdb mark too,
      // same as switching to classic); the override keeps the catalog up
      if (scoped) await putScope('')
    } else {
      setOverride('catalog')
      if (!scoped) await putScope('anime') // persist; keep an existing tv/movie/tvdb mark
    }
  }

  return { view, value, set, scoped }
}
