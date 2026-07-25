import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, type Entry } from '../api'

// syncTargetDir is the folder a sync actually writes into: with the subfolder
// option a directory sync creates a folder named after the remote one, without
// it the files land straight in localPath. Mirrors the flat handling of
// transfer.Enqueue, so what the dialog checks is what the transfer uses.
export function syncTargetDir(localPath: string, remotePath: string, subfolder: boolean): string {
  const base = remotePath.split('/').filter(Boolean).pop() ?? ''
  return subfolder && base ? [localPath, base].filter(Boolean).join('/') : localPath
}

// useTargetFolder lists the folder a sync would write into. entries === null
// means it is not there yet (the download creates it on the way), undefined
// means unknown - outside the roots, or the listing failed - and then the UI
// stays quiet instead of guessing.
//
// Own query key: PathInput caches plain listings under ['local', parent] and
// defaults them to [], which only covers undefined - a cached null would reach
// its filter and throw.
export function useTargetFolder(dir: string, enabled = true) {
  // the path field changes on every keystroke, and each value is its own query
  // key - without this every half-typed folder would be one request
  const [settled, setSettled] = useState(dir)
  useEffect(() => {
    const id = setTimeout(() => setSettled(dir), 400)
    return () => clearTimeout(id)
  }, [dir])

  const { data } = useQuery<Entry[] | null>({
    queryKey: ['local-target', settled],
    queryFn: async () => {
      try {
        return await api.get<Entry[]>(`/api/browse/local?path=${encodeURIComponent(settled.replace(/^\/+/, ''))}`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null // not there yet
        throw e
      }
    },
    enabled: enabled && !!settled,
    retry: false,
    staleTime: 30_000,
  })
  return { entries: data, missing: data === null }
}
