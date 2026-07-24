import { useEffect, useState } from 'react'
import { api, type Entry, type RenamePair } from '../api'
import type { RenameRule } from './RenameOptions'

// Preview fields: the rename rule plus the sync context the backend needs to
// resolve aired mapping and localized titles exactly like the real transfer.
export type PreviewFields = RenameRule & { remotePath: string; localPath: string }

// useRenamePreview runs the debounced dry-run shown under the rename editor:
// list the remote folder (or take the single file name), send up to 8 names
// through /api/rename/names. Shared by the watch dialog and the sync dialog.
export function useRenamePreview({
  serverId,
  fields,
  enabled,
  fileName,
}: {
  serverId: number
  fields: PreviewFields
  enabled: boolean
  fileName?: string // set for a single-file download: skip the folder listing
}) {
  const [pairs, setPairs] = useState<RenamePair[] | null>(null)
  const [busy, setBusy] = useState(false)
  const hasRule = (fields.mode === 'template' && !!fields.template) || (fields.mode === 'regex' && !!fields.pattern)

  useEffect(() => {
    if (!enabled || !hasRule || !fields.remotePath) {
      setPairs(null)
      return
    }
    let stale = false // an in-flight preview must not overwrite a newer one
    const run = setTimeout(async () => {
      setBusy(true)
      try {
        const names = fileName
          ? [fileName]
          : (
              await api.get<Entry[]>(`/api/servers/${serverId}/browse?path=${encodeURIComponent(fields.remotePath)}`)
            )
              .filter((e) => !e.isDir)
              .map((e) => e.name)
              .slice(0, 8)
        // send the full watch context so the preview applies the aired-order
        // mapping and localized title exactly like the real sync
        const next = names.length
          ? await api.post<RenamePair[]>('/api/rename/names', { names, serverId, ...fields })
          : []
        if (!stale) setPairs(next)
      } catch {
        if (!stale) setPairs(null) // preview is best-effort; saving reports real errors
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

  return { pairs, busy, hasRule }
}
