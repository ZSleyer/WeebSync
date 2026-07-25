import { useEffect, useState } from 'react'
import { api, type Entry, type RenamePair } from '../api'
import type { RenameRule } from './RenameOptions'

// Preview fields: the rename rule plus the sync context the backend needs to
// resolve aired mapping and localized titles exactly like the real transfer.
export type PreviewFields = RenameRule & { remotePath: string; localPath: string }

// How many files of a folder the preview covers. The backend caps the name list
// at the same number, so asking for more would be dropped there anyway.
export const PREVIEW_LIMIT = 100

// useRenamePreview runs the debounced dry-run shown under the rename editor:
// list the remote folder (or take the single file name), send the names through
// /api/rename/names. Shared by the watch dialog and the sync dialog.
//
// It runs without a rename rule too, because the preview is also where the
// target comparison lives: with no rule the names simply stay as they are, and
// classifyTargets still has to say which of them replace a file that is already
// in the target folder. The remote sizes ride along for that comparison.
export function useRenamePreview({
  serverId,
  fields,
  enabled,
  fileName,
  fileSize,
}: {
  serverId: number
  fields: PreviewFields
  enabled: boolean
  fileName?: string // set for a single-file download: skip the folder listing
  fileSize?: number // that file's remote size, for the target comparison
}) {
  const [preview, setPreview] = useState<{ pairs: RenamePair[]; sizes: Record<string, number> } | null>(null)
  const [busy, setBusy] = useState(false)
  const hasRule = (fields.mode === 'template' && !!fields.template) || (fields.mode === 'regex' && !!fields.pattern)

  useEffect(() => {
    if (!enabled || !fields.remotePath) {
      setPreview(null)
      return
    }
    let stale = false // an in-flight preview must not overwrite a newer one
    const run = setTimeout(async () => {
      setBusy(true)
      try {
        const files = fileName
          ? [{ name: fileName, size: fileSize ?? 0 }]
          : (
              await api.get<Entry[]>(`/api/servers/${serverId}/browse?path=${encodeURIComponent(fields.remotePath)}`)
            )
              .filter((e) => !e.isDir)
              .slice(0, PREVIEW_LIMIT)
        const names = files.map((f) => f.name)
        // send the full watch context so the preview applies the aired-order
        // mapping and localized title exactly like the real sync. Without a rule
        // there is nothing to ask for: the name maps to itself.
        const pairs = !names.length
          ? []
          : hasRule
            ? await api.post<RenamePair[]>('/api/rename/names', { names, serverId, ...fields })
            : names.map((n) => ({ old: n, new: n }))
        if (!stale) setPreview({ pairs, sizes: Object.fromEntries(files.map((f) => [f.name, f.size])) })
      } catch {
        if (!stale) setPreview(null) // preview is best-effort; saving reports real errors
      } finally {
        if (!stale) setBusy(false)
      }
    }, 500)
    return () => {
      stale = true
      clearTimeout(run)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    hasRule,
    serverId,
    fileName,
    fileSize,
    fields.remotePath,
    fields.localPath,
    fields.mode,
    fields.template,
    fields.separator,
    fields.titleOverride,
    fields.pattern,
    fields.replacement,
    fields.airedMapping,
    fields.renameProvider,
    fields.renameOrdering,
    fields.renameTitleLang,
    fields.renameSeriesId,
  ])

  return { pairs: preview?.pairs ?? null, sizes: preview?.sizes ?? {}, busy, hasRule }
}
