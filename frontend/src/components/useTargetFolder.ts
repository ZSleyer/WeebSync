import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, type Entry, type RenamePair } from '../api'

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

export type TargetStatus = 'new' | 'replaces' | 'same'

// i18n key per status, so every dialog labels the badges identically
export const TARGET_LABEL: Record<TargetStatus, string> = {
  new: 'rename.targetNew',
  replaces: 'rename.targetReplaces',
  same: 'rename.targetSame',
}

// classifyTargets marks each preview row against what the target folder holds
// today, keyed by the row's original name.
//
// "same" uses the transfer's own skip rule - same name AND same size, see
// transfer.alreadyComplete - so the preview never announces a download the sync
// then silently skips, and never calls an upgrade identical just because the
// file name matches. Keep the two in step: this is a second copy of that rule.
//
// local === null: the folder is not there yet, so everything is new.
// undefined: unknown, and then nothing is marked at all rather than guessed. A
// new name carrying a "/" lands in a subfolder this listing does not cover and
// stays unmarked. An unknown remote size (some FTP listings report 0) counts as
// "replaces": a warning too many beats a wrong "identical".
export function classifyTargets(
  pairs: RenamePair[],
  sizes: Record<string, number>,
  local: Entry[] | null | undefined,
): Record<string, TargetStatus> {
  if (local === undefined) return {}
  const have = new Map((local ?? []).filter((e) => !e.isDir).map((e) => [e.name, e.size]))
  const out: Record<string, TargetStatus> = {}
  for (const p of pairs) {
    if (p.new.includes('/')) continue
    const there = have.get(p.new)
    out[p.old] = there === undefined ? 'new' : there === sizes[p.old] && there > 0 ? 'same' : 'replaces'
  }
  return out
}
