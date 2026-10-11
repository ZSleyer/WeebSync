import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, mediaTitle, type Watch } from '../api'
import { useUndoableRemove } from './toast'
import type { WatchFields } from './WatchDialog'

// the edit dialog's initial fields, from a watch as the list has it
export const watchFields = (w: Watch): WatchFields => ({
  remotePath: w.remotePath,
  localPath: w.localPath,
  mode: w.mode || 'template',
  template: w.template,
  separator: w.separator,
  titleOverride: w.titleOverride,
  pattern: w.pattern,
  replacement: w.replacement,
  subfolder: w.subfolder,
  mediaId: w.mediaId,
  mediaSource: w.mediaSource || 'anilist',
  fromEpisode: w.fromEpisode,
  airedMapping: w.airedMapping ?? false,
  renameProvider: w.renameProvider ?? '',
  renameOrdering: w.renameOrdering ?? '',
  renameTitleLang: w.renameTitleLang ?? '',
  renameSeriesId: w.renameSeriesId ?? 0,
  wantDub: w.wantDub ?? '',
  dubLagDays: w.dubLagDays ?? 0,
  wantSub: w.wantSub ?? '',
  plexAudioLang: w.plexAudioLang ?? '',
  plexSubLang: w.plexSubLang ?? '',
})

/**
 * What can be done to a watch, shared by the list and the title card so both
 * run the same requests and refresh the same query. The hook keeps the last
 * error and notice for the caller to show where it likes.
 */
export function useWatchActions() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const removeLater = useUndoableRemove()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['watches'] })
  // the episode list of one watch is cached for minutes; a save or a check
  // changes what is on disk and how it is named, so it has to load again too
  const refreshOne = (id: number) => {
    refresh()
    qc.invalidateQueries({ queryKey: ['watch-episodes', id] })
  }
  // watches with a check on its way, so a second click does not send another
  const [checking, setChecking] = useState<ReadonlySet<number>>(new Set())
  const inFlight = useRef(new Set<number>())
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : t('app.error'))

  const check = async (id: number) => {
    // a ref, not the state: two clicks in one frame both see the old state
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setChecking(new Set(inFlight.current))
    setError('')
    try {
      await api.post(`/api/watches/${id}/check`)
    } catch (err) {
      fail(err)
      return
    } finally {
      inFlight.current.delete(id)
      setChecking(new Set(inFlight.current))
    }
    setTimeout(() => refreshOne(id), 1500)
  }
  const applyPlexStreams = async (id: number) => {
    setError('')
    try {
      await api.post(`/api/watches/${id}/plex-streams`)
      setNotice(t('watch.plexApplyQueued'))
    } catch (err) {
      fail(err)
    }
  }
  /**
   * Leaves the list at once, with an undo line; the server hears of it when
   * the line runs out. Resolves true right away, the watch is gone for the UI.
   */
  const del = async (w: Watch) => {
    setError('')
    removeLater<Watch>({
      key: ['watches'],
      match: (x) => x.id === w.id,
      message: t('watch.deleted', {
        name: w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || ''),
      }),
      remove: () => api.del(`/api/watches/${w.id}`),
    })
    return true
  }
  const save = async (id: number, f: WatchFields) => {
    await api.put(`/api/watches/${id}`, f)
    refreshOne(id)
  }
  return { check, checking, applyPlexStreams, del, save, refresh, error, notice }
}
