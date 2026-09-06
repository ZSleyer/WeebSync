import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Download, Eye, Files as FilesIcon, Folder, HardDrive, Info, Pencil, Plus, RefreshCw, Replace, Search, Server, Star, Trash2, Undo2, X } from 'lucide-react'

// icon per AniList airing status, shown inside the detail dialog's t-label chip
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import MediaDetail from '../components/MediaDetail'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { Badge, Button, Cover, Dialog, EmptyState, Input, Panel, Segmented, Select } from '@weebsync/design-system'
import { api, fmtBytes, mediaTitle, type CatalogItem, type CatalogResponse, type Entry, type Media, type SearchResult, type ServerInfo } from '../api'
import { CATALOG_SORTS, sortGroups, useCatalogSort, type CatalogSort } from '../components/catalogSort'
import { CatalogViewSwitch } from '../components/CatalogViewSwitch'
import { ServerIcon } from '../components/serverIcon'
import { useCatalogView } from '../components/useCatalogView'
import { FileBrowser, LocalPicker, PathCrumbs } from '../components/FileBrowser'
import PathInput from '../components/PathInput'
import FileIcon from '../components/FileIcon'
import PageActions from '../components/PageActions'
import RenameOptions, { type RenameProfile, type RenameRule } from '../components/RenameOptions'
import RenamePreview from '../components/RenamePreview'
import { useRenamePreview } from '../components/useRenamePreview'
import { syncTargetDir, useTargetFolder } from '../components/useTargetFolder'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { applyDefaults, useFolderKind, useWatchDefaults } from '../components/watchDefaults'
import { useConfirm } from '../components/confirm'
import { usePrompt } from '../components/prompt'
import { useAuth } from '../hooks'
import Loading from '../components/Loading'

// Where the browser is looking: the local library or one of the servers. An
// explicit union, never a bare 0 - the catalog API addresses the local library
// as server 0, and a numeric state made "no server chosen yet" and "local"
// the same value.
type Source = 'local' | number
const SOURCE_KEY = 'weebsync.files.source'

const sourceFromParams = (p: URLSearchParams): Source | null => {
  if (p.get('source') === 'local') return 'local'
  const id = Number(p.get('server'))
  return id > 0 ? id : null
}
const sourceFromStorage = (): Source | null => {
  try {
    const v = localStorage.getItem(SOURCE_KEY)
    if (v === 'local') return 'local'
    const id = Number(v)
    return id > 0 ? id : null
  } catch {
    return null
  }
}

// One browser for every source: the local library and each server. Browse,
// search a server's index, switch to the catalog view, sync once, watch, and
// on the local library (admins) rename and delete. Replaces the Remote and
// Local pages; their URLs redirect here with the folder kept.
export default function Files() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const [params, setParams] = useSearchParams()
  // the source from the link, else the one used last, else the first server
  // once the list is in, else the local library
  const [chosen, setChosen] = useState<Source | null>(() => sourceFromParams(params) ?? sourceFromStorage())
  const source: Source = chosen ?? servers[0]?.id ?? 'local'
  const isLocal = source === 'local'
  // the catalog API addresses the local library as server 0
  const active = isLocal ? 0 : source
  // deep links (the dashboard queue, suggestions) open the browser at a folder
  const [path, setPath] = useState((params.get('path') ?? '').replace(/^\//, ''))
  const [localPath, setLocalPath] = useState('')
  const [selection, setSelection] = useState<Entry | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // the dialogs carry their own entry: a catalog card acts on itself without
  // going through the selection, which would pop the action bar open as a
  // second copy of the same two buttons
  const [watchEntry, setWatchEntry] = useState<Entry | null>(null)
  const [syncEntry, setSyncEntry] = useState<Entry | null>(null)
  // the user's defaults fill a new watch: its kind comes from the folder's
  // catalog match, a target picked on this page wins over the default one
  const { data: defaults } = useWatchDefaults()
  const { data: watchKind, isPending: kindPending } = useFolderKind(active, watchEntry?.path)
  const [flat, setFlat] = useState(false)
  // once the user touched the checkbox its value stands, seed or not
  const [flatTouched, setFlatTouched] = useState(false)
  const { data: syncKind, isPending: syncKindPending } = useFolderKind(active, syncEntry?.path)
  const syncSeed = syncEntry && !syncKindPending ? applyDefaults(blankWatch(syncEntry.path, localPath), syncKind?.kind, defaults) : null
  // a target picked on this page wins, the default one fills in otherwise;
  // the subfolder choice follows the default only while nothing was picked
  const syncLocal = localPath || syncSeed?.localPath || ''
  const syncFlat = flatTouched || localPath || !syncSeed || !syncEntry?.isDir ? flat : !syncSeed.subfolder
  const [query, setQuery] = useState(params.get('q') ?? '')

  // the URL follows the browser, so a dialog round-trip, a reload and the
  // system back gesture all land in the same folder
  useEffect(() => {
    const next = new URLSearchParams()
    if (isLocal) next.set('source', 'local')
    else next.set('server', String(source))
    if (path) next.set('path', path)
    if (query.trim()) next.set('q', query)
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [isLocal, source, path, query, params, setParams])
  const pickSource = (s: Source) => {
    setChosen(s)
    setPath('')
    setSelection(null)
    setQuery('')
    try {
      localStorage.setItem(SOURCE_KEY, String(s))
    } catch {
      /* best effort */
    }
  }

  // default classic, catalog only for folders the user saved as catalog
  // (server-side scope mark); "once"/"saved" switch and persist per folder
  const { view, value: viewValue, set: setView } = useCatalogView(active, path)

  const [lastIds, setLastIds] = useState<number[]>([])
  const enqueue = useMutation({
    // with a rename rule the one-off sync endpoint applies the full watch
    // pipeline (template, aired mapping) without persisting a watch; note the
    // inverted flag: handleSyncOnce derives flat from !subfolder
    mutationFn: ({ entry, rename }: { entry: Entry; rename: RenameRule | null }) =>
      rename
        ? api.post<{ queued: number; ids: number[] }>('/api/downloads/sync', {
            serverId: active,
            remotePath: entry.path,
            localPath: syncLocal,
            subfolder: !(syncFlat && entry.isDir),
            ...rename,
          })
        : api.post<{ queued: number; ids: number[] }>('/api/downloads', {
            serverId: active,
            remotePath: entry.path,
            localPath: syncLocal,
            flat: syncFlat && entry.isDir,
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

  // the local library is edited through the selection: rename and delete
  // cannot be undone, so both go through a blocking modal. Admins only.
  const canEdit = isLocal && !!user?.isAdmin
  const refreshLocal = () => {
    qc.invalidateQueries({ queryKey: ['local'] })
    qc.invalidateQueries({ queryKey: ['catalog', 0] })
    setSelection(null)
  }
  const renameLocal = async (e: Entry) => {
    const name = await prompt({
      title: t('local.renameTitle', { name: e.name }),
      defaultValue: e.name,
      confirmLabel: t('local.rename'),
    })
    if (!name || name === e.name) return
    setError('')
    try {
      await api.post('/api/browse/local/rename', { path: e.path, name })
      refreshLocal()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }
  const removeLocal = async (e: Entry) => {
    const ok = await confirm({
      message: e.isDir ? t('local.deleteDirConfirm', { name: e.name }) : t('local.deleteConfirm', { name: e.name }),
      confirmLabel: t('local.delete'),
      destructive: true,
    })
    if (!ok) return
    setError('')
    try {
      // recursive only for directories: a folder the user confirmed goes
      // completely, a file needs no flag
      await api.del('/api/browse/local', { path: e.path, recursive: e.isDir })
      refreshLocal()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }
  // the catalog cards keep their own edit buttons: a card acts on itself
  const cardActions = (e: Entry) =>
    canEdit ? (
      <span className="flex shrink-0 gap-1.5">
        <Button size="sm" aria-label={t('local.renameItem', { name: e.name })} title={t('local.rename')} onClick={() => renameLocal(e)}>
          <Pencil aria-hidden size="1.2em" />
        </Button>
        <Button size="sm" variant="danger" aria-label={t('local.deleteItem', { name: e.name })} title={t('local.delete')} onClick={() => removeLocal(e)}>
          <X aria-hidden size="1.2em" />
        </Button>
      </span>
    ) : undefined

  const navigate = (p: string) => {
    setPath(p.replace(/^\//, ''))
    setSelection(null)
  }
  const browseUrl = (p: string) =>
    isLocal ? `/api/browse/local?path=${encodeURIComponent(p)}` : `/api/servers/${active}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`
  // rows are selectable wherever the selection bar has something to offer
  const selectable = !isLocal || canEdit

  return (
    <div className="page-fill flex min-h-0 flex-1 flex-col">
      {/* the in-page heading is the desktop's; on a phone the app bar carries
          the title and the view switch, and the source row stands alone.
          Sources are a pressed-button group like the views: one control style
          across the app instead of a dropdown here and buttons there.
          ponytail: the group wraps past three or four sources, a menu if that
          ever happens */}
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="mr-auto hidden lg:block">
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('files.title')}</h2>
          <Badge className="mt-1">{t('files.sub')}</Badge>
        </div>
        <Segmented
          aria-label={t('remote.source')}
          className="min-w-0 flex-1 lg:flex-none"
          value={String(source)}
          onChange={(v) => pickSource(v === 'local' ? 'local' : Number(v))}
          options={[
            // the local library always draws the drive; a server draws its
            // picture when it has one, its name otherwise. Names stay on
            // desktop, the phone gets the picture alone
            {
              value: 'local',
              'aria-label': t('files.local'),
              label: (
                <>
                  <HardDrive aria-hidden size="1em" />
                  <span className="ml-1 hidden lg:inline">{t('files.local')}</span>
                </>
              ),
            },
            ...servers.map((s) => ({
              value: String(s.id),
              'aria-label': s.name,
              label: s.icon ? (
                <>
                  <ServerIcon name={s.icon} aria-hidden size="1em" />
                  <span className="ml-1 hidden lg:inline">{s.name}</span>
                </>
              ) : (
                s.name
              ),
            })),
          ]}
        />
        <Link to="/settings/servers" aria-label={t('files.manageSources')} title={t('files.manageSources')} className="t-iconbtn text-t-muted hover:text-accent">
          {/* a server with a plus in the corner: this is where servers get added */}
          <span className="relative inline-block pr-1.5 pb-1.5">
            <Server aria-hidden size="1.25em" />
            <Plus aria-hidden size="0.75em" strokeWidth={3} className="absolute right-0 bottom-0" />
          </span>
        </Link>
        <PageActions>
          <CatalogViewSwitch value={viewValue} onChange={setView} />
        </PageActions>
      </header>

      {!isLocal && servers.length === 0 ? (
        <EmptyState>
          <Trans i18nKey="remote.noServers">
            Erst unter <Link to="/settings/servers" className="text-accent underline">Server</Link> eine Quelle anlegen.
          </Trans>
        </EmptyState>
      ) : (
        <Panel as="section" className="flex min-h-64 min-w-0 flex-1 flex-col lg:min-h-0" aria-label={t('files.title')}>
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <Badge tone="accent">{isLocal ? t('remote.local') : t('remote.remote')}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-muted">
              {selection ? selection.path : path ? `/${path}` : t('remote.noSelection')}
            </span>
            {!isLocal && (
              <Input
                className="w-40 sm:w-56"
                size="sm"
                type="search"
                placeholder={t('remote.search')}
                aria-label={t('remote.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>
          {error && (
            <p className="border-b border-border-subtle px-3 py-2 text-xs text-err" role="alert">
              {error}
            </p>
          )}
          {!isLocal && query.trim() ? (
            <SearchResults
              serverId={active}
              query={query}
              onOpenDir={(p) => {
                navigate(p)
                setQuery('')
              }}
              onSelect={setSelection}
              selected={selection?.path}
            />
          ) : view === 'classic' ? (
            <FileBrowser
              queryKey={isLocal ? ['local'] : ['remote', active]}
              fetchPath={browseUrl}
              path={path}
              onNavigate={navigate}
              onSelect={selectable ? setSelection : undefined}
              selected={selection?.path}
              emptyHint={isLocal ? t('remote.emptyLocal') : undefined}
            />
          ) : (
            <CatalogGrid
              serverId={active}
              path={path}
              onNavigate={navigate}
              onSelect={selectable ? setSelection : () => {}}
              selected={selection?.path}
              onSync={isLocal ? undefined : setSyncEntry}
              onWatch={isLocal ? undefined : setWatchEntry}
              cardActions={isLocal ? cardActions : undefined}
              onOpenFiles={(p) => {
                // opening a title's files navigates into a subfolder; the view
                // re-derives from that folder's own scope (marks don't inherit,
                // so it lands in the classic list) - no explicit reset needed
                navigate(p)
                if (isLocal) setView('classic')
              }}
            />
          )}
        </Panel>
      )}

      {/* action bar: the last row of the page-fill column, directly above the
          phone's tab bar, so the primary action sits under the thumb. It
          appears with a selection (or a pending notice) so the list keeps
          the full height otherwise. */}
      {(selection || notice) && (
        <Panel role="region" aria-label={t('remote.selectionBar')} className="mt-4 flex flex-wrap items-center gap-2 p-3">
          {selection && (
            <span className="min-w-28 flex-1 truncate text-sm text-t-secondary" title={selection.path}>
              <FileIcon isDir={selection.isDir} name={selection.name} className="mr-1.5 inline align-[-2px]" />
              {selection.name}
            </span>
          )}
          {notice && (
            <span className="flex items-center gap-2 text-xs text-t-secondary" role="status">
              {notice}
              {lastIds.length > 0 && (
                <Button size="sm" variant="danger" onClick={cancelLast}>
                  <Undo2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('remote.undoSync')}
                </Button>
              )}
            </span>
          )}
          {selection && canEdit && (
            <>
              <Button size="sm" aria-label={t('local.renameItem', { name: selection.name })} onClick={() => renameLocal(selection)}>
                <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('local.rename')}
              </Button>
              <Button size="sm" variant="danger" aria-label={t('local.deleteItem', { name: selection.name })} onClick={() => removeLocal(selection)}>
                <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('local.delete')}
              </Button>
            </>
          )}
          {selection && !isLocal && (
            <>
              <Button size="sm" disabled={!selection.isDir} onClick={() => setWatchEntry(selection)}>
                <Eye aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('watch.add')}
              </Button>
              <Button size="sm" variant="primary" cut onClick={() => setSyncEntry(selection)}>
                <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.syncOpen')}
              </Button>
            </>
          )}
        </Panel>
      )}

      {syncEntry && syncSeed && (
        <SyncDialog
          entry={syncEntry}
          serverId={active}
          localPath={syncLocal}
          onLocalPath={setLocalPath}
          flat={syncFlat}
          onFlat={(v) => {
            setFlatTouched(true)
            setFlat(v)
          }}
          seed={syncSeed}
          pending={enqueue.isPending}
          onConfirm={(rename) => {
            enqueue.mutate({ entry: syncEntry, rename })
            setSyncEntry(null)
          }}
          onClose={() => setSyncEntry(null)}
        />
      )}
      {watchEntry && !kindPending && (
        <WatchDialog
          title={t('watch.addTitle', { name: watchEntry.name })}
          serverId={active}
          initial={applyDefaults(blankWatch(watchEntry.path, localPath), watchKind?.kind, defaults)}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: active, ...f })
            setNotice(t('watch.created'))
          }}
          onClose={() => setWatchEntry(null)}
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
              <FileIcon isDir={e.isDir} name={e.name} />
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
  const [sort, setSort] = useCatalogSort()
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
    return sortGroups(out, sort)
  }, [items, sort])

  // the breadcrumb is outside the loading/error branches on purpose: without
  // it a slow or failing folder would be a dead end with no way back up
  // same browse endpoints (and query keys) as the classic FileBrowser so the
  // path-edit autocomplete reuses any listing already cached
  const browseUrl = (p: string) =>
    serverId === 0
      ? `/api/browse/local?path=${encodeURIComponent(p)}`
      : `/api/servers/${serverId}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`
  const crumbs = (
    <PathCrumbs
      path={path}
      onNavigate={onNavigate}
      fetchPath={browseUrl}
      queryKey={serverId === 0 ? ['local'] : ['remote', serverId]}
    />
  )

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
          <Select wrapperClassName="w-44" value={data?.scope ?? ''} onChange={(e) => setScope(e.target.value)}>
            <option value="" disabled>
              {t('remote.scopeNone')}
            </option>
            <option value="anime">{t('remote.scopeAnime')}</option>
            <option value="tv">{t('remote.scopeTv')}</option>
            <option value="movie">{t('remote.scopeMovie')}</option>
            {caps?.tvdbApiKeySet && <option value="tvdb">{t('remote.scopeTvdb')}</option>}
          </Select>
        </label>
        {groups.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-t-muted">
            {t('remote.sort')}
            <Select wrapperClassName="w-44" value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
              {CATALOG_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`remote.sort_${s}`)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {data && data.scope !== '' && (
          <Button size="sm" title={t('remote.scopeClearHint')} onClick={() => setScope('')}>
            {t('remote.scopeClear')}
          </Button>
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
                <Button size="sm" onClick={() => triggerRematch(false)}>
                  {t('remote.retryUnmatched', { count: noMatchCount })}
                </Button>
              )}
              <Button size="sm" onClick={() => triggerRematch(true)}>
                {t('remote.rematchAll')}
              </Button>
            </>
          )
        )}
      </div>
      {/* a leaf folder holds files, not titles: offer the classic list instead
          of leaving the user at a dead end */}
      {items.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 p-6">
          <p className="text-sm text-t-muted">{t('remote.noFolders')}</p>
          <Button size="sm" onClick={() => onOpenFiles(path)}>
            {t('remote.showFiles')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {groups.map((g) => {
          const it = g.items[0]
          const multi = g.items.length > 1
          // the file-count heuristic reads a season that has aired one episode
          // so far as a film; where a match exists, it knows better
          const kind = g.media && g.media.episodes > 1 ? 'series' : it.kind
          const isSelected = g.items.some((v) => v.entry.path === selected)
          return (
            <Panel
              as="article"
              key={g.key}
              className={`group relative flex flex-col ${isSelected ? 'outline-2 outline-accent' : ''}`}
            >
              {/* rematch tucked away as a pencil over the cover (hover/focus);
                  unmatched folders keep the explicit button below instead */}
              {g.media && !multi && !!it.source && (
                <Button
                  size="sm"
                  className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('remote.changeMatch')}
                  title={t('remote.changeMatch')}
                  onClick={() => setRematch(it)}
                >
                  <Pencil aria-hidden size="1.2em" />
                </Button>
              )}
              <button
                className="text-left"
                onClick={() => (g.media ? setDetail(g) : onSelect(it.entry))}
                aria-label={
                  g.media
                    ? t('remote.detailsFor', { name: mediaTitle(g.media) })
                    : t('remote.selectItem', { name: it.entry.name })
                }
              >
                {g.media?.coverImage?.large ? (
                  <Cover
                    size="fill"
                    src={g.media.coverImage.large}
                    loading="lazy"
                    className="opacity-90 transition-opacity group-hover:opacity-100"
                  />
                ) : g.pending ? (
                  <Cover size="fill" className="animate-pulse text-t-muted">
                    {t('remote.matching')}
                  </Cover>
                ) : (
                  <Cover size="fill" className="text-t-muted">
                    {it.source ? t('remote.noMatch') : ''}
                  </Cover>
                )}
                <div className="p-2">
                  <h4 className="line-clamp-2 text-sm font-medium text-t-primary" title={mediaTitle(g.media, it.entry.name)}>
                    {mediaTitle(g.media, it.entry.name)}
                  </h4>
                  {multi ? (
                    <p className="font-mono text-[10px] text-accent">{t('remote.versions', { count: g.items.length })}</p>
                  ) : (
                    <p className="truncate font-mono text-[10px] text-t-muted" title={it.entry.name}>
                      {it.entry.name}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {kind && (
                      <Badge tone={kind === 'movie' ? 'accent' : 'neutral'}>
                        {t(kind === 'movie' ? 'remote.kindMovie' : 'remote.kindSeries')}
                      </Badge>
                    )}
                    {g.media && (
                      <>
                        {g.media.seasonYear > 0 && <Badge>{g.media.seasonYear}</Badge>}
                        {g.media.episodes > 0 && <Badge>{g.media.episodes} EP</Badge>}
                        {g.media.averageScore > 0 && <Badge tone="accent"><Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />{g.media.averageScore}</Badge>}
                      </>
                    )}
                  </div>
                  {/* local catalog: what is actually on disk, and how it
                      compares to what the provider lists */}
                  {it.local && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <Badge
                        tone={
                          g.media && g.media.episodes > 0 && it.local.videos >= g.media.episodes ? 'ok' : 'neutral'
                        }
                      >
                        {t('local.videoCount', { count: it.local.videos })}
                      </Badge>
                      <Badge>{fmtBytes(it.local.bytes)}</Badge>
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
                // four icon buttons at the touch size of --ctl-h-sm need 180px,
                // a catalog tile offers 140: the square minimum has to go here
                // or the last button hangs over the card's edge. Height keeps
                // the touch target, width drops to the WCAG 2.5.8 floor, and
                // flex-wrap catches the card that adds a fifth action. Centred
                // rather than stretched, so the gap left of the row matches the
                // one on its right whatever the tile's width.
                <div className="mx-2 mb-2 mt-auto flex flex-wrap justify-center gap-1.5 [&_.t-btn]:min-w-6! [&_.t-btn]:px-1!">
                  <Button
                    size="sm"
                    aria-label={t('remote.detailsFor', { name: mediaTitle(g.media) })}
                    title={t('remote.details')}
                    onClick={() => setDetail(g)}
                  >
                    <Info aria-hidden size="1.2em" />
                  </Button>
                  {!multi && (
                    <>
                      <Button
                        size="sm"
                        aria-label={`${t('remote.showFiles')}: ${it.entry.name}`}
                        title={t('remote.showFiles')}
                        onClick={() => onOpenFiles(it.entry.path)}
                      >
                        <FilesIcon aria-hidden size="1.2em" />
                      </Button>
                      {onSync && (
                        <Button
                          size="sm"
                          aria-label={`${t('plex.syncOnce')}: ${it.entry.name}`}
                          title={t('plex.syncOnce')}
                          onClick={() => onSync(it.entry)}
                        >
                          <Download aria-hidden size="1.2em" />
                        </Button>
                      )}
                      {onWatch && (
                        <Button
                          size="sm"
                          aria-label={`${t('watch.add')}: ${it.entry.name}`}
                          title={t('watch.add')}
                          onClick={() => onWatch(it.entry)}
                        >
                          <Eye aria-hidden size="1.2em" />
                        </Button>
                      )}
                      {cardActions?.(it.entry)}
                    </>
                  )}
                </div>
              ) : (
                // "Match ändern" spelled out needs 114px of a 131px tile, so it
                // claimed a line of its own and pushed the rename/delete pair
                // onto a third. As an icon it joins the row: same action, same
                // Replace glyph the detail dialog uses, name in title/aria.
                <div className="mx-2 mb-2 mt-auto flex flex-wrap justify-center gap-1.5 [&_.t-btn]:min-w-6! [&_.t-btn]:px-1!">
                  <Button
                    size="sm"
                    className="shrink-0"
                    aria-label={`${t('remote.showFiles')}: ${it.entry.name}`}
                    title={t('remote.showFiles')}
                    onClick={() => onOpenFiles(it.entry.path)}
                  >
                    <FilesIcon aria-hidden size="1.2em" />
                  </Button>
                  {!g.pending && !!it.source && (
                    <Button
                      size="sm"
                      aria-label={`${t('remote.changeMatch')}: ${it.entry.name}`}
                      title={t('remote.changeMatch')}
                      onClick={() => setRematch(it)}
                    >
                      <Replace aria-hidden size="1.2em" />
                    </Button>
                  )}
                  {cardActions?.(it.entry)}
                </div>
              )}
            </Panel>
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
          onSync={
            onSync &&
            ((e) => {
              setDetail(null)
              onSync(e)
            })
          }
          onWatch={
            onWatch &&
            ((e) => {
              setDetail(null)
              onWatch(e)
            })
          }
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
// The optional rename rule is per-dialog: a one-off sync through the watch
// pipeline, so it starts empty every time.
const EMPTY_RULE: RenameRule = {
  mode: 'template',
  template: '',
  separator: '',
  titleOverride: '',
  pattern: '',
  replacement: '',
  fromEpisode: 0,
  airedMapping: false,
  renameProvider: '',
  renameOrdering: '',
  renameTitleLang: '',
  renameSeriesId: 0,
}

// ruleOf is the rename half of a watch's fields.
const ruleOf = (f: WatchFields): RenameRule => ({
  mode: f.mode,
  template: f.template,
  separator: f.separator,
  titleOverride: f.titleOverride,
  pattern: f.pattern,
  replacement: f.replacement,
  fromEpisode: f.fromEpisode,
  airedMapping: f.airedMapping,
  renameProvider: f.renameProvider,
  renameOrdering: f.renameOrdering,
  renameTitleLang: f.renameTitleLang,
  renameSeriesId: f.renameSeriesId,
})

// blankWatch is what a dialog starts from before the user's defaults apply.
const blankWatch = (remotePath: string, localPath: string): WatchFields => ({
  ...EMPTY_RULE,
  remotePath,
  localPath,
  subfolder: false,
  mediaId: 0,
  mediaSource: 'anilist',
  wantDub: '',
  wantSub: '',
  plexAudioLang: '',
  plexSubLang: '',
})

function SyncDialog({
  entry,
  serverId,
  localPath,
  onLocalPath,
  flat,
  onFlat,
  pending,
  onConfirm,
  onClose,
  seed,
}: {
  entry: Entry
  serverId: number
  localPath: string
  onLocalPath: (p: string) => void
  flat: boolean
  onFlat: (v: boolean) => void
  pending: boolean
  onConfirm: (rename: RenameRule | null) => void
  onClose: () => void
  /** the user's defaults for this folder's kind, applied on open */
  seed?: WatchFields
}) {
  const { t } = useTranslation()
  const [browse, setBrowse] = useState(false)
  // the user's defaults seed the rename rule once, on open
  const [renameOn, setRenameOn] = useState(!!seed?.template)
  const [rule, setRule] = useState<RenameRule>(() => (seed ? ruleOf(seed) : EMPTY_RULE))
  const { data: caps } = useQuery<{ tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const { data: detected } = useQuery<RenameProfile>({
    queryKey: ['rename-profile', serverId, entry.path, localPath, rule.renameProvider],
    queryFn: () =>
      api.get(
        `/api/servers/${serverId}/rename-profile?path=${encodeURIComponent(entry.path)}&local=${encodeURIComponent(localPath)}&provider=${rule.renameProvider}`,
      ),
    enabled: !!rule.airedMapping,
    retry: false,
    staleTime: 60_000,
  })
  // the preview runs regardless of the rename switch: it is also where the
  // target comparison is shown, and that matters most when nothing is renamed
  const { pairs, sizes, busy: previewBusy, hasRule } = useRenamePreview({
    serverId,
    fields: { ...rule, remotePath: entry.path, localPath },
    enabled: true,
    fileName: entry.isDir ? undefined : entry.name,
    fileSize: entry.isDir ? undefined : entry.size,
  })
  const target = syncTargetDir(localPath, entry.path, entry.isDir && !flat)
  const { entries: targetEntries, missing: targetMissing } = useTargetFolder(target)
  // mount-to-open: Escape and the backdrop end in onClose, the footer buttons
  // decide explicitly - the parent unmounts either way
  return (
    <Dialog
      width="max-w-lg"
      aria-label={t('remote.syncTitle', { name: entry.name })}
      onClose={onClose}
    >
      <div className="dialog-body">
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
            <div className="flex items-stretch gap-2">
              <PathInput
                id="sync-target"
                value={localPath}
                onChange={onLocalPath}
                onCommit={onLocalPath}
                fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p.replace(/^\/+/, ''))}`}
                queryKey={['local']}
                ariaLabel={t('remote.localTarget')}
              />
              <Button
                size="sm"
                variant={browse ? 'primary' : 'default'}
                className="shrink-0"
                aria-expanded={browse}
                onClick={() => setBrowse((b) => !b)}
              >
                <Folder aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('watch.browse')}
              </Button>
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

          <div className="space-y-1">
            <p className="text-xs text-t-muted">
              {t('remote.syncTarget')} <span className="font-mono text-t-secondary">downloads/{target}</span>
            </p>
            {/* no folder name: the full path is right above, and several
                levels can be missing at once */}
            {targetMissing && <p className="text-[11px] text-t-muted">{t('watch.targetMissing')}</p>}
          </div>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionRename')}>
            <div className="flex items-center justify-between">
              <Badge tone="accent">{t('watch.sectionRename')}</Badge>
              <label className="flex items-center gap-2 text-sm text-t-secondary">
                <input type="checkbox" checked={renameOn} onChange={(e) => setRenameOn(e.target.checked)} />
                {t('watch.renameToggle')}
              </label>
            </div>
            {renameOn && (
              <RenameOptions
                rule={rule}
                onChange={(patch) => setRule({ ...rule, ...patch })}
                caps={caps}
                detected={detected}
                idPrefix="sync"
                seriesQuery={
                  entry.isDir ? entry.name : entry.path.split('/').filter(Boolean).slice(-2, -1)[0] || entry.name
                }
              />
            )}
          </section>

          {pairs && <RenamePreview pairs={pairs} sizes={sizes} target={targetEntries} busy={previewBusy} />}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button onClick={onClose}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            cut
            disabled={pending}
            onClick={() => onConfirm(renameOn && hasRule ? rule : null)}
          >
            <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {entry.isDir ? t('remote.syncFolder') : t('remote.downloadFile')}
          </Button>
        </footer>
      </div>
    </Dialog>
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
  onFiles,
  onSync,
  onWatch,
  onClose,
}: {
  group: CatalogGroup
  selected?: string
  onSelect: (e: Entry) => void
  onRematch: (it: CatalogItem) => void
  onFiles: (e: Entry) => void
  // a card bundling several folders cannot sync "the" title - the version is
  // picked here, where each row stands for exactly one folder
  onSync?: (e: Entry) => void
  onWatch?: (e: Entry) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const m = group.media!
  const source = group.items[0].source

  return (
    <Dialog
      width="max-w-4xl lg:max-w-6xl"
      aria-label={t('remote.detailsFor', { name: mediaTitle(m) })}
      onClose={onClose}
    >
      {/* close button stays reachable while the dialog scrolls - below the
          sheet breakpoint the Dialog draws its own, so this one would be the
          second X in the same corner */}
      <div className="sticky top-2 z-10 h-0 text-right max-sm:hidden">
        <Button size="sm" className="mr-2" aria-label={t('remote.close')} onClick={onClose}>
          <X aria-hidden size="1.2em" />
        </Button>
      </div>
      <MediaDetail media={m} source={source}>
        <h4 className="t-label mt-4 mb-1 border-t border-border-subtle pt-4">
          {t('remote.versions', { count: group.items.length })}
        </h4>
        <ul>
          {group.items.map((it) => (
            <li key={it.entry.path} className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-2 py-2">
              <span
                className={`min-w-0 flex-1 basis-full truncate text-sm sm:basis-auto ${selected === it.entry.path ? 'text-accent' : ''}`}
                title={it.entry.path}
              >
                {it.entry.name}
              </span>
              <Button size="sm" variant="primary" className="shrink-0" onClick={() => onSelect(it.entry)}>
                <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.select')}
              </Button>
              <Button size="sm" className="shrink-0" title={t('remote.showFiles')} onClick={() => onFiles(it.entry)}>
                <FilesIcon aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.files')}
              </Button>
              {onSync && (
                <Button size="sm" className="shrink-0" onClick={() => onSync(it.entry)}>
                  <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('plex.syncOnce')}
                </Button>
              )}
              {onWatch && (
                <Button size="sm" className="shrink-0" onClick={() => onWatch(it.entry)}>
                  <Eye aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('watch.add')}
                </Button>
              )}
              <Button size="sm" className="shrink-0" onClick={() => onRematch(it)}>
                <Replace aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.changeMatch')}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.close')}
          </Button>
        </div>
      </MediaDetail>
    </Dialog>
  )
}

function RematchDialog({ serverId, item, onClose }: { serverId: number; item: CatalogItem; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState(item.entry.name)
  const [results, setResults] = useState<Media[]>([])
  const [pickError, setPickError] = useState('')

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
    // a search field over a list that caps itself at max-h-72: this one is
    // compact by construction, so it stays a centred box instead of stretching
    // to a full screen it cannot fill
    <Dialog width="max-w-lg" sheet={false} aria-label={t('remote.matchFor', { name: item.entry.name })} onClose={onClose}>
      <div className="p-5">
        <h3 className="mb-1 font-display font-semibold tracking-wider">MATCH: {item.entry.name}</h3>
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
    </Dialog>
  )
}
