import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Search, Trash2, X } from 'lucide-react'
import { Button, Cover, Dialog, Input } from 'fluid-lycoris'
import { api, mediaTitle, type CatalogItem, type Media } from '../api'
import type { CardViewProps } from './SeriesModal'

// The match search of a catalog folder: the catalogue's own correction, and
// the one an auto-sync uses for its folder, so both write the same match.

export interface RematchProps {
  serverId: number
  item: CatalogItem
  onClose: () => void
  /** after a pick went through, with the new record's id (0: match removed) */
  onPicked?: (mediaId: number) => void
}

export function RematchDialog(props: RematchProps) {
  const { t } = useTranslation()
  return (
    // a search field over a list that caps itself at max-h-72: this one is
    // compact by construction, so it stays a centred box instead of stretching
    // to a full screen it cannot fill
    <Dialog
      width="max-w-lg"
      sheet={false}
      aria-label={t('remote.matchFor', { name: props.item.entry.name })}
      onClose={props.onClose}
    >
      <RematchForm {...props} />
    </Dialog>
  )
}

export const rematchTitle = (t: TFunction, item: RematchProps['item']) =>
  t('remote.matchFor', { name: item.entry.name })

// The match search without a dialog, for the title card to show in place of
// its content.
export function RematchForm({
  serverId,
  item,
  onClose,
  onPicked,
  inPage,
  className = '',
}: RematchProps & Partial<CardViewProps>) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState(item.entry.name)
  const [results, setResults] = useState<Media[]>([])
  const [pickError, setPickError] = useState('')
  // the provider of a pasted link from another source than the folder's: an
  // anime filed in a TVDB-ordered tree is linked to AniList on purpose
  const [linked, setLinked] = useState('')

  // search accepts a title, a bare ID or an anilist.co/themoviedb.org/
  // thetvdb.com link; the metadata source follows the folder's scope, a link
  // brings its own
  const tmdbKind = item.source?.startsWith('tmdb:') ? item.source.slice(5) : ''
  const isTvdb = !!item.source?.startsWith('tvdb')
  // TVDB numbers films apart from series
  const tvdbKind = item.source === 'tvdb:movie' ? 'movie' : 'series'
  const seq = useRef(0) // drop out-of-order responses
  const search = async () => {
    const mySeq = ++seq.current
    const tmdbLink = q.match(/themoviedb\.org\/(tv|movie)\/(\d+)/)
    // only the by-id address carries the number; TVDB's own pages are slugs
    const tvdbLink = q.match(/thetvdb\.com\/(?:dereferrer\/)?(series|movie)s?\/(\d+)/)
    const anilistLink = q.match(/anilist\.co\/(anime|manga)\/(\d+)/)
    const bare = q.match(/^\s*(\d+)\s*$/)
    try {
      let next: Media[]
      let source = ''
      if (tmdbLink) {
        source = `tmdb:${tmdbLink[1]}`
        next = [await api.get<Media>(`/api/tmdb/media?kind=${tmdbLink[1]}&id=${tmdbLink[2]}`)]
      } else if (tvdbLink) {
        source = tvdbLink[1] === 'movie' ? 'tvdb:movie' : 'tvdb'
        next = [await api.get<Media>(`/api/tvdb/media?kind=${tvdbLink[1]}&id=${tvdbLink[2]}`)]
      } else if (anilistLink) {
        source = anilistLink[1] === 'manga' ? 'anilist:manga' : 'anilist'
        next = [await api.get<Media>(`/api/anilist/media/${anilistLink[2]}`)]
      } else if (bare) {
        next = [
          await api.get<Media>(
            isTvdb
              ? `/api/tvdb/media?kind=${tvdbKind}&id=${bare[1]}`
              : tmdbKind
                ? `/api/tmdb/media?kind=${tmdbKind}&id=${bare[1]}`
                : `/api/anilist/media/${bare[1]}`,
          ),
        ]
      } else {
        next = await api.get<Media[]>(
          isTvdb
            ? `/api/tvdb/search?kind=${tvdbKind}&q=${encodeURIComponent(q)}`
            : tmdbKind
              ? `/api/tmdb/search?kind=${tmdbKind}&q=${encodeURIComponent(q)}`
              : `/api/anilist/search?q=${encodeURIComponent(q)}${item.source === 'anilist:manga' ? '&type=manga' : ''}`,
        )
      }
      if (mySeq !== seq.current) return // a newer request superseded this one
      setResults(next)
      setLinked(source && source !== item.source ? source : '')
      setPickError('')
    } catch (err) {
      if (mySeq !== seq.current) return
      setResults([])
      // a failed search (provider down, rate limit) is not "no results"
      setPickError(err instanceof Error ? err.message : t('app.error'))
    }
  }
  // live search: results update as you type (debounced)
  useEffect(() => {
    const id = setTimeout(() => void search(), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  const pick = async (mediaId: number) => {
    setPickError('')
    try {
      await api.put(`/api/servers/${serverId}/catalog/match`, {
        folder: item.entry.path,
        mediaId,
        ...(linked && mediaId ? { source: linked } : {}),
      })
    } catch (err) {
      setPickError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    if (onPicked) onPicked(mediaId)
    else onClose()
  }

  return (
    <div className={`overflow-y-auto p-5 ${className}`}>
      {/* in the series page its bar names the form */}
      {!inPage && <h3 className="mb-1 font-display font-semibold tracking-wider">{rematchTitle(t, item)}</h3>}
      {item.media && (
        <p className="mb-2 text-xs text-t-muted">
          {t('remote.currentMatch', { title: mediaTitle(item.media), id: item.media.id })}
        </p>
      )}
      <div className="mb-1 flex gap-2">
        <label className="sr-only" htmlFor="rematch-q">
          {t('remote.search')}
        </label>
        <Input
          id="rematch-q"
          kind="search"
          value={q}
          placeholder={t('remote.searchHint')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <Button className="shrink-0" onClick={search}>
          <Search aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('remote.search')}
        </Button>
      </div>
      <ul className="max-h-72 overflow-y-auto">
        {results.map((m) => (
          <li key={m.id}>
            <button
              className="flex w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left hover:bg-bg-hover"
              onClick={() => pick(m.id)}
            >
              <Cover src={m.coverImage.large} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{mediaTitle(m)}</span>
                <span className="text-xs text-t-muted">
                  {m.seasonYear} · {m.format} · {m.episodes} EP
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {pickError && (
        <p className="mt-2 text-xs text-err" role="alert">
          {pickError}
        </p>
      )}
      <div className="mt-4 flex justify-between">
        <Button variant="danger" size="sm" onClick={() => pick(0)}>
          <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('remote.removeMatch')}
        </Button>
        <Button onClick={onClose}>
          <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('remote.close')}
        </Button>
      </div>
    </div>
  )
}
