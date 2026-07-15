import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, type CatalogItem, type Entry, type Media, type ServerInfo } from '../api'
import { FileBrowser, LocalPicker } from '../components/FileBrowser'
import WatchDialog from '../components/WatchDialog'

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
  const [watchOpen, setWatchOpen] = useState(false)

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
            <button className="t-btn mt-2 w-full" disabled={!selection?.isDir} onClick={() => setWatchOpen(true)}>
              {t('watch.add')}
            </button>
            {notice && (
              <p className="mt-2 text-center text-xs text-t-secondary" role="status">
                {notice}
              </p>
            )}
          </div>
        </section>
      </div>
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
    // matching runs server-side in the background: poll while items are pending
    refetchInterval: (q) => (q.state.data?.some((i) => i.pending) ? 2500 : false),
  })
  const qc = useQueryClient()
  const [rematch, setRematch] = useState<CatalogItem | null>(null)
  const [detail, setDetail] = useState<CatalogGroup | null>(null)
  const pendingCount = items.filter((i) => i.pending).length
  const noMatchCount = items.filter((i) => !i.media && !i.pending).length

  const triggerRematch = async (all: boolean) => {
    if (all && !confirm(t('browser.confirmRematchAll'))) return
    await api.post(`/api/servers/${serverId}/catalog/rematch`, { path: path ? '/' + path : '', all })
    qc.invalidateQueries({ queryKey: ['catalog', serverId, path] })
  }

  // bundle folders matched to the same anime into one card; the version
  // (folder) is picked in a dialog. Unmatched/pending folders stay individual.
  const groups = useMemo(() => {
    const out: CatalogGroup[] = []
    const byMedia = new Map<number, CatalogGroup>()
    for (const it of items) {
      const existing = it.media && byMedia.get(it.media.id)
      if (existing) {
        existing.items.push(it)
        continue
      }
      const g: CatalogGroup = { key: it.media ? `m${it.media.id}` : it.entry.path, media: it.media, pending: it.pending, items: [it] }
      if (it.media) byMedia.set(it.media.id, g)
      out.push(g)
    }
    return out
  }, [items])

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
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {pendingCount > 0 ? (
          <p className="text-xs text-t-muted" role="status">
            {t('browser.matchingCount', { count: pendingCount })}
          </p>
        ) : (
          <>
            {noMatchCount > 0 && (
              <button className="t-btn t-btn--sm" onClick={() => triggerRematch(false)}>
                {t('browser.retryUnmatched', { count: noMatchCount })}
              </button>
            )}
            <button className="t-btn t-btn--sm" onClick={() => triggerRematch(true)}>
              {t('browser.rematchAll')}
            </button>
          </>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {groups.map((g) => {
          const it = g.items[0]
          const multi = g.items.length > 1
          const isSelected = g.items.some((v) => v.entry.path === selected)
          return (
            <article
              key={g.key}
              className={`t-panel group flex flex-col ${isSelected ? 'outline outline-2 outline-accent' : ''}`}
            >
              <button
                className="text-left"
                onClick={() => (g.media ? setDetail(g) : onSelect(it.entry))}
                aria-label={
                  g.media
                    ? t('browser.detailsFor', { name: g.media.title.romaji })
                    : t('browser.selectItem', { name: it.entry.name })
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
                    {t('browser.matching')}
                  </div>
                ) : (
                  <div className="t-hatch grid aspect-2/3 w-full place-items-center text-t-muted">{t('browser.noMatch')}</div>
                )}
                <div className="p-2">
                  <h4 className="line-clamp-2 text-sm font-medium text-t-primary" title={g.media?.title.romaji ?? it.entry.name}>
                    {g.media?.title.romaji ?? it.entry.name}
                  </h4>
                  {multi ? (
                    <p className="font-mono text-[10px] text-accent">{t('browser.versions', { count: g.items.length })}</p>
                  ) : (
                    <p className="truncate font-mono text-[10px] text-t-muted" title={it.entry.name}>
                      {it.entry.name}
                    </p>
                  )}
                  {g.media && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {g.media.seasonYear > 0 && <span className="t-label">{g.media.seasonYear}</span>}
                      {g.media.episodes > 0 && <span className="t-label">{g.media.episodes} EP</span>}
                      {g.media.averageScore > 0 && <span className="t-label t-label--accent">★ {g.media.averageScore}</span>}
                    </div>
                  )}
                </div>
              </button>
              {!multi && (
                <button className="t-btn t-btn--sm mx-2 mb-2 mt-auto" onClick={() => setRematch(it)}>
                  {t('browser.changeMatch')}
                </button>
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
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

interface CatalogGroup {
  key: string
  media?: Media
  pending?: boolean
  items: CatalogItem[]
}

// DetailDialog shows the anime's full metadata (banner, description, trailer,
// genres) plus every folder version matched to it, each selectable for sync
// and individually re-matchable.
function DetailDialog({
  group,
  selected,
  onSelect,
  onRematch,
  onClose,
}: {
  group: CatalogGroup
  selected?: string
  onSelect: (e: Entry) => void
  onRematch: (it: CatalogItem) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const m = group.media!
  const trailerUrl =
    m.trailer?.site === 'youtube'
      ? `https://www.youtube.com/watch?v=${m.trailer.id}`
      : m.trailer?.site === 'dailymotion'
        ? `https://www.dailymotion.com/video/${m.trailer.id}`
        : undefined

  return (
    <dialog ref={ref} className="w-full max-w-2xl" aria-label={t('browser.detailsFor', { name: m.title.romaji })} onClose={onClose}>
      {m.bannerImage && <img src={m.bannerImage} alt="" className="max-h-36 w-full object-cover" />}
      <div className="p-5">
        <div className="flex gap-4">
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
              {m.status && <span className="t-label">{t(`browser.status.${m.status}`, m.status)}</span>}
              {m.averageScore > 0 && <span className="t-label t-label--accent">★ {m.averageScore}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {m.genres?.map((g) => (
                <span key={g} className="t-label">
                  {g}
                </span>
              ))}
            </div>
            <p className="mt-1 font-mono text-[10px] text-t-muted">
              <a className="hover:text-accent" href={`https://anilist.co/anime/${m.id}`} target="_blank" rel="noreferrer">
                AniList #{m.id}
              </a>
            </p>
          </div>
        </div>
        {m.description && (
          <p className="mt-3 max-h-32 overflow-y-auto text-sm whitespace-pre-line text-t-secondary">
            {/* AniList descriptions still carry some inline HTML */}
            {m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')}
          </p>
        )}
        {trailerUrl && (
          <a className="t-btn t-btn--sm mt-3 inline-flex items-center gap-2" href={trailerUrl} target="_blank" rel="noreferrer">
            ▶ {t('browser.trailer')}
            {m.trailer?.thumbnail && <img src={m.trailer.thumbnail} alt="" className="h-6 object-cover" />}
          </a>
        )}

        <h4 className="t-label mt-4 mb-1">{t('browser.versions', { count: group.items.length })}</h4>
        <ul className="max-h-48 overflow-y-auto">
          {group.items.map((it) => (
            <li key={it.entry.path} className="flex items-center gap-2 border-b border-border-subtle px-2 py-2">
              <span
                className={`min-w-0 flex-1 truncate text-sm ${selected === it.entry.path ? 'text-accent' : ''}`}
                title={it.entry.path}
              >
                {it.entry.name}
              </span>
              <button className="t-btn t-btn--sm t-btn--primary shrink-0" onClick={() => onSelect(it.entry)}>
                {t('browser.select')}
              </button>
              <button className="t-btn t-btn--sm shrink-0" onClick={() => onRematch(it)}>
                {t('browser.changeMatch')}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button className="t-btn" onClick={() => ref.current?.close()}>
            {t('browser.close')}
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
  const [q, setQ] = useState(item.entry.name)
  const [results, setResults] = useState<Media[]>([])

  // real modal: focus trap + Escape via the native dialog
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  // search accepts a title, a bare AniList ID or an anilist.co link
  const search = async () => {
    const idm = q.match(/anilist\.co\/anime\/(\d+)/) ?? q.match(/^\s*(\d+)\s*$/)
    try {
      setResults(
        idm
          ? [await api.get<Media>(`/api/anilist/media/${idm[1]}`)]
          : await api.get<Media[]>(`/api/anilist/search?q=${encodeURIComponent(q)}`),
      )
    } catch {
      setResults([])
    }
  }
  const pick = async (mediaId: number) => {
    await api.put(`/api/servers/${serverId}/catalog/match`, { folder: item.entry.path, mediaId })
    qc.invalidateQueries({ queryKey: ['catalog', serverId] })
    onClose()
  }

  return (
    <dialog ref={ref} className="w-full max-w-lg" aria-label={t('browser.matchFor', { name: item.entry.name })} onClose={onClose}>
      <div className="p-5">
        <h3 className="mb-1 font-display font-semibold tracking-wider">MATCH: {item.entry.name}</h3>
        {item.media && (
          <p className="mb-2 text-xs text-t-muted">
            {t('browser.currentMatch', { title: item.media.title.romaji, id: item.media.id })}
          </p>
        )}
        <div className="mb-1 flex gap-2">
          <label className="sr-only" htmlFor="rematch-q">
            {t('browser.search')}
          </label>
          <input
            id="rematch-q"
            className="t-input"
            value={q}
            placeholder={t('browser.searchHint')}
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
