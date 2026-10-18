import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, RowAction } from 'fluid-lycoris'
import { api, type CatalogItem } from '../api'

// The hint a folder AniList found nothing for carries: TMDB knows a show by
// its name. It is a suggestion only. Taking it writes the ordinary manual
// match with TMDB as the source (the same call the match dialog makes), and
// dropping it is remembered, so the sweep does not bring it back.

interface Props {
  serverId: number
  item: CatalogItem
  /** "row" sits in a catalog row's quiet line, "dialog" above the match search */
  variant: 'row' | 'dialog'
  /** after the hint was taken (the match is stored) */
  onTaken?: () => void
}

export function MatchHint({ serverId, item, variant, onTaken }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // the item is a snapshot: a dismissed hint is gone from the view at once
  const [dropped, setDropped] = useState(false)
  const hint = item.hint
  // a folder that has a match has no use for a hint
  if (!hint || item.media || dropped) return null

  const run = async (call: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError('')
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
      return
    }
    setBusy(false)
    qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    after?.()
  }
  const take = () =>
    run(
      () =>
        api.put(`/api/servers/${serverId}/catalog/match`, {
          folder: item.entry.path,
          mediaId: hint.mediaId,
          source: hint.source,
        }),
      onTaken,
    )
  const drop = () =>
    run(
      () => api.post(`/api/servers/${serverId}/catalog/hint/dismiss`, { folder: item.entry.path }),
      () => setDropped(true),
    )

  const text = hint.year
    ? t('catalog.hintFound', { title: hint.title, year: hint.year })
    : t('catalog.hintFoundNoYear', { title: hint.title })
  const err = error && (
    <span className="block text-err" role="alert">
      {error}
    </span>
  )

  if (variant === 'row') {
    return (
      <span className="mt-1 block">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="min-w-0 break-words text-fg-2">{text}</span>
          <span className="flex items-center gap-x-2">
            <RowAction disabled={busy} onClick={take}>
              {t('catalog.hintTake')}
            </RowAction>
            <RowAction tone="accent-2" disabled={busy} onClick={drop}>
              {t('catalog.hintDrop')}
            </RowAction>
          </span>
        </span>
        {err}
      </span>
    )
  }
  return (
    <div className="mb-3 rounded-lg border border-border-subtle p-3">
      <p className="text-sm">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={take}>
          {t('catalog.hintTake')}
        </Button>
        <Button size="sm" disabled={busy} onClick={drop}>
          {t('catalog.hintDrop')}
        </Button>
      </div>
      {err && <p className="mt-2 text-xs">{err}</p>}
    </div>
  )
}
