import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmtBytes, type CatalogItem, type CatalogResponse, type Entry, type Media, type Review, type SearchResult, type ServerInfo } from '../api'
import { FileBrowser, LocalPicker, PathCrumbs } from '../components/FileBrowser'
import WatchDialog from '../components/WatchDialog'
import { useConfirm } from '../components/confirm'
import Loading from '../components/Loading'

export default function Remote() {
  const { t } = useTranslation()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const [params] = useSearchParams()
  const [serverId, setServerId] = useState<number>(Number(params.get('server')) || 0)
  const [view, setView] = useState<'classic' | 'catalog'>('classic')
  // deep links (e.g. Plex suggestions) open the browser at a remote path
  const [remotePath, setRemotePath] = useState((params.get('path') ?? '').replace(/^\//, ''))
  const [localPath, setLocalPath] = useState('')
  const [selection, setSelection] = useState<Entry | null>(null)
  const [notice, setNotice] = useState('')
  const [watchOpen, setWatchOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [flat, setFlat] = useState(false)
  const [query, setQuery] = useState('')
  // preference: land in catalog view automatically for catalog-managed folders
  const [catalogAuto, setCatalogAuto] = useState(() => localStorage.getItem('catalogAutoOpen') === '1')
  useEffect(() => {
    localStorage.setItem('catalogAutoOpen', catalogAuto ? '1' : '0')
  }, [catalogAuto])

  const active = serverId || servers[0]?.id || 0

  // cheap scope probe (no listing/matching) so we know whether the current
  // folder is catalog-managed; drives the auto-open above without side effects
  const { data: scopeInfo } = useQuery<{ scope: string }>({
    queryKey: ['catalog-scope', active, remotePath],
    queryFn: () => api.get(`/api/servers/${active}/catalog/scope${remotePath ? `?path=${encodeURIComponent('/' + remotePath)}` : ''}`),
    enabled: active > 0 && !query.trim(),
    staleTime: 60_000,
  })
  // re-runs only on navigation / preference change, so a manual switch to
  // classic on a catalog folder sticks until the user navigates elsewhere.
  // Without the auto preference we only fall back: navigating out of the
  // catalog tree (no scope, so nothing to show) lands in the classic list.
  useEffect(() => {
    if (!scopeInfo) return
    if (catalogAuto) setView(scopeInfo.scope !== '' ? 'catalog' : 'classic')
    else if (scopeInfo.scope === '') setView('classic')
  }, [catalogAuto, scopeInfo, remotePath])

  const [lastIds, setLastIds] = useState<number[]>([])
  const enqueue = useMutation({
    // entry overrides the panel selection (catalog card sync button)
    mutationFn: (entry?: Entry) =>
      api.post<{ queued: number; ids: number[] }>('/api/downloads', {
        serverId: active,
        remotePath: (entry ?? selection!).path,
        localPath,
        flat: flat && !!(entry ?? selection)?.isDir,
      }),
    onSuccess: (r) => {
      setNotice(t('remote.queued', { count: r.queued }))
      setLastIds(r.ids ?? [])
    },
    onError: (e) => {
      setNotice(e instanceof Error ? e.message : t('app.error'))
      setLastIds([])
    },
  })
  // undo for an accidental sync click: cancel the just-queued batch
  const cancelLast = async () => {
    try {
      const out = await api.post<{ canceled: number }>('/api/downloads/cancel', { ids: lastIds })
      setNotice(t('remote.syncCanceled', { count: out.canceled }))
      setLastIds([])
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.error'))
    }
  }

  if (servers.length === 0) {
    return (
      <div className="t-panel p-8 text-center text-t-muted">
        <Trans i18nKey="remote.noServers">
          Erst unter <Link to="/servers" className="text-accent underline">Server</Link> eine Quelle anlegen.
        </Trans>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col lg:h-[calc(100dvh-3rem)]">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('remote.title')}</h2>
          <span className="t-label mt-1">{t('remote.sub')}</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-t-muted">
          {t('remote.source')}
          <span className="t-select-wrap w-48">
            <select className="t-select" value={active} onChange={(e) => setServerId(Number(e.target.value))}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-t-muted" title={t('remote.autoCatalogHint')}>
          <input type="checkbox" checked={catalogAuto} onChange={(e) => setCatalogAuto(e.target.checked)} />
          {t('remote.autoCatalog')}
        </label>
        <div role="group" aria-label={t('remote.view')} className="flex">
          <button
            className={`t-btn t-btn--sm ${view === 'classic' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'classic'}
            onClick={() => setView('classic')}
          >
            {t('remote.classic')}
          </button>
          <button
            className={`t-btn t-btn--sm ${view === 'catalog' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'catalog'}
            onClick={() => setView('catalog')}
          >
            {t('remote.catalog')}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <section className="t-panel flex min-h-64 min-w-0 flex-col lg:min-h-0" aria-label={t('remote.remote')}>
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="t-label t-label--accent">{t('remote.remote')}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-muted">
              {selection ? selection.path : t('remote.noSelection')}
            </span>
            <input
              className="t-input w-40 py-1 text-xs sm:w-56"
              type="search"
              placeholder={t('remote.search')}
              aria-label={t('remote.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {query.trim() ? (
            <SearchResults
              serverId={active}
              query={query}
              onOpenDir={(p) => {
                setRemotePath(p.replace(/^\//, ''))
                setSelection(null)
                setQuery('')
              }}
              onSelect={setSelection}
              selected={selection?.path}
            />
          ) : view === 'classic' ? (
            <FileBrowser
              queryKey={['remote', active]}
              fetchPath={(p) => `/api/servers/${active}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`}
              path={remotePath}
              onNavigate={(p) => {
                setRemotePath(p)
                setSelection(null)
              }}
              onSelect={setSelection}
              selected={selection?.path}
            />
          ) : (
            <CatalogGrid
              serverId={active}
              path={remotePath}
              onNavigate={(p) => {
                setRemotePath(p)
                setSelection(null)
              }}
              onSelect={setSelection}
              selected={selection?.path}
              onSync={(e) => {
                setSelection(e)
                setSyncOpen(true)
              }}
              onWatch={(e) => {
                setSelection(e)
                setWatchOpen(true)
              }}
              onOpenFiles={(p) => {
                // ponytail: the auto-open preference re-opens the catalog if the
                // target folder carries a mark of its own; marks no longer
                // inherit, so that only happens when the user set one there
                setRemotePath(p.replace(/^\//, ''))
                setView('classic')
              }}
            />
          )}
        </section>

      </div>

      {/* action bar: appears with a selection (or a pending notice) so the long
          remote list keeps the full height. On phones it floats above the
          bottom nav; from lg on it just sits at the end of the page. */}
      {(selection || notice) && (
        <div
          role="region"
          aria-label={t('remote.selectionBar')}
          className="t-panel fixed inset-x-4 bottom-[calc(60px+env(safe-area-inset-bottom))] z-40 flex flex-wrap items-center gap-2 p-3 lg:static lg:z-auto lg:mt-4 lg:inset-auto"
        >
          {selection && (
            <span className="min-w-0 flex-1 truncate text-sm text-t-secondary" title={selection.path}>
              <span aria-hidden className="mr-1.5 font-mono text-xs text-accent">
                {selection.isDir ? '▸' : '·'}
              </span>
              {selection.name}
            </span>
          )}
          {notice && (
            <span className="flex items-center gap-2 text-xs text-t-secondary" role="status">
              {notice}
              {lastIds.length > 0 && (
                <button className="t-btn t-btn--sm t-btn--danger" onClick={cancelLast}>
                  {t('remote.undoSync')}
                </button>
              )}
            </span>
          )}
          {selection && (
            <>
              <button className="t-btn t-btn--sm" disabled={!selection.isDir} onClick={() => setWatchOpen(true)}>
                {t('watch.add')}
              </button>
              <button className="t-btn t-btn--primary t-btn--sm t-cut" onClick={() => setSyncOpen(true)}>
                {t('remote.syncOpen')}
              </button>
            </>
          )}
        </div>
      )}

      {syncOpen && selection && (
        <SyncDialog
          entry={selection}
          localPath={localPath}
          onLocalPath={setLocalPath}
          flat={flat}
          onFlat={setFlat}
          pending={enqueue.isPending}
          onConfirm={() => {
            setSyncOpen(false)
            enqueue.mutate(undefined)
          }}
          onClose={() => setSyncOpen(false)}
        />
      )}
      {watchOpen && selection && (
        <WatchDialog
          title={t('watch.addTitle', { name: selection.name })}
          serverId={active}
          initial={{
            remotePath: selection.path,
            localPath,
            mode: 'template',
            template: '',
            separator: '',
            titleOverride: '',
            pattern: '',
            replacement: '',
            subfolder: false,
            mediaId: 0,
            mediaSource: 'anilist',
            fromEpisode: 0,
            airedMapping: false,
            renameProvider: '',
            renameOrdering: '',
            renameTitleLang: '',
            renameSeriesId: 0,
            wantDub: '',
            wantSub: '',
          }}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: active, ...f })
            setNotice(t('watch.created'))
          }}
          onClose={() => setWatchOpen(false)}
        />
      )}
    </div>
  )
}

// Search over the server's remote index (built passively + by the crawler,
// may be incomplete while it grows).
function SearchResults({
  serverId,
  query,
  onOpenDir,
  onSelect,
  selected,
}: {
  serverId: number
  query: string
  onOpenDir: (path: string) => void
  onSelect: (e: Entry) => void
  selected?: string
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState(query)
  useEffect(() => {
    const id = setTimeout(() => setQ(query), 300)
    return () => clearTimeout(id)
  }, [query])
  const { data, isLoading } = useQuery<SearchResult>({
    queryKey: ['search', serverId, q],
    queryFn: () => api.get(`/api/servers/${serverId}/search?q=${encodeURIComponent(q)}`),
    enabled: !!q.trim(),
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {isLoading && <Loading className="p-4" />}
      {data && data.results.length === 0 && (
        <p className="p-4 text-sm text-t-muted">
          {t('remote.noResults')}
          {data.indexed < 100 && <span className="mt-1 block text-xs">{t('remote.indexBuilding')}</span>}
        </p>
      )}
      <ul>
        {data?.results.map((e) => (
          <li key={e.path} className="border-b border-border-subtle/50">
            <button
              type="button"
              className={`flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-bg-hover ${
                selected === e.path ? 'bg-bg-hover text-accent' : 'text-t-secondary'
              }`}
              onClick={() => (e.isDir ? onOpenDir(e.path) : onSelect(e))}
            >
              <span aria-hidden className={`font-mono text-xs ${e.isDir ? 'text-accent' : 'text-t-faint'}`}>
                {e.isDir ? '▸' : '·'}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {e.name}
                <span className="mt-0.5 block truncate font-mono text-[10px] text-t-faint">{e.path}</span>
              </span>
              {!e.isDir && <span className="shrink-0 font-mono text-xs text-t-muted">{fmtBytes(e.size)}</span>}
            </button>
          </li>
        ))}
      </ul>
      {data && (
        <p className="px-3 py-2 text-[10px] text-t-faint">{t('remote.indexCount', { count: data.indexed })}</p>
      )}
    </div>
  )
}

// Catalog view: folders as an AniList-metadata poster grid. Used for remote
// servers and, with serverId 0 and no sync/watch actions, for local files.
export function CatalogGrid({
  serverId,
  path,
  onNavigate,
  onSelect,
  selected,
  onSync,
  onWatch,
  onOpenFiles,
  cardActions,
}: {
  serverId: number
  path: string
  onNavigate: (path: string) => void
  onSelect: (e: Entry) => void
  selected?: string
  // omitted on the local page: there is nothing to download or watch there
  onSync?: (e: Entry) => void
  onWatch?: (e: Entry) => void
  // hands a folder to the page, which opens it in the classic browser: that
  // one already lists files and navigates, so the catalog needs no second one
  onOpenFiles: (path: string) => void
  // local page: extra card buttons (rename/delete). Kept as a render prop so
  // the admin logic lives with the page that owns the mutations.
  cardActions?: (e: Entry) => ReactNode
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data, isLoading, error } = useQuery<CatalogResponse>({
    queryKey: ['catalog', serverId, path],
    queryFn: () => api.get(`/api/servers/${serverId}/catalog${path ? `?path=${encodeURIComponent('/' + path)}` : ''}`),
    staleTime: 5 * 60_000,
    // matching runs server-side in the background: poll while items are pending
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.pending) ? 2500 : false),
  })
  const items = useMemo(() => data?.items ?? [], [data])
  // provider availability: the TVDB scope is only offered when a key is set
  // (settings is admin-only; a 403 just leaves the option hidden)
  const { data: caps } = useQuery<{ tvdbApiKeySet?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const qc = useQueryClient()
  const [rematch, setRematch] = useState<CatalogItem | null>(null)
  const [detail, setDetail] = useState<CatalogGroup | null>(null)
  const [scopeError, setScopeError] = useState('')
  const pendingCount = items.filter((i) => i.pending).length
  const noMatchCount = items.filter((i) => !i.media && !i.pending).length

  const triggerRematch = async (all: boolean) => {
    if (all && !(await confirm({ message: t('remote.confirmRematchAll'), destructive: true }))) return
    setScopeError('')
    try {
      await api.post(`/api/servers/${serverId}/catalog/rematch`, { path: path ? '/' + path : '', all })
      qc.invalidateQueries({ queryKey: ['catalog', serverId, path] })
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  // mark the current folder's metadata source; '' clears the own mark so the
  // parent's (or the anime default) applies again
  const setScope = async (kind: string) => {
    setScopeError('')
    try {
      await api.put(`/api/servers/${serverId}/catalog/scope`, { path: path ? '/' + path : '', kind })
      qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  // bundle folders matched to the same anime into one card; the version
  // (folder) is picked in a dialog. Unmatched/pending folders stay individual.
  // The source belongs in the key: AniList, TMDB series, TMDB films and TVDB
  // number their entries independently, so a film and a show can share an id
  // and would otherwise collapse into one card that hides both their buttons.
  const groups = useMemo(() => {
    const out: CatalogGroup[] = []
    const byMedia = new Map<string, CatalogGroup>()
    for (const it of items) {
      const key = it.media ? `${it.source ?? ''}:${it.media.id}` : it.entry.path
      const existing = it.media && byMedia.get(key)
      if (existing) {
        existing.items.push(it)
        continue
      }
      const g: CatalogGroup = { key, media: it.media, pending: it.pending, items: [it] }
      if (it.media) byMedia.set(key, g)
      out.push(g)
    }
    return out
  }, [items])

  // the breadcrumb is outside the loading/error branches on purpose: without
  // it a slow or failing folder would be a dead end with no way back up
  const crumbs = <PathCrumbs path={path} onNavigate={onNavigate} />

  if (isLoading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {crumbs}
        <p className="p-6 text-sm text-t-muted" role="status">
          {t('remote.catalogLoading')}
        </p>
      </div>
    )
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {crumbs}
        <p className="p-6 text-sm text-err">{error instanceof Error ? error.message : t('app.error')}</p>
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {crumbs}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-t-muted">
          {t('remote.scope')}
          <span className="t-select-wrap w-44">
            <select className="t-select" value={data?.scope ?? ''} onChange={(e) => setScope(e.target.value)}>
              <option value="" disabled>
                {t('remote.scopeNone')}
              </option>
              <option value="anime">{t('remote.scopeAnime')}</option>
              <option value="tv">{t('remote.scopeTv')}</option>
              <option value="movie">{t('remote.scopeMovie')}</option>
              {caps?.tvdbApiKeySet && <option value="tvdb">{t('remote.scopeTvdb')}</option>}
            </select>
          </span>
        </label>
        {data && data.scope !== '' && (
          <button className="t-btn t-btn--sm" title={t('remote.scopeClearHint')} onClick={() => setScope('')}>
            {t('remote.scopeClear')}
          </button>
        )}
        {scopeError && (
          <span className="text-xs text-err" role="alert">
            {scopeError}
          </span>
        )}
        {data?.scope === '' ? (
          <p className="text-xs text-t-muted" role="status">
            {t('remote.scopePick')}
          </p>
        ) : pendingCount > 0 ? (
          <p className="text-xs text-t-muted" role="status">
            {t('remote.matchingCount', { count: pendingCount })}
          </p>
        ) : (
          items.length > 0 && (
            <>
              {noMatchCount > 0 && (
                <button className="t-btn t-btn--sm" onClick={() => triggerRematch(false)}>
                  {t('remote.retryUnmatched', { count: noMatchCount })}
                </button>
              )}
              <button className="t-btn t-btn--sm" onClick={() => triggerRematch(true)}>
                {t('remote.rematchAll')}
              </button>
            </>
          )
        )}
      </div>
      {/* a leaf folder holds files, not titles: offer the classic list instead
          of leaving the user at a dead end */}
      {items.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 p-6">
          <p className="text-sm text-t-muted">{t('remote.noFolders')}</p>
          <button className="t-btn t-btn--sm" onClick={() => onOpenFiles(path)}>
            {t('remote.showFiles')}
          </button>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {groups.map((g) => {
          const it = g.items[0]
          const multi = g.items.length > 1
          const isSelected = g.items.some((v) => v.entry.path === selected)
          return (
            <article
              key={g.key}
              className={`t-panel group relative flex flex-col ${isSelected ? 'outline-2 outline-accent' : ''}`}
            >
              {/* rematch tucked away as a pencil over the cover (hover/focus);
                  unmatched folders keep the explicit button below instead */}
              {g.media && !multi && !!it.source && (
                <button
                  className="t-btn t-btn--sm absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('remote.changeMatch')}
                  title={t('remote.changeMatch')}
                  onClick={() => setRematch(it)}
                >
                  ✎
                </button>
              )}
              <button
                className="text-left"
                onClick={() => (g.media ? setDetail(g) : onSelect(it.entry))}
                aria-label={
                  g.media
                    ? t('remote.detailsFor', { name: g.media.title.romaji })
                    : t('remote.selectItem', { name: it.entry.name })
                }
              >
                {g.media?.coverImage?.large ? (
                  <img
                    src={g.media.coverImage.large}
                    alt=""
                    loading="lazy"
                    className="aspect-2/3 w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                  />
                ) : g.pending ? (
                  <div className="t-hatch grid aspect-2/3 w-full animate-pulse place-items-center text-t-muted">
                    {t('remote.matching')}
                  </div>
                ) : (
                  <div className="t-hatch grid aspect-2/3 w-full place-items-center text-t-muted">
                    {it.source ? t('remote.noMatch') : ''}
                  </div>
                )}
                <div className="p-2">
                  <h4 className="line-clamp-2 text-sm font-medium text-t-primary" title={g.media?.title.romaji ?? it.entry.name}>
                    {g.media?.title.romaji ?? it.entry.name}
                  </h4>
                  {multi ? (
                    <p className="font-mono text-[10px] text-accent">{t('remote.versions', { count: g.items.length })}</p>
                  ) : (
                    <p className="truncate font-mono text-[10px] text-t-muted" title={it.entry.name}>
                      {it.entry.name}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {it.kind && (
                      <span className={`t-label ${it.kind === 'movie' ? 't-label--accent' : ''}`}>
                        {t(it.kind === 'movie' ? 'remote.kindMovie' : 'remote.kindSeries')}
                      </span>
                    )}
                    {g.media && (
                      <>
                        {g.media.seasonYear > 0 && <span className="t-label">{g.media.seasonYear}</span>}
                        {g.media.episodes > 0 && <span className="t-label">{g.media.episodes} EP</span>}
                        {g.media.averageScore > 0 && <span className="t-label t-label--accent">★ {g.media.averageScore}</span>}
                      </>
                    )}
                  </div>
                  {/* local catalog: what is actually on disk, and how it
                      compares to what the provider lists */}
                  {it.local && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span
                        className={`t-label ${
                          g.media && g.media.episodes > 0 && it.local.videos >= g.media.episodes
                            ? 't-label--ok'
                            : ''
                        }`}
                      >
                        {t('local.videoCount', { count: it.local.videos })}
                      </span>
                      <span className="t-label">{fmtBytes(it.local.bytes)}</span>
                      {it.local.modTime && (
                        <span className="font-mono text-[10px] text-t-faint" title={t('local.lastChange')}>
                          {new Date(it.local.modTime).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </button>
              {g.media ? (
                <div className="mx-2 mb-2 mt-auto flex gap-1.5">
                  <button
                    className="t-btn t-btn--sm flex-1"
                    aria-label={t('remote.detailsFor', { name: g.media.title.romaji })}
                    title={t('remote.details')}
                    onClick={() => setDetail(g)}
                  >
                    ℹ
                  </button>
                  {!multi && (
                    <>
                      <button
                        className="t-btn t-btn--sm flex-1"
                        aria-label={`${t('remote.showFiles')}: ${it.entry.name}`}
                        title={t('remote.showFiles')}
                        onClick={() => onOpenFiles(it.entry.path)}
                      >
                        🗎
                      </button>
                      {onSync && (
                        <button
                          className="t-btn t-btn--sm flex-1"
                          aria-label={`${t('plex.syncOnce')}: ${it.entry.name}`}
                          title={t('plex.syncOnce')}
                          onClick={() => onSync(it.entry)}
                        >
                          ⇣
                        </button>
                      )}
                      {onWatch && (
                        <button
                          className="t-btn t-btn--sm flex-1"
                          aria-label={`${t('watch.add')}: ${it.entry.name}`}
                          title={t('watch.add')}
                          onClick={() => onWatch(it.entry)}
                        >
                          ◉
                        </button>
                      )}
                      {cardActions?.(it.entry)}
                    </>
                  )}
                </div>
              ) : (
                <div className="mx-2 mb-2 mt-auto flex gap-1.5">
                  <button
                    className="t-btn t-btn--sm flex-1"
                    aria-label={`${t('remote.showFiles')}: ${it.entry.name}`}
                    title={t('remote.showFiles')}
                    onClick={() => onOpenFiles(it.entry.path)}
                  >
                    🗎
                  </button>
                  {!g.pending && !!it.source && (
                    <button className="t-btn t-btn--sm flex-1" onClick={() => setRematch(it)}>
                      {t('remote.changeMatch')}
                    </button>
                  )}
                  {cardActions?.(it.entry)}
                </div>
              )}
            </article>
          )
        })}
      </div>
      {rematch && <RematchDialog serverId={serverId} item={rematch} onClose={() => setRematch(null)} />}
      {detail && (
        <DetailDialog
          group={detail}
          selected={selected}
          onSelect={(e) => {
            onSelect(e)
            setDetail(null)
          }}
          onRematch={(it) => {
            setDetail(null)
            setRematch(it)
          }}
          onFiles={(e) => {
            setDetail(null)
            onOpenFiles(e.path)
          }}
          onClose={() => setDetail(null)}
        />
      )}
      </div>
    </div>
  )
}

// Sync dialog: picks the local target for the selected remote entry. Replaces
// the old second column, which on phones ended up below a list of hundreds of
// entries. Target and flat flag live in the parent, so the choice survives.
function SyncDialog({
  entry,
  localPath,
  onLocalPath,
  flat,
  onFlat,
  pending,
  onConfirm,
  onClose,
}: {
  entry: Entry
  localPath: string
  onLocalPath: (p: string) => void
  flat: boolean
  onFlat: (v: boolean) => void
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const backdropDown = useRef(false)
  const confirmed = useRef(false)
  const [browse, setBrowse] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  // decide in onClose so every exit path (button, Escape, backdrop) is the same
  const close = (ok: boolean) => {
    confirmed.current = ok
    ref.current?.close()
  }
  const target = entry.isDir && !flat ? [localPath, entry.name].filter(Boolean).join('/') : localPath
  return (
    <dialog
      ref={ref}
      className="dialog-sheet w-full max-w-lg p-0"
      aria-label={t('remote.syncTitle', { name: entry.name })}
      onClose={() => (confirmed.current ? onConfirm() : onClose())}
      onPointerDown={(e) => (backdropDown.current = e.target === ref.current)}
      onClick={(e) => e.target === ref.current && backdropDown.current && close(false)}
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="font-display font-semibold tracking-wider">{t('remote.syncTitle', { name: entry.name })}</h3>
          <span className="mt-1 block truncate font-mono text-xs text-t-muted" title={entry.path}>
            {entry.path}
          </span>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor="sync-target">
              {t('remote.localTarget')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="sync-target"
                className="t-input font-mono"
                value={localPath}
                onChange={(e) => onLocalPath(e.target.value)}
              />
              <button
                type="button"
                className={`t-btn t-btn--sm shrink-0 ${browse ? 't-btn--primary' : ''}`}
                aria-expanded={browse}
                onClick={() => setBrowse((b) => !b)}
              >
                {t('watch.browse')}
              </button>
            </div>
            {browse && (
              <div className="mt-2 flex max-h-56 flex-col overflow-hidden border border-border-subtle bg-bg-secondary/40">
                <LocalPicker path={localPath} onNavigate={onLocalPath} />
              </div>
            )}
          </div>

          {entry.isDir && (
            <label className="flex items-center gap-2 text-sm text-t-secondary">
              <input type="checkbox" checked={flat} onChange={(e) => onFlat(e.target.checked)} />
              {t('remote.flatSync')}
            </label>
          )}

          <p className="text-xs text-t-muted">
            {t('remote.syncTarget')} <span className="font-mono text-t-secondary">downloads/{target}</span>
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className="t-btn" onClick={() => close(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="t-btn t-btn--primary t-cut" disabled={pending} onClick={() => close(true)}>
            {entry.isDir ? t('remote.syncFolder') : t('remote.downloadFile')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

interface CatalogGroup {
  key: string
  media?: Media
  pending?: boolean
  items: CatalogItem[]
}

// source-dependent external link (AniList for anime, TMDB for marked folders)
const mediaLink = (source: string | undefined, id: number) =>
  source?.startsWith('tmdb:')
    ? { href: `https://www.themoviedb.org/${source.slice(5)}/${id}`, label: 'TMDB' }
    : { href: `https://anilist.co/anime/${id}`, label: 'AniList' }

// DetailDialog shows the anime's full metadata (banner, description, trailer,
// genres) plus every folder version matched to it, each selectable for sync
// and individually re-matchable.
function DetailDialog({
  group,
  selected,
  onSelect,
  onRematch,
  onFiles,
  onClose,
}: {
  group: CatalogGroup
  selected?: string
  onSelect: (e: Entry) => void
  onRematch: (it: CatalogItem) => void
  onFiles: (e: Entry) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const m = group.media!
  const source = group.items[0].source
  const [allReviews, setAllReviews] = useState(false)
  // reviews load lazily with the modal, never with the catalog grid
  const { data: rev } = useQuery<{ reviews: Review[] }>({
    queryKey: ['reviews', source ?? 'anilist', m.id],
    queryFn: () => api.get(`/api/media/reviews?source=${source ?? 'anilist'}&id=${m.id}`),
    staleTime: 5 * 60_000,
  })

  return (
    <dialog ref={ref} className="dialog-sheet w-full max-w-4xl lg:max-w-6xl" aria-label={t('remote.detailsFor', { name: m.title.romaji })} onClose={onClose} onPointerDown={(e) => (backdropDown.current = e.target === ref.current)} onClick={(e) => e.target === ref.current && backdropDown.current && ref.current?.close()}>
      {/* close button stays reachable while the dialog scrolls */}
      <div className="sticky top-2 z-10 h-0 text-right">
        <button type="button" className="t-btn t-btn--sm mr-2" aria-label={t('remote.close')} onClick={() => ref.current?.close()}>
          ✕
        </button>
      </div>
      {m.bannerImage && <img src={m.bannerImage} alt="" className="max-h-36 w-full object-cover" />}
      <div className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          {m.coverImage?.large && <img src={m.coverImage.large} alt="" className="h-40 w-28 shrink-0 object-cover" />}
          <div className="min-w-0">
            <h3 className="font-display font-semibold tracking-wider">{m.title.romaji}</h3>
            {m.title.english && m.title.english !== m.title.romaji && (
              <p className="text-sm text-t-muted">{m.title.english}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {m.seasonYear > 0 && <span className="t-label">{m.seasonYear}</span>}
              {m.format && <span className="t-label">{m.format}</span>}
              {m.episodes > 0 && <span className="t-label">{m.episodes} EP</span>}
              {m.status && <span className="t-label">{t(`remote.status.${m.status}`, m.status)}</span>}
              {m.averageScore > 0 && <span className="t-label t-label--accent">★ {m.averageScore}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {m.genres?.map((g) => (
                <span key={g} className="t-label">
                  {g}
                </span>
              ))}
            </div>
            {(() => {
              const l = mediaLink(source, m.id)
              return (
                <a
                  className="t-btn t-btn--sm mt-3 inline-flex items-center gap-1.5"
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.label} #{m.id}
                  <span aria-hidden>↗</span>
                </a>
              )
            })()}
          </div>
        </div>
        {m.description && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">{t('remote.description')}</h4>
            <p className="text-sm whitespace-pre-line text-t-secondary">
              {/* AniList descriptions still carry some inline HTML; strip via
                  the browser's own parser (rendered as a text node, never HTML) */}
              {new DOMParser()
                .parseFromString(m.description.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
                .body.textContent}
            </p>
          </section>
        )}
        {(m.trailer?.site === 'youtube' || m.trailer?.site === 'dailymotion') && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">{t('remote.trailer')}</h4>
            {m.trailer?.site === 'youtube' && (
              <iframe
                className="aspect-video w-full"
                title={t('remote.trailer')}
                src={`https://www.youtube-nocookie.com/embed/${m.trailer.id}`}
                allow="encrypted-media; fullscreen"
                allowFullScreen
              />
            )}
            {m.trailer?.site === 'dailymotion' && (
              <a
                className="t-btn t-btn--sm inline-flex items-center gap-2"
                href={`https://www.dailymotion.com/video/${m.trailer.id}`}
                target="_blank"
                rel="noreferrer"
              >
                ▶ {t('remote.trailer')}
                {m.trailer.thumbnail && <img src={m.trailer.thumbnail} alt="" className="h-6 object-cover" />}
                <span aria-hidden>↗</span>
              </a>
            )}
          </section>
        )}
        {rev && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">
              {t('remote.reviews')} ({rev.reviews.length})
            </h4>
            {rev.reviews.length === 0 && <p className="text-sm text-t-muted">{t('remote.noReviews')}</p>}
            {/* chat-bubble layout: avatar beside a bordered bubble per review */}
            <ul className="mt-3 grid gap-3">
              {(allReviews ? rev.reviews : rev.reviews.slice(0, 5)).map((r, i) => (
                <li key={i} className="flex items-start gap-3">
                  {r.user.avatar?.medium ? (
                    <img src={r.user.avatar.medium} alt="" className="h-9 w-9 shrink-0 object-cover" />
                  ) : (
                    <div aria-hidden className="t-hatch flex h-9 w-9 shrink-0 items-center justify-center font-display text-xs text-t-muted">
                      {r.user.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 border border-border-subtle bg-bg-secondary p-3 text-sm text-t-secondary">
                    <p className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="t-label">{r.user.name}</span>
                      {r.score > 0 && <span className="t-label t-label--accent">★ {r.score}</span>}
                    </p>
                    <p className="whitespace-pre-line">{r.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
            {!allReviews && rev.reviews.length > 5 && (
              <button type="button" className="t-btn t-btn--sm mt-3" onClick={() => setAllReviews(true)}>
                {t('remote.moreReviews', { count: rev.reviews.length - 5 })}
              </button>
            )}
          </section>
        )}

        <h4 className="t-label mt-4 mb-1 border-t border-border-subtle pt-4">
          {t('remote.versions', { count: group.items.length })}
        </h4>
        <ul>
          {group.items.map((it) => (
            <li key={it.entry.path} className="flex items-center gap-2 border-b border-border-subtle px-2 py-2">
              <span
                className={`min-w-0 flex-1 truncate text-sm ${selected === it.entry.path ? 'text-accent' : ''}`}
                title={it.entry.path}
              >
                {it.entry.name}
              </span>
              <button className="t-btn t-btn--sm t-btn--primary shrink-0" onClick={() => onSelect(it.entry)}>
                {t('remote.select')}
              </button>
              <button className="t-btn t-btn--sm shrink-0" title={t('remote.showFiles')} onClick={() => onFiles(it.entry)}>
                {t('remote.files')}
              </button>
              <button className="t-btn t-btn--sm shrink-0" onClick={() => onRematch(it)}>
                {t('remote.changeMatch')}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button className="t-btn" onClick={() => ref.current?.close()}>
            {t('remote.close')}
          </button>
        </div>
      </div>
    </dialog>
  )
}

function RematchDialog({ serverId, item, onClose }: { serverId: number; item: CatalogItem; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const ref = useRef<HTMLDialogElement>(null)
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  const [q, setQ] = useState(item.entry.name)
  const [results, setResults] = useState<Media[]>([])
  const [pickError, setPickError] = useState('')

  // real modal: focus trap + Escape via the native dialog
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  // search accepts a title, a bare ID or an anilist.co/themoviedb.org link;
  // the metadata source follows the folder's scope
  const tmdbKind = item.source?.startsWith('tmdb:') ? item.source.slice(5) : ''
  const isTvdb = item.source === 'tvdb'
  const seq = useRef(0) // drop out-of-order responses
  const search = async () => {
    const mySeq = ++seq.current
    const idm =
      q.match(/themoviedb\.org\/(?:tv|movie)\/(\d+)/) ??
      q.match(/thetvdb\.com\/series\/(\d+)/) ??
      q.match(/anilist\.co\/anime\/(\d+)/) ??
      q.match(/^\s*(\d+)\s*$/)
    try {
      let next: Media[]
      if (idm) {
        next = [
          await api.get<Media>(
            isTvdb
              ? `/api/tvdb/media?id=${idm[1]}`
              : tmdbKind
                ? `/api/tmdb/media?kind=${tmdbKind}&id=${idm[1]}`
                : `/api/anilist/media/${idm[1]}`,
          ),
        ]
      } else {
        next = await api.get<Media[]>(
          isTvdb
            ? `/api/tvdb/search?q=${encodeURIComponent(q)}`
            : tmdbKind
              ? `/api/tmdb/search?kind=${tmdbKind}&q=${encodeURIComponent(q)}`
              : `/api/anilist/search?q=${encodeURIComponent(q)}`,
        )
      }
      if (mySeq !== seq.current) return // a newer request superseded this one
      setResults(next)
    } catch {
      if (mySeq !== seq.current) return
      setResults([])
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
      await api.put(`/api/servers/${serverId}/catalog/match`, { folder: item.entry.path, mediaId })
    } catch (err) {
      setPickError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    onClose()
  }

  return (
    <dialog ref={ref} className="w-full max-w-lg" aria-label={t('remote.matchFor', { name: item.entry.name })} onClose={onClose} onPointerDown={(e) => (backdropDown.current = e.target === ref.current)} onClick={(e) => e.target === ref.current && backdropDown.current && ref.current?.close()}>
      <div className="p-5">
        <h3 className="mb-1 font-display font-semibold tracking-wider">MATCH: {item.entry.name}</h3>
        {item.media && (
          <p className="mb-2 text-xs text-t-muted">
            {t('remote.currentMatch', { title: item.media.title.romaji, id: item.media.id })}
          </p>
        )}
        <div className="mb-1 flex gap-2">
          <label className="sr-only" htmlFor="rematch-q">
            {t('remote.search')}
          </label>
          <input
            id="rematch-q"
            className="t-input"
            value={q}
            placeholder={t('remote.searchHint')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button className="t-btn shrink-0" onClick={search}>
            {t('remote.search')}
          </button>
        </div>
        <ul className="max-h-72 overflow-y-auto">
          {results.map((m) => (
            <li key={m.id}>
              <button
                className="flex w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left hover:bg-bg-hover"
                onClick={() => pick(m.id)}
              >
                <img src={m.coverImage.large} alt="" className="h-14 w-10 object-cover" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{m.title.romaji}</span>
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
          <button className="t-btn t-btn--danger t-btn--sm" onClick={() => pick(0)}>
            {t('remote.removeMatch')}
          </button>
          <button className="t-btn" onClick={() => ref.current?.close()}>
            {t('remote.close')}
          </button>
        </div>
      </div>
    </dialog>
  )
}
