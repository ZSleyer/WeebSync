import { Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Input } from '@weebsync/design-system'
import { api } from '../api'

export interface PlexShowRef {
  ratingKey: string
  title: string
  year: number
  library: string
}

export interface PlexShowState {
  show?: PlexShowRef
  /** which route resolved it: manual | series | path | title | none */
  source: string
  candidates: PlexShowRef[]
}

/** usePlexShow reads which Plex show a watch resolves to; the picker reuses the
 *  same query, so opening it costs nothing extra. */
export function usePlexShow(watchId?: number) {
  return useQuery<PlexShowState>({
    queryKey: ['plex-show', watchId],
    queryFn: () => api.get(`/api/watches/${watchId}/plex-show`),
    enabled: !!watchId,
    retry: false, // Plex may not be configured at all; one 503 is answer enough
    staleTime: 60_000,
  })
}

/** PlexShowDialog binds the watch's SERIES to a Plex show by hand. The choice
 *  outranks every automatic lookup and applies to every watch of that series,
 *  which the note in the header says out loud. */
export default function PlexShowDialog({
  watchId,
  state,
  onDone,
  onClose,
}: {
  watchId: number
  state: PlexShowState
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // filtering happens here: the whole library came with the query, and a
  // round trip per keystroke would buy nothing
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = state.candidates
    return needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all
  }, [q, state.candidates])

  const pick = async (ratingKey: string) => {
    setError('')
    setBusy(true)
    try {
      await api.put(`/api/watches/${watchId}/plex-show`, { ratingKey })
      onDone()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog width="max-w-lg" sheet={false} aria-label={t('watch.plexShowPick')} onClose={onClose}>
      <div className="p-5">
        <h3 className="mb-1 font-display font-semibold tracking-wider">{t('watch.plexShowPick')}</h3>
        <p className="mb-2 text-xs text-t-muted">{t('watch.plexShowScope')}</p>
        <div className="mb-1">
          <label className="sr-only" htmlFor="plex-show-q">
            {t('watch.plexShowSearch')}
          </label>
          <Input
            id="plex-show-q"
            value={q}
            placeholder={t('watch.plexShowSearch')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul className="max-h-72 overflow-y-auto">
          {shown.map((c) => (
            <li key={c.ratingKey}>
              <button
                className="w-full border-b border-border-subtle px-2 py-2 text-left hover:bg-bg-hover disabled:opacity-50"
                disabled={busy}
                aria-current={c.ratingKey === state.show?.ratingKey || undefined}
                onClick={() => pick(c.ratingKey)}
              >
                <span className="block truncate text-sm">{c.title}</span>
                <span className="text-xs text-t-muted">
                  {[c.year || null, c.library].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-2 text-sm text-t-muted">{t('watch.plexShowNone')}</li>}
        </ul>
        {error && (
          <p className="mt-2 text-xs text-err" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-between">
          <Button variant="danger" size="sm" disabled={busy} onClick={() => pick('')}>
            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.plexShowClear')}
          </Button>
          <Button onClick={onClose}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
