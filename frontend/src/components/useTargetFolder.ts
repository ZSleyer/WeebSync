import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, type Entry, type RenamePair, type SubfolderMode } from '../api'

// syncTargetDir is the folder a sync actually writes into: with the subfolder
// option a directory sync creates a folder named after the remote one, without
// it the files land straight in localPath. Mirrors the flat handling of
// transfer.Enqueue, so what the dialog checks is what the transfer uses.
export function syncTargetDir(localPath: string, remotePath: string, subfolder: boolean): string {
  const base = remotePath.split('/').filter(Boolean).pop() ?? ''
  return subfolder && base ? [localPath, base].filter(Boolean).join('/') : localPath
}

// titleFolder is the folder name a "by series title" subfolder gets. Same
// order as the rename engine (sanitize the segment, then replace spaces, then
// trim " ."), so a folder built here is spelled like the files that land in it.
export function titleFolder(title: string, separator: string): string {
  let seg = title.replace(/[/\\:*?"<>|]/g, '')
  if (separator && separator !== ' ') seg = seg.split(' ').join(separator)
  return seg.replace(/^[ .]+|[ .]+$/g, '')
}

// seasonInPath says whether the season folder belongs in the target path. A
// template that carries a "/" lays the folders out itself (an aired-order
// "Season {season:02}/..."), and so does aired mapping, whose season varies
// per file: a Season folder in the path would nest under either. Same rule
// as the backend's seasonInPath.
export function seasonInPath(template: string, airedMapping: boolean): boolean {
  return !template.includes('/') && !airedMapping
}

// pinSeason writes the season into a template's {season} tokens, keeping each
// token's padding - the rename engine reads the season off the file name and
// falls back to 1, which in a "Season 02" folder names the files S01E01.
export function pinSeason(template: string, season: number): string {
  return template.replace(/\{season(?::0?(\d+))?\}/g, (_, w?: string) => String(season).padStart(w ? Number(w) : 1, '0'))
}

// subfolderMode reads the three-way choice off the fields a dialog starts
// from: a saved watch only carries the boolean, and its folder is already part
// of localPath.
export function subfolderMode(f: { subfolder: boolean; subfolderSource?: SubfolderMode }): SubfolderMode {
  return f.subfolderSource ?? (f.subfolder ? 'remote' : 'none')
}

// subfolderTargetDir is syncTargetDir for the three-way choice. A title folder
// is resolved here and once only - it becomes part of the stored localPath, so
// a later title change cannot strand the series in a second folder. Without a
// title the remote folder's name stands in, so a sync never lands loose in the
// library root; re-picking "title" on an already resolved path is a no-op.
//
// seasonFolder is the season's own folder under the title ("Season 02"),
// spelled with the same separator as the title; empty when the season lives
// in the template or the folder is not a season (see seasonInPath).
export function subfolderTargetDir(
  localPath: string,
  remotePath: string,
  mode: SubfolderMode,
  title: string,
  separator: string,
  seasonFolder = '',
): string {
  if (mode !== 'title') return syncTargetDir(localPath, remotePath, mode === 'remote')
  const seg = titleFolder(title, separator)
  if (!seg) return syncTargetDir(localPath, remotePath, true)
  const last = localPath.split('/').filter(Boolean).pop() ?? ''
  const show = last.toLowerCase() === seg.toLowerCase() ? localPath : [localPath, seg].filter(Boolean).join('/')
  const season = titleFolder(seasonFolder, separator)
  return season ? `${show}/${season}` : show
}

// syncRequestPath is the local path a sync request carries. Only a title folder
// travels as a path: the remote one is the server's own join (transfer.Enqueue
// appends the remote base itself), and sending it too would append it twice.
export function syncRequestPath(mode: SubfolderMode, localPath: string, target: string): string {
  return mode === 'title' ? target : localPath
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
