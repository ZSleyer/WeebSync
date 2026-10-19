import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Search, Trash2, X } from 'lucide-react'
import { Button, Cover, Dialog, Input, Segmented } from 'fluid-lycoris'
import { api, mediaTitle, type CatalogItem, type Media } from '../api'
import { useProviders } from '../hooks'
import type { CardViewProps } from './SeriesModal'
import { MatchHint } from './MatchHint'

type Provider = 'anilist' | 'tvdb' | 'tmdb'
type Kind = 'series' | 'movie'
const PROVIDERS: Provider[] = ['anilist', 'tvdb', 'tmdb']
const PROVIDER_LABEL: Record<Provider, string> = { anilist: 'AniList', tvdb: 'TVDB', tmdb: 'TMDB' }

// the provider behind a match source (anilist | anilist:manga | tmdb:tv |
// tmdb:movie | tvdb | tvdb:movie); unknown or empty counts as AniList
const providerOf = (source?: string): Provider =>
  source?.startsWith('tvdb') ? 'tvdb' : source?.startsWith('tmdb') ? 'tmdb' : 'anilist'

// the match source of a provider and a kind; manga stays manga on AniList
function sourceOf(provider: Provider, kind: Kind, current?: string): string {
  if (provider === 'tvdb') return kind === 'movie' ? 'tvdb:movie' : 'tvdb'
  if (provider === 'tmdb') return kind === 'movie' ? 'tmdb:movie' : 'tmdb:tv'
  return current === 'anilist:manga' ? current : 'anilist'
}

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
  const { tvdbApiKeySet, tmdbApiKeySet } = useProviders()
  const hasKey = (p: Provider) => (p === 'tvdb' ? tvdbApiKeySet : p === 'tmdb' ? tmdbApiKeySet : true)
  // The provider searched: the folder's current or expected source, AniList
  // when that one has no key. Every provider with a key can be chosen, also one
  // the matching routing has switched off: a manual match is the user's own
  // choice, the routing only steers the automatic passes.
  const own = providerOf(item.source)
  const [chosen, setChosen] = useState<Provider | null>(null)
  const provider = chosen ?? (hasKey(own) ? own : 'anilist')
  // film or series for TVDB and TMDB (they number the two apart): from the
  // folder's source, else its detected kind
  const [chosenKind, setChosenKind] = useState<Kind | null>(null)
  const kind: Kind =
    chosenKind ??
    (item.source ? (item.source.endsWith(':movie') ? 'movie' : 'series') : item.kind === 'movie' ? 'movie' : 'series')
  // the source a pick is filed under when the user chose the provider; a
  // pasted link brings its own (an anime filed in a TVDB-ordered tree is linked
  // to AniList on purpose)
  const [linked, setLinked] = useState('')
  const fileAs = linked || (item.source || chosen ? sourceOf(provider, kind, item.source) : '')

  // search accepts a title, a bare ID or an anilist.co/themoviedb.org/
  // thetvdb.com link; titles and IDs go to the provider picked above, a link
  // to its own
  const seq = useRef(0) // drop out-of-order responses
  const search = async () => {
    const tmdbKind = kind === 'movie' ? 'movie' : 'tv'
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
            provider === 'tvdb'
              ? `/api/tvdb/media?kind=${kind}&id=${bare[1]}`
              : provider === 'tmdb'
                ? `/api/tmdb/media?kind=${tmdbKind}&id=${bare[1]}`
                : `/api/anilist/media/${bare[1]}`,
          ),
        ]
      } else {
        next = await api.get<Media[]>(
          provider === 'tvdb'
            ? `/api/tvdb/search?kind=${kind}&q=${encodeURIComponent(q)}`
            : provider === 'tmdb'
              ? `/api/tmdb/search?kind=${tmdbKind}&q=${encodeURIComponent(q)}`
              : `/api/anilist/search?q=${encodeURIComponent(q)}${item.source === 'anilist:manga' ? '&type=manga' : ''}`,
        )
      }
      if (mySeq !== seq.current) return // a newer request superseded this one
      setResults(next)
      setLinked(source)
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
  }, [q, provider, kind])
  const pick = async (mediaId: number) => {
    setPickError('')
    try {
      await api.put(`/api/servers/${serverId}/catalog/match`, {
        folder: item.entry.path,
        mediaId,
        // sent only when it differs from the source the folder is filed under
        ...(mediaId && fileAs && fileAs !== item.source ? { source: fileAs } : {}),
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
      {!inPage && <h2 className="mb-1 font-display font-semibold tracking-wider">{rematchTitle(t, item)}</h2>}
      {item.media && (
        <p className="mb-2 text-xs text-t-muted">
          {t('remote.currentMatch', { title: mediaTitle(item.media), id: item.media.id })}
        </p>
      )}
      <MatchHint
        serverId={serverId}
        item={item}
        variant="dialog"
        onTaken={() => (onPicked ? onPicked(item.hint?.mediaId ?? 0) : onClose())}
      />
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-t-muted" aria-hidden>
          {t('remote.searchOn')}
        </span>
        <Segmented
          aria-label={t('remote.searchOn')}
          value={provider}
          onChange={(p) => {
            // the old hits belong to the old provider: none may be picked
            // under the new one while the new search is on its way
            seq.current++
            setResults([])
            setLinked('')
            setChosen(p)
          }}
          options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p], disabled: !hasKey(p) }))}
        />
        {provider !== 'anilist' && (
          <Segmented
            aria-label={t('remote.searchKind')}
            value={kind}
            onChange={(k) => {
              seq.current++
              setResults([])
              setLinked('')
              setChosenKind(k)
            }}
            options={[
              { value: 'series' as const, label: t('remote.kindSeries') },
              { value: 'movie' as const, label: t('remote.kindFilm') },
            ]}
          />
        )}
      </div>
      {(!tvdbApiKeySet || !tmdbApiKeySet) && (
        <p className="mb-2 text-xs text-t-muted">{t('remote.providerNeedsKey')}</p>
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
      <ul className="t-scroll max-h-72">
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
