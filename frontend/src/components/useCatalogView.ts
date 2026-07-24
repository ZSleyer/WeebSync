import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'

// The three folder view modes, shared by the Remote and Local browsers:
// - classic: plain file list (the default for unmarked folders)
// - catalogOnce: catalog view now, not persisted (session only)
// - catalogPersist: catalog view now AND saved, so the folder reopens in the
//   catalog next time (server-side catalog_scopes mark, shared across users)
export type CatalogViewValue = 'classic' | 'catalogOnce' | 'catalogPersist'

// useCatalogView derives a folder's effective view from its saved catalog scope
// (a marked folder defaults to catalog, everything else to classic) plus a
// per-navigation override, and exposes set() to switch/persist the mode. Works
// for real servers and the local pseudo server (serverId 0).
export function useCatalogView(serverId: number, path: string) {
  const qc = useQueryClient()
  const [override, setOverride] = useState<'classic' | 'catalog' | null>(null)

  // reset the transient override whenever the folder or source changes, so a
  // "once" peek does not leak into the next folder
  useEffect(() => {
    setOverride(null)
  }, [serverId, path])

  // cheap scope probe (no listing/matching); previous data carries over while
  // the next probe loads so the view does not flicker on navigation
  const { data: scopeInfo } = useQuery<{ scope: string }>({
    queryKey: ['catalog-scope', serverId, path],
    queryFn: () => api.get(`/api/servers/${serverId}/catalog/scope${path ? `?path=${encodeURIComponent('/' + path)}` : ''}`),
    enabled: serverId >= 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
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

  const putScope = async (kind: string) => {
    await api.put(`/api/servers/${serverId}/catalog/scope`, { path: path ? '/' + path : '', kind })
    qc.invalidateQueries({ queryKey: ['catalog-scope', serverId, path] })
  }

  const set = async (next: CatalogViewValue) => {
    if (next === 'classic') {
      setOverride('classic')
      if (scoped) await putScope('') // clear the mark: folder is classic again
    } else if (next === 'catalogOnce') {
      setOverride('catalog') // transient, no persistence
    } else {
      setOverride('catalog')
      if (!scoped) await putScope('anime') // persist; keep an existing tv/movie/tvdb mark
    }
  }

  return { view, value, set, scoped }
}
