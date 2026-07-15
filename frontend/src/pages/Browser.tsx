import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, type CatalogItem, type Entry, type Media, type ServerInfo } from '../api'
import { FileBrowser, LocalPicker } from '../components/FileBrowser'

export default function Browser() {
  const { t } = useTranslation()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const [serverId, setServerId] = useState<number>(0)
  const [view, setView] = useState<'classic' | 'catalog'>('classic')
  const [remotePath, setRemotePath] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [selection, setSelection] = useState<Entry | null>(null)
  const [notice, setNotice] = useState('')

  const active = serverId || servers[0]?.id || 0

  const enqueue = useMutation({
    mutationFn: () =>
      api.post<{ queued: number }>('/api/downloads', {
        serverId: active,
        remotePath: selection!.path,
        localPath,
      }),
    onSuccess: (r) => setNotice(t('browser.queued', { count: r.queued })),
    onError: (e) => setNotice(e instanceof Error ? e.message : t('app.error')),
  })

  if (servers.length === 0) {
    return (
      <div className="t-panel p-8 text-center text-t-muted">
        <Trans i18nKey="browser.noServers">
          Erst unter <Link to="/servers" className="text-accent underline">Server</Link> eine Quelle anlegen.
        </Trans>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col lg:h-[calc(100vh-3rem)]">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('browser.title')}</h2>
          <span className="t-label mt-1">{t('browser.sub')}</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-t-muted">
          {t('browser.source')}
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
        <div role="group" aria-label={t('browser.view')} className="flex">
          <button
            className={`t-btn t-btn--sm ${view === 'classic' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'classic'}
            onClick={() => setView('classic')}
          >
            {t('browser.classic')}
          </button>
          <button
            className={`t-btn t-btn--sm ${view === 'catalog' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'catalog'}
            onClick={() => setView('catalog')}
          >
            {t('browser.catalog')}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(16rem,0.6fr)]">
        <section className="t-panel flex min-h-64 flex-col lg:min-h-0" aria-label={t('browser.remote')}>
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="t-label t-label--accent">{t('browser.remote')}</span>
            <span className="truncate font-mono text-xs text-t-muted">
              {selection ? selection.path : t('browser.noSelection')}
            </span>
          </div>
          {view === 'classic' ? (
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
            <CatalogGrid serverId={active} path={remotePath} onSelect={setSelection} selected={selection?.path} />
          )}
        </section>

        <section className="t-panel flex min-h-64 flex-col lg:min-h-0" aria-label={t('browser.localTarget')}>
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="t-label">{t('browser.local')}</span>
            <span className="truncate font-mono text-xs text-t-muted">downloads/{localPath}</span>
          </div>
          <LocalPicker path={localPath} onNavigate={setLocalPath} />
          <div className="border-t border-border-subtle p-3">
            <button
              className="t-btn t-btn--primary t-cut w-full"
              disabled={!selection || enqueue.isPending}
              onClick={() => enqueue.mutate()}
            >
              {selection?.isDir ? t('browser.syncFolder') : t('browser.downloadFile')} → downloads/{localPath || ''}
            </button>
            {notice && (
              <p className="mt-2 text-center text-xs text-t-secondary" role="status">
                {notice}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

// Catalog view: remote folders as an AniList-metadata poster grid.
function CatalogGrid({
  serverId,
  path,
  onSelect,
  selected,
}: {
  serverId: number
  path: string
  onSelect: (e: Entry) => void
  selected?: string
}) {
  const { t } = useTranslation()
  const { data: items = [], isLoading, error } = useQuery<CatalogItem[]>({
    queryKey: ['catalog', serverId, path],
    queryFn: () => api.get(`/api/servers/${serverId}/catalog${path ? `?path=${encodeURIComponent('/' + path)}` : ''}`),
    staleTime: 5 * 60_000,
  })
  const [rematch, setRematch] = useState<CatalogItem | null>(null)

  if (isLoading)
    return (
      <p className="p-6 text-sm text-t-muted" role="status">
        {t('browser.catalogLoading')}
      </p>
    )
  if (error) return <p className="p-6 text-sm text-err">{error instanceof Error ? error.message : t('app.error')}</p>
  if (items.length === 0) return <p className="p-6 text-sm text-t-muted">{t('browser.noFolders')}</p>

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {items.map((it) => (
          <article
            key={it.entry.path}
            className={`t-panel group flex flex-col ${selected === it.entry.path ? 'outline outline-2 outline-accent' : ''}`}
          >
            <button
              className="text-left"
              onClick={() => onSelect(it.entry)}
              aria-label={t('browser.selectItem', { name: it.entry.name })}
            >
              {it.media?.coverImage?.large ? (
                <img
                  src={it.media.coverImage.large}
                  alt=""
                  loading="lazy"
                  className="aspect-2/3 w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                />
              ) : (
                <div className="t-hatch grid aspect-2/3 w-full place-items-center text-t-muted">{t('browser.noMatch')}</div>
              )}
              <div className="p-2">
                <h4 className="line-clamp-2 text-sm font-medium text-t-primary" title={it.media?.title.romaji ?? it.entry.name}>
                  {it.media?.title.romaji ?? it.entry.name}
                </h4>
                <p className="truncate font-mono text-[10px] text-t-muted" title={it.entry.name}>
                  {it.entry.name}
                </p>
                {it.media && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {it.media.seasonYear > 0 && <span className="t-label">{it.media.seasonYear}</span>}
                    {it.media.episodes > 0 && <span className="t-label">{it.media.episodes} EP</span>}
                    {it.media.averageScore > 0 && <span className="t-label t-label--accent">★ {it.media.averageScore}</span>}
                  </div>
                )}
              </div>
            </button>
            <button className="t-btn t-btn--sm mx-2 mb-2 mt-auto" onClick={() => setRematch(it)}>
              {t('browser.changeMatch')}
            </button>
          </article>
        ))}
      </div>
      {rematch && <RematchDialog serverId={serverId} item={rematch} onClose={() => setRematch(null)} />}
    </div>
  )
}

function RematchDialog({ serverId, item, onClose }: { serverId: number; item: CatalogItem; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const ref = useRef<HTMLDialogElement>(null)
  const [q, setQ] = useState(item.entry.name)
  const [results, setResults] = useState<Media[]>([])

  // real modal: focus trap + Escape via the native dialog
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const search = async () => setResults(await api.get<Media[]>(`/api/anilist/search?q=${encodeURIComponent(q)}`))
  const pick = async (mediaId: number) => {
    await api.put(`/api/servers/${serverId}/catalog/match`, { folder: item.entry.path, mediaId })
    qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    onClose()
  }

  return (
    <dialog ref={ref} className="w-full max-w-lg" aria-label={t('browser.matchFor', { name: item.entry.name })} onClose={onClose}>
      <div className="p-5">
        <h3 className="mb-3 font-display font-semibold tracking-wider">MATCH: {item.entry.name}</h3>
        <div className="mb-3 flex gap-2">
          <label className="sr-only" htmlFor="rematch-q">
            {t('browser.search')}
          </label>
          <input
            id="rematch-q"
            className="t-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button className="t-btn shrink-0" onClick={search}>
            {t('browser.search')}
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
        <div className="mt-4 flex justify-between">
          <button className="t-btn t-btn--danger t-btn--sm" onClick={() => pick(0)}>
            {t('browser.removeMatch')}
          </button>
          <button className="t-btn" onClick={() => ref.current?.close()}>
            {t('browser.close')}
          </button>
        </div>
      </div>
    </dialog>
  )
}
