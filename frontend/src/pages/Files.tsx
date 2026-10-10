import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownWideNarrow,
  Check,
  Download,
  Eye,
  Files as FilesIcon,
  Folder,
  Info,
  LayoutGrid,
  List,
  MoreHorizontal,
  PenLine,
  Pencil,
  Play,
  RefreshCw,
  Replace,
  Search,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'

// icon per AniList airing status, shown inside the detail dialog's t-label chip
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SeriesCardView,
  BackToCard,
  useSeriesModal,
  type CardViewProps,
  type SeriesAction,
} from '../components/SeriesModal'
import { useToast } from '../components/toast'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import ActionSheet from '../components/ActionSheet'
import Press from '../components/Press'
import {
  Badge,
  Button,
  Cover,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  MediaCard,
  Menu,
  MenuItem,
  Panel,
  Segmented,
  useMenu,
} from '@weebsync/design-system'
import {
  api,
  fmtBytes,
  keyConflictOf,
  mediaTitle,
  type CatalogItem,
  type CatalogResponse,
  type Entry,
  type Media,
  type SearchResult,
  type ServerInfo,
  type SubfolderMode,
} from '../api'
import { CATALOG_SORTS, sortGroups, useCatalogSort, type CatalogSort } from '../components/catalogSort'
import { CatalogViewSwitch } from '../components/CatalogViewSwitch'
import SourcePicker from '../components/SourcePicker'
import { useCatalogView } from '../components/useCatalogView'
import { FileBrowser, LocalPicker, PathCrumbs, PlayIcon } from '../components/FileBrowser'
import { firstVideo, isVideo, playHref } from '../components/playLinks'
import PathInput from '../components/PathInput'
import PillSelect from '../components/PillSelect'
import FileIcon from '../components/FileIcon'
import PageActions from '../components/PageActions'
import { TrashButton } from './Trash'
import RenameOptions, { type RenameProfile, type RenameRule } from '../components/RenameOptions'
import RenamePreview from '../components/RenamePreview'
import { useRenamePreview } from '../components/useRenamePreview'
import { subfolderMode, subfolderTargetDir, syncRequestPath, useTargetFolder } from '../components/useTargetFolder'
import HostKeyPrompt from '../components/HostKeyPrompt'
import SubfolderChoice from '../components/SubfolderChoice'
import UpcomingSeason from '../components/UpcomingSeason'
import WatchDialog, { WatchForm, type WatchFields } from '../components/WatchDialog'
import { applyDefaults, useFolderKind, useWatchDefaults } from '../components/watchDefaults'
import { useConfirm } from '../components/confirm'
import { useAuth } from '../hooks'
import Loading from '../components/Loading'
import { InlineRename, type Renaming } from '../components/InlineRename'

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
  const goTo = useNavigate()
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
  // asked from the title card: the form shows inside it, the outcome as a toast
  const [inCard, setInCard] = useState(false)
  const toast = useToast()
  // the user's defaults fill a new watch: its kind comes from the folder's
  // catalog match, a target picked on this page wins over the default one
  const { data: defaults } = useWatchDefaults()
  const { data: watchKind, isPending: kindPending } = useFolderKind(active, watchEntry?.path)
  // null = untouched, so the default still speaks; once picked, the choice stands
  const [subMode, setSubMode] = useState<SubfolderMode | null>(null)
  const [subSep, setSubSep] = useState('')
  const { data: syncKind, isPending: syncKindPending } = useFolderKind(active, syncEntry?.path)
  const syncSeed =
    syncEntry && !syncKindPending
      ? applyDefaults(blankWatch(syncEntry.path, localPath), syncKind?.kind, defaults, syncKind)
      : null
  // a target picked on this page wins, the default one fills in otherwise;
  // the subfolder choice follows the default only while nothing was picked
  const syncLocal = localPath || syncSeed?.localPath || ''
  const seedMode: SubfolderMode = syncSeed && syncEntry?.isDir ? subfolderMode(syncSeed) : 'none'
  const syncMode = subMode ?? (localPath ? 'none' : seedMode)
  // the folder a title subfolder is named after, the same title the watch
  // dialog would use; it is folded into the request, never into the page path
  const syncTitle = syncKind?.title ?? ''
  // the season folder, unless the default template lays the folders out itself
  const syncSeason = syncSeed?.seasonFolder ?? ''
  const syncTarget =
    syncEntry && syncEntry.isDir
      ? subfolderTargetDir(syncLocal, syncEntry.path, syncMode, syncTitle, subSep, syncSeason)
      : syncLocal
  const [query, setQuery] = useState(params.get('q') ?? '')
  // the last few searches, offered as chips while the field is focused and empty
  const [searchFocus, setSearchFocus] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SEARCH_KEY) ?? '[]')
      return Array.isArray(v) ? (v as string[]).slice(0, SEARCH_KEEP) : []
    } catch {
      return []
    }
  })
  const rememberSearch = (q: string) => {
    const v = q.trim()
    if (v.length < 2) return
    saveSearches((prev) => [v, ...prev.filter((p) => p.toLowerCase() !== v.toLowerCase())].slice(0, SEARCH_KEEP))
  }
  const forgetSearch = (q: string) => saveSearches((prev) => prev.filter((p) => p !== q))
  const saveSearches = (update: (prev: string[]) => string[]) => {
    setRecentSearches((prev) => {
      const next = update(prev)
      try {
        localStorage.setItem(SEARCH_KEY, JSON.stringify(next))
      } catch {
        /* best effort - the list is a convenience, not state */
      }
      return next
    })
  }

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
    // inverted flag: handleSyncOnce derives flat from !subfolder. Only the
    // title folder is sent as a path; the remote one stays the server's own
    // join, which would otherwise append it a second time.
    mutationFn: ({ entry, rename }: { entry: Entry; rename: RenameRule | null }) =>
      rename
        ? api.post<{ queued: number; ids: number[] }>('/api/downloads/sync', {
            serverId: active,
            remotePath: entry.path,
            localPath: syncRequestPath(syncMode, syncLocal, syncTarget),
            subfolder: syncMode === 'remote' && entry.isDir,
            ...rename,
          })
        : api.post<{ queued: number; ids: number[] }>('/api/downloads', {
            serverId: active,
            remotePath: entry.path,
            localPath: syncRequestPath(syncMode, syncLocal, syncTarget),
            flat: !(syncMode === 'remote' && entry.isDir),
          }),
    onSuccess: (r) => {
      setNotice(t('remote.queued', { count: r.queued }))
      if (inCard) toast({ message: t('remote.queued', { count: r.queued }) })
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

  const syncProps = (entry: Entry, seed: WatchFields) => ({
    entry,
    serverId: active,
    localPath: syncLocal,
    onLocalPath: setLocalPath,
    target: syncTarget,
    mode: syncMode,
    onMode: setSubMode,
    separator: subSep,
    onSeparator: setSubSep,
    title: syncTitle,
    seed,
    pending: enqueue.isPending,
    onConfirm: (rename: RenameRule | null) => {
      enqueue.mutate({ entry, rename })
      setSyncEntry(null)
    },
    onClose: () => setSyncEntry(null),
  })
  const watchProps = (entry: Entry) => ({
    title: t('watch.addTitle', { name: entry.name }),
    serverId: active,
    initial: applyDefaults(blankWatch(entry.path, localPath), watchKind?.kind, defaults, watchKind),
    onSave: async (f: WatchFields) => {
      await api.post('/api/watches', { serverId: active, ...f })
      setNotice(t('watch.created'))
      if (inCard) {
        // the card's auto-sync section shows the new watch on the way back
        await qc.invalidateQueries({ queryKey: ['watches'] })
        toast({ message: t('watch.created') })
      }
    },
    onClose: () => setWatchEntry(null),
  })

  // the local library is edited through the selection: rename and delete
  // cannot be undone, so both go through a blocking modal. Admins only.
  const canEdit = isLocal && !!user?.isAdmin
  const refreshLocal = () => {
    qc.invalidateQueries({ queryKey: ['local'] })
    qc.invalidateQueries({ queryKey: ['catalog', 0] })
    setSelection(null)
  }
  // the name turns into a field where it stands (list row or catalog tile);
  // its outcome comes back here
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const renameLocal = (e: Entry) => setRenaming(e)
  const renamed = async (e: Entry, name: string | null) => {
    setRenaming(null)
    if (!name) return
    setError('')
    try {
      await api.post('/api/browse/local/rename', { path: e.path, name })
      refreshLocal()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }
  const inPlace = renaming
    ? { path: renaming.path, onDone: (name: string | null) => void renamed(renaming, name) }
    : undefined
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
  // descriptors rather than markup: the tile decides how many of its actions
  // fit on the row and puts the rest in a menu, which it cannot do with a
  // finished pair of buttons
  const cardActions = (e: Entry): TileAction[] =>
    canEdit
      ? [
          {
            key: 'rename',
            icon: <Pencil aria-hidden size="1.2em" />,
            label: t('local.rename'),
            aria: t('local.renameItem', { name: e.name }),
            onClick: () => renameLocal(e),
          },
          {
            key: 'delete',
            icon: <X aria-hidden size="1.2em" />,
            label: t('local.delete'),
            aria: t('local.deleteItem', { name: e.name }),
            onClick: () => removeLocal(e),
            danger: true,
          },
        ]
      : []

  const navigate = (p: string) => {
    setPath(p.replace(/^\//, ''))
    setSelection(null)
  }
  const browseUrl = (p: string) =>
    isLocal
      ? `/api/browse/local?path=${encodeURIComponent(p)}`
      : `/api/servers/${active}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`

  return (
    <div className="page-fill flex min-h-0 flex-1 flex-col">
      {/* the in-page heading is the desktop's; on a phone the app bar carries
          the title and the view switch. The source itself lives in the panel
          below, on the row it labels - it used to be a button group here, a
          select there and an add-server icon beside them, and the group wrapped
          into two rows as soon as a third server existed */}
      <header className="mb-4 hidden flex-wrap items-center gap-x-3 gap-y-2 lg:flex">
        <div className="mr-auto">
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('files.title')}</h2>
          <Badge className="mt-1">{t('files.sub')}</Badge>
        </div>
        <PageActions>
          {/* first, so the view switch and the pin keep their place in the
              app bar on a phone */}
          <TrashButton />
          <CatalogViewSwitch value={viewValue} onChange={setView} />
        </PageActions>
      </header>

      {!isLocal && servers.length === 0 ? (
        <EmptyState>
          <Trans
            i18nKey="remote.noServers"
            components={{ go: <Link to="/settings/servers" className="text-accent underline" /> }}
          />
        </EmptyState>
      ) : (
        <Panel as="section" className="flex min-h-64 min-w-0 flex-1 flex-col lg:min-h-0" aria-label={t('files.title')}>
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            {/* names the source, switches it, and holds the way to a new one */}
            <SourcePicker value={source} servers={servers} onChange={pickSource} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-muted">
              {selection ? selection.path : path ? `/${path}` : t('remote.noSelection')}
            </span>
            {!isLocal && (
              <>
                <Input
                  className="w-40 sm:w-56"
                  size="sm"
                  type="search"
                  placeholder={
                    path ? t('remote.searchIn', { dir: path.slice(path.lastIndexOf('/') + 1) }) : t('remote.search')
                  }
                  aria-label={t('remote.search')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setSearchFocus(true)}
                  onBlur={() => {
                    setSearchFocus(false)
                    rememberSearch(query)
                  }}
                />
              </>
            )}
          </div>
          {/* Recent searches only while the field is focused and still empty,
              in the flow instead of floating: typing hands over to the live
              results. No <datalist> - mobile browsers (Chrome, Firefox, iOS
              Safari) float its suggestions over the input and the results and
              keep them there while typing. */}
          {!isLocal && searchFocus && !query && recentSearches.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2"
              aria-label={t('remote.recentSearches')}
              // keep focus in the input, so a tap here does not close the row first
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="text-xs text-t-muted">{t('remote.recentSearches')}</span>
              {recentSearches.map((q) => (
                <span
                  key={q}
                  className="flex min-h-8 max-w-full items-center rounded-full border border-border-input text-sm text-t-primary"
                >
                  <button
                    type="button"
                    className="min-w-0 truncate py-1 pr-1 pl-3 hover:text-accent"
                    onClick={() => setQuery(q)}
                  >
                    {q}
                  </button>
                  <button
                    type="button"
                    className="grid size-8 shrink-0 place-items-center text-t-muted hover:text-err"
                    aria-label={t('remote.forgetSearch', { q })}
                    onClick={() => forgetSearch(q)}
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && (
            <p className="border-b border-border-subtle px-3 py-2 text-xs text-err" role="alert">
              {error}
            </p>
          )}
          {!isLocal && query.trim() ? (
            <SearchResults
              serverId={active}
              path={path}
              query={query}
              onOpenDir={(p) => {
                navigate(p)
                setQuery('')
              }}
              onSelect={setSelection}
              onPlay={(e) => goTo(playHref(active, e.path))}
              selected={selection?.path}
            />
          ) : view === 'classic' ? (
            <FileBrowser
              queryKey={isLocal ? ['local'] : ['remote', active]}
              fetchPath={browseUrl}
              path={path}
              onNavigate={navigate}
              onSelect={setSelection}
              selected={selection?.path}
              emptyHint={isLocal ? t('remote.emptyLocal') : undefined}
              serverId={isLocal ? undefined : active}
              renaming={inPlace}
              onPlay={(e) => goTo(playHref(active, e.path))}
            />
          ) : (
            <CatalogGrid
              serverId={active}
              path={path}
              onNavigate={navigate}
              onSelect={setSelection}
              selected={selection?.path}
              onSync={
                isLocal
                  ? undefined
                  : (e, card) => {
                      setSyncEntry(e)
                      setInCard(!!card)
                    }
              }
              onWatch={
                isLocal
                  ? undefined
                  : (e, card) => {
                      setWatchEntry(e)
                      setInCard(!!card)
                    }
              }
              cardActions={isLocal ? cardActions : undefined}
              renaming={inPlace}
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
        <Panel
          role="region"
          aria-label={t('remote.selectionBar')}
          className="mt-4 flex flex-wrap items-center gap-2 p-3"
        >
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
          {selection && isVideo(selection.name) && (
            <Button size="sm" onClick={() => goTo(playHref(active, selection.path))}>
              <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('player.play')}
            </Button>
          )}
          {selection && canEdit && (
            <>
              <Button
                size="sm"
                aria-label={t('local.renameItem', { name: selection.name })}
                onClick={() => renameLocal(selection)}
              >
                <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('local.rename')}
              </Button>
              {selection.isDir && (
                // the batch renamer works on a folder's episodes; it opens
                // with this folder already chosen
                <Button
                  size="sm"
                  onClick={() => goTo(`/rename?path=${encodeURIComponent(selection.path.replace(/^\//, ''))}`)}
                >
                  <PenLine aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('local.renameEpisodes')}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                aria-label={t('local.deleteItem', { name: selection.name })}
                onClick={() => removeLocal(selection)}
              >
                <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('local.delete')}
              </Button>
            </>
          )}
          {selection && !isLocal && (
            <>
              <Button
                size="sm"
                disabled={!selection.isDir}
                onClick={() => {
                  setWatchEntry(selection)
                  setInCard(false)
                }}
              >
                <Eye aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('watch.add')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setSyncEntry(selection)
                  setInCard(false)
                }}
              >
                <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.syncOpen')}
              </Button>
            </>
          )}
        </Panel>
      )}

      {syncEntry &&
        syncSeed &&
        (inCard ? (
          <SeriesCardView onClose={() => setSyncEntry(null)}>
            {(v) => <SyncForm {...v} {...syncProps(syncEntry, syncSeed)} />}
          </SeriesCardView>
        ) : (
          <SyncDialog {...syncProps(syncEntry, syncSeed)} />
        ))}
      {watchEntry &&
        !kindPending &&
        (inCard ? (
          <SeriesCardView onClose={() => setWatchEntry(null)}>
            {(v) => <WatchForm {...v} {...watchProps(watchEntry)} />}
          </SeriesCardView>
        ) : (
          <WatchDialog {...watchProps(watchEntry)} />
        ))}
    </div>
  )
}

// Search over the server's remote index (built passively + by the crawler,
// may be incomplete while it grows), below the folder the browser stands in.
function SearchResults({
  serverId,
  path,
  query,
  onOpenDir,
  onSelect,
  onPlay,
  selected,
}: {
  serverId: number
  path: string
  query: string
  onOpenDir: (path: string) => void
  onSelect: (e: Entry) => void
  onPlay: (e: Entry) => void
  selected?: string
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState(query)
  useEffect(() => {
    const id = setTimeout(() => setQ(query), 300)
    return () => clearTimeout(id)
  }, [query])
  const { data, isLoading } = useQuery<SearchResult>({
    queryKey: ['search', serverId, path, q],
    queryFn: () =>
      api.get(
        `/api/servers/${serverId}/search?q=${encodeURIComponent(q)}${path ? `&path=${encodeURIComponent('/' + path)}` : ''}`,
      ),
    enabled: !!q.trim(),
  })

  return (
    // the horizontal axis stays with the page's swipe zone, see the browser below
    <div className="min-h-0 flex-1 overflow-y-auto" style={{ touchAction: 'pan-y pinch-zoom' }}>
      {isLoading && <Loading className="p-4" />}
      {data && data.results.length === 0 && (
        <p className="p-4 text-sm text-t-muted">
          {t('remote.noResults')}
          {data.indexed < 100 && <span className="mt-1 block text-xs">{t('remote.indexBuilding')}</span>}
        </p>
      )}
      <ul>
        {data?.results.map((e) => {
          const playable = !e.isDir && isVideo(e.name)
          return (
            <li key={e.path} className="flex items-stretch border-b border-border-subtle/50">
              {playable && <PlayIcon name={e.name} onPlay={() => onPlay(e)} />}
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left text-sm transition-colors hover:bg-bg-hover ${
                  playable ? 'pl-1' : 'pl-3'
                } ${selected === e.path ? 'bg-bg-hover text-accent' : 'text-t-secondary'}`}
                onClick={() => (e.isDir ? onOpenDir(e.path) : onSelect(e))}
                onDoubleClick={() => playable && onPlay(e)}
              >
                {!playable && <FileIcon isDir={e.isDir} name={e.name} />}
                <span className="min-w-0 flex-1 truncate">
                  {e.name}
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-t-faint">{e.path}</span>
                </span>
                {!e.isDir && <span className="shrink-0 font-mono text-xs text-t-muted">{fmtBytes(e.size)}</span>}
              </button>
              {/* a found folder can be picked where it stands, same as in the
                folder list - the row itself still opens it */}
              {e.isDir && (
                <Button
                  size="sm"
                  className="my-1 mr-2 shrink-0 self-center"
                  aria-label={t('remote.selectItem', { name: e.name })}
                  onClick={() => onSelect(e)}
                >
                  {t('remote.select')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {data && <p className="px-3 py-2 text-[10px] text-t-faint">{t('remote.indexCount', { count: data.indexed })}</p>}
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
  renaming,
}: {
  serverId: number
  path: string
  onNavigate: (path: string) => void
  onSelect: (e: Entry) => void
  selected?: string
  // omitted on the local page: there is nothing to download or watch there
  // `inCard`: asked from the title card, which shows the form in its place
  onSync?: (e: Entry, inCard?: boolean) => void
  onWatch?: (e: Entry, inCard?: boolean) => void
  // hands a folder to the page, which opens it in the classic browser: that
  // one already lists files and navigates, so the catalog needs no second one
  onOpenFiles: (path: string) => void
  // local page: extra card buttons (rename/delete). Kept as a render prop so
  // the admin logic lives with the page that owns the mutations.
  cardActions?: (e: Entry) => TileAction[]
  /** the folder whose name is being edited in place */
  renaming?: Renaming
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const goTo = useNavigate()
  // the title being looked into for its first episode, so its button can show it
  const [starting, setStarting] = useState<string | null>(null)
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
  const listing = `${serverId}:${path}`
  const [keyRejectedFor, setKeyRejectedFor] = useState<string | null>(null)
  const [rematch, setRematch] = useState<CatalogItem | null>(null)
  const [rematchInCard, setRematchInCard] = useState(false)
  const toast = useToast()
  // a title plays from its first episode; the player walks on from there
  const play = async (e: Entry) => {
    if (starting) return
    setStarting(e.path)
    try {
      const first = await firstVideo(serverId, e.path)
      if (first) {
        series.close()
        goTo(playHref(serverId, first))
      } else toast({ message: t('player.noVideo') })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : t('app.error') })
    } finally {
      setStarting(null)
    }
  }
  const playAction = (e: Entry, size = '1.2em'): TileAction => ({
    key: 'play',
    icon: <Play aria-hidden size={size} fill="currentColor" strokeWidth={0} />,
    label: t('player.play'),
    aria: t('player.playItem', { name: e.name }),
    onClick: () => play(e),
  })
  // the title card is the app's one; the catalog adds its folder versions
  // under the record, each selectable, syncable, watchable, re-matchable.
  // Syncing, watching and matching from the card happen inside it.
  const series = useSeriesModal()
  const rematchInside = (it: CatalogItem) => {
    setRematch(it)
    setRematchInCard(true)
  }
  const ico = 'mr-1 inline align-[-0.125em]'
  // the action bar acts on a card's one folder; a card bundling several
  // leaves it to the version rows, where each row is exactly one folder
  const barActions = (it: CatalogItem): SeriesAction[] => [
    {
      key: 'play',
      label: t('player.play'),
      icon: <Play aria-hidden size="1em" className={ico} fill="currentColor" strokeWidth={0} />,
      primary: !onSync,
      onClick: () => play(it.entry),
    },
    ...(onSync
      ? [
          {
            key: 'sync',
            label: t('series.action.syncNow'),
            icon: <Download aria-hidden size="1em" className={ico} />,
            primary: true,
            onClick: () => onSync(it.entry, true),
          },
        ]
      : []),
    ...(onWatch
      ? [
          {
            key: 'watch',
            label: t('series.action.autoSync'),
            icon: <Eye aria-hidden size="1em" className={ico} />,
            onClick: () => onWatch(it.entry, true),
          },
        ]
      : []),
    {
      key: 'rematch',
      label: t('series.action.rematch'),
      icon: <Replace aria-hidden size="1em" />,
      more: true,
      onClick: () => rematchInside(it),
    },
    {
      key: 'files',
      label: t('series.action.files'),
      icon: <FilesIcon aria-hidden size="1em" />,
      more: true,
      onClick: () => {
        series.close()
        onOpenFiles(it.entry.path)
      },
    },
  ]
  // `id` and `media` differ from the group's after a new match was picked
  const showDetail = (g: CatalogGroup, id = g.media!.id, media = g.media) =>
    series.open({
      source: g.items[0].source,
      id,
      media,
      actions: g.items.length === 1 ? barActions(g.items[0]) : [],
      extra: (
        <CatalogVersions
          group={g}
          selected={selected}
          onSelect={(e) => {
            series.close()
            onSelect(e)
          }}
          onRematch={rematchInside}
          onFiles={(e) => {
            series.close()
            onOpenFiles(e.path)
          }}
          onSync={onSync && ((e) => onSync(e, true))}
          onWatch={onWatch && ((e) => onWatch(e, true))}
        />
      ),
    })
  // what a matched or unmatched folder can have done to it, for the tile's
  // footer and the list row's menu alike
  // a long press on a tile or row (touch) lists all its actions in a sheet,
  // the ones behind the overflow button included
  const [sheet, setSheet] = useState<CatalogGroup | null>(null)
  const actionsFor = (g: CatalogGroup): TileAction[] => {
    const it = g.items[0]
    const multi = g.items.length > 1
    return g.media
      ? [
          playAction(it.entry),
          {
            key: 'details',
            icon: <Info aria-hidden size="1.2em" />,
            label: t('remote.details'),
            aria: t('remote.detailsFor', { name: mediaTitle(g.media) }),
            onClick: () => showDetail(g),
          },
          ...(multi
            ? []
            : [
                {
                  key: 'files',
                  icon: <FilesIcon aria-hidden size="1.2em" />,
                  label: t('remote.showFiles'),
                  aria: `${t('remote.showFiles')}: ${it.entry.name}`,
                  onClick: () => onOpenFiles(it.entry.path),
                },
                ...(onSync
                  ? [
                      {
                        key: 'sync',
                        icon: <Download aria-hidden size="1.2em" />,
                        label: t('plex.syncOnce'),
                        aria: `${t('plex.syncOnce')}: ${it.entry.name}`,
                        onClick: () => onSync(it.entry),
                      },
                    ]
                  : []),
                ...(onWatch
                  ? [
                      {
                        key: 'watch',
                        icon: <Eye aria-hidden size="1.2em" />,
                        label: t('watch.add'),
                        aria: `${t('watch.add')}: ${it.entry.name}`,
                        onClick: () => onWatch(it.entry),
                      },
                    ]
                  : []),
                ...(cardActions?.(it.entry) ?? []),
              ]),
        ]
      : [
          playAction(it.entry),
          {
            key: 'files',
            icon: <FilesIcon aria-hidden size="1.2em" />,
            label: t('remote.showFiles'),
            aria: `${t('remote.showFiles')}: ${it.entry.name}`,
            onClick: () => onOpenFiles(it.entry.path),
          },
          // "Match ändern" spelled out needs 114px of a 131px
          // tile, so it travels as the Replace glyph the detail
          // dialog uses, with the name in title/aria
          ...(!g.pending && it.source
            ? [
                {
                  key: 'rematch',
                  icon: <Replace aria-hidden size="1.2em" />,
                  label: t('remote.changeMatch'),
                  aria: `${t('remote.changeMatch')}: ${it.entry.name}`,
                  onClick: () => {
                    setRematch(it)
                    setRematchInCard(false)
                  },
                },
              ]
            : []),
          ...(cardActions?.(it.entry) ?? []),
        ]
  }
  const [scopeError, setScopeError] = useState('')
  // poster grid or rows; remembered across folders and visits
  const [layout, setLayoutState] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const setLayout = (v: 'grid' | 'list') => {
    setLayoutState(v)
    try {
      localStorage.setItem(LAYOUT_KEY, v)
    } catch {
      // storage can be off
    }
  }
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
  if (error) {
    // a host key to review is offered here, not behind the connection test
    const conflict = keyRejectedFor === listing ? null : keyConflictOf(error)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {crumbs}
        {conflict ? (
          <HostKeyPrompt
            className="m-6"
            serverId={serverId}
            conflict={conflict}
            onAccepted={() => qc.invalidateQueries({ queryKey: ['catalog', serverId] })}
            onRejected={() => setKeyRejectedFor(listing)}
          />
        ) : (
          <p className="p-6 text-sm text-err">{error instanceof Error ? error.message : t('app.error')}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {crumbs}
      {/* touch-action is only read up to the nearest scroll container, and on a
          phone this one fills the screen - the page's swipe zone sits above it
          and the browser never sees it, so a sideways drag in here became a
          scroll gesture and the page never turned. It has to allow the
          horizontal axis itself. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ touchAction: 'pan-y pinch-zoom' }}>
        {/* one row of chips: what the folder is matched against, how the cards
          are ordered, and the rest behind the overflow. It used to be two
          labelled selects and up to three buttons, which stacked into five
          rows on a phone before the first card */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <PillSelect
            label={t('remote.scope')}
            placeholder={t('remote.scopeNone')}
            value={data?.scope ?? ''}
            onChange={setScope}
            options={[
              { value: 'anime', label: t('remote.scopeAnime') },
              { value: 'tv', label: t('remote.scopeTv') },
              { value: 'movie', label: t('remote.scopeMovie') },
              ...(caps?.tvdbApiKeySet ? [{ value: 'tvdb', label: t('remote.scopeTvdb') }] : []),
            ]}
          />
          {groups.length > 1 && (
            <PillSelect
              label={t('remote.sort')}
              value={sort}
              onChange={(v) => setSort(v as CatalogSort)}
              icon={<ArrowDownWideNarrow aria-hidden size="1em" className="shrink-0 text-t-muted" />}
              options={CATALOG_SORTS.map((c) => ({ value: c, label: t(`remote.sort_${c}`) }))}
            />
          )}
          {groups.length > 0 && (
            <Segmented
              aria-label={t('remote.layout')}
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'grid', 'aria-label': t('remote.layoutGrid'), label: <LayoutGrid aria-hidden size="1em" /> },
                { value: 'list', 'aria-label': t('remote.layoutList'), label: <List aria-hidden size="1em" /> },
              ]}
            />
          )}
          <CatalogActions
            canRematch={data?.scope !== '' && pendingCount === 0 && items.length > 0}
            noMatchCount={noMatchCount}
            onRematch={triggerRematch}
            onClearScope={data && data.scope !== '' ? () => setScope('') : undefined}
          />
          {scopeError && (
            <span className="text-xs text-err" role="alert">
              {scopeError}
            </span>
          )}
          {data?.scope === '' ? (
            <p className="w-full text-xs text-t-muted" role="status">
              {t('remote.scopePick')}
            </p>
          ) : (
            pendingCount > 0 && (
              <p className="text-xs text-t-muted" role="status">
                {t('remote.matchingCount', { count: pendingCount })}
              </p>
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
        {/* minmax(0, …) tracks and min-w-0 tiles: a folder name like
            "Title [GerJapDub,GerEngSub,…]" is a truncated nowrap line, and
            with auto minimums its full length set the tile's width - the
            cards ran off the panel and the posters overlapped */}
        {layout === 'list' ? (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {groups.map((g) => {
              const it = g.items[0]
              const multi = g.items.length > 1
              const kind = g.media && g.media.episodes > 1 ? 'series' : it.kind
              const isSelected = g.items.some((v) => v.entry.path === selected)
              const name = mediaTitle(g.media, it.entry.name)
              return (
                <Press as="li" key={g.key} onLongPress={() => setSheet(g)}>
                  <MediaCard
                    className={isSelected ? 'outline-2 outline-accent' : undefined}
                    cover={g.media?.coverImage?.large}
                    onCover={g.media ? () => showDetail(g) : undefined}
                    coverLabel={g.media ? t('remote.detailsFor', { name }) : undefined}
                    title={name}
                    pathTitle={g.items.map((v) => v.entry.path).join('\n')}
                    path={
                      multi ? (
                        t('remote.versions', { count: g.items.length })
                      ) : renaming?.path === it.entry.path ? (
                        <InlineRename name={it.entry.name} onDone={renaming.onDone} className="mt-1 font-mono" />
                      ) : (
                        it.entry.name
                      )
                    }
                    meta={g.pending ? t('remote.matching') : !g.media && it.source ? t('remote.noMatch') : undefined}
                    badges={
                      <>
                        {kind && (
                          <Badge size="sm" tone={kind === 'movie' ? 'accent' : 'neutral'}>
                            {t(kind === 'movie' ? 'remote.kindMovie' : 'remote.kindSeries')}
                          </Badge>
                        )}
                        {g.media && g.media.seasonYear > 0 && <Badge size="sm">{g.media.seasonYear}</Badge>}
                        {g.media && g.media.episodes > 0 && <Badge size="sm">{g.media.episodes} EP</Badge>}
                        {g.media && g.media.averageScore > 0 && (
                          <Badge size="sm" tone="accent">
                            <Star
                              aria-hidden
                              size="1em"
                              className="mr-0.5 inline align-[-0.125em]"
                              fill="currentColor"
                              strokeWidth={0}
                            />
                            {g.media.averageScore}
                          </Badge>
                        )}
                        {it.local && (
                          <>
                            <Badge
                              size="sm"
                              tone={
                                g.media && g.media.episodes > 0 && it.local.videos >= g.media.episodes
                                  ? 'ok'
                                  : 'neutral'
                              }
                            >
                              {t('local.videoCount', { count: it.local.videos })}
                            </Badge>
                            <Badge size="sm">{fmtBytes(it.local.bytes)}</Badge>
                          </>
                        )}
                      </>
                    }
                    actions={<TileActions actions={actionsFor(g)} max={2} className="flex gap-1.5" />}
                  />
                </Press>
              )
            })}
          </ul>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
            {groups.map((g) => {
              const it = g.items[0]
              const multi = g.items.length > 1
              // the file-count heuristic reads a season that has aired one episode
              // so far as a film; where a match exists, it knows better
              const kind = g.media && g.media.episodes > 1 ? 'series' : it.kind
              const isSelected = g.items.some((v) => v.entry.path === selected)
              return (
                <Press key={g.key} onLongPress={() => setSheet(g)} className="flex min-w-0">
                  <Panel
                    as="article"
                    className={`group relative flex min-w-0 flex-1 flex-col overflow-clip transition-colors hover:border-accent/50! ${isSelected ? 'outline-2 outline-accent' : ''}`}
                  >
                    {/* the poster plays the title: a round button over it, in on hover
                        or focus, always there on touch */}
                    <div className="t-poster-zone">
                      <button
                        type="button"
                        className="t-poster-play"
                        aria-label={t('player.playItem', { name: mediaTitle(g.media, it.entry.name) })}
                        title={t('player.play')}
                        aria-busy={starting === it.entry.path}
                        onClick={() => play(it.entry)}
                      >
                        <Play aria-hidden size="1.4em" fill="currentColor" strokeWidth={0} className="translate-x-px" />
                      </button>
                    </div>
                    {/* rematch tucked away as a pencil over the cover (hover/focus);
                  unmatched folders keep the explicit button below instead */}
                    {g.media && !multi && !!it.source && (
                      <Button
                        size="sm"
                        className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={t('remote.changeMatch')}
                        title={t('remote.changeMatch')}
                        onClick={() => {
                          setRematch(it)
                          setRematchInCard(false)
                        }}
                      >
                        <Pencil aria-hidden size="1.2em" />
                      </Button>
                    )}
                    <button
                      className="text-left"
                      onClick={() => (g.media ? showDetail(g) : onSelect(it.entry))}
                      // a matched tile is named by what it shows (WCAG 2.5.3); the
                      // unmatched one shows no text of its own
                      aria-label={g.media ? undefined : t('remote.selectItem', { name: it.entry.name })}
                    >
                      {g.media?.coverImage?.large ? (
                        <Cover
                          size="fill"
                          src={g.media.coverImage.extraLarge || g.media.coverImage.large}
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
                        <h3
                          className="line-clamp-2 text-sm font-medium text-t-primary"
                          title={mediaTitle(g.media, it.entry.name)}
                        >
                          {mediaTitle(g.media, it.entry.name)}
                        </h3>
                        {multi ? (
                          <p className="font-mono text-[10px] text-accent">
                            {t('remote.versions', { count: g.items.length })}
                          </p>
                        ) : (
                          // while renamed, the name moves out of the tile's
                          // button into a field below it: no input in a button
                          renaming?.path !== it.entry.path && (
                            <p className="truncate font-mono text-[10px] text-t-muted" title={it.entry.name}>
                              {it.entry.name}
                            </p>
                          )
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
                              {g.media.averageScore > 0 && (
                                <Badge tone="accent">
                                  <Star
                                    aria-hidden
                                    size="1em"
                                    className="mr-0.5 inline align-[-0.125em]"
                                    fill="currentColor"
                                    strokeWidth={0}
                                  />
                                  {g.media.averageScore}
                                </Badge>
                              )}
                            </>
                          )}
                        </div>
                        {/* local catalog: what is actually on disk, and how it
                      compares to what the provider lists */}
                        {it.local && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <Badge
                              tone={
                                g.media && g.media.episodes > 0 && it.local.videos >= g.media.episodes
                                  ? 'ok'
                                  : 'neutral'
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
                    {!multi && renaming?.path === it.entry.path && (
                      <div className="px-2 pb-2">
                        <InlineRename name={it.entry.name} onDone={renaming.onDone} className="w-full font-mono" />
                      </div>
                    )}
                    {/* the poster's button plays: the narrow footer keeps its room */}
                    <TileActions actions={actionsFor(g).filter((a) => a.key !== 'play')} />
                  </Panel>
                </Press>
              )
            })}
          </div>
        )}
        {sheet && (
          <ActionSheet
            title={mediaTitle(sheet.media, sheet.items[0].entry.name)}
            actions={actionsFor(sheet)}
            onClose={() => setSheet(null)}
          />
        )}
        <UpcomingSeason
          upcoming={data?.upcoming ?? []}
          missing={data?.missing ?? []}
          elsewhere={data?.elsewhere ?? {}}
          onOpenFolder={onOpenFiles}
        />
        {rematch &&
          (rematchInCard ? (
            <SeriesCardView onClose={() => setRematch(null)}>
              {(v) => (
                <RematchForm
                  {...v}
                  serverId={serverId}
                  item={rematch}
                  onClose={() => setRematch(null)}
                  // the card moves on to the new record, or goes with the match
                  onPicked={(id) => {
                    setRematch(null)
                    toast({ message: t('series.rematched') })
                    if (id) showDetail({ key: rematch.entry.path, items: [rematch] }, id, undefined)
                    else series.close()
                  }}
                />
              )}
            </SeriesCardView>
          ) : (
            <RematchDialog serverId={serverId} item={rematch} onClose={() => setRematch(null)} />
          ))}
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

// CatalogActions holds what a catalog folder can have done to it: pull the
// automatic matches again, and forget the source this folder was marked with.
// Behind an overflow button, because none of it is part of looking at the
// cards - the row above stayed readable only as long as it was two chips.
function CatalogActions({
  canRematch,
  noMatchCount,
  onRematch,
  onClearScope,
}: {
  canRematch: boolean
  noMatchCount: number
  onRematch: (all: boolean) => void
  /** absent while the folder carries no source mark */
  onClearScope?: () => void
}) {
  const { t } = useTranslation()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  if (!canRematch && !onClearScope) return null
  return (
    <div className="relative" ref={ref} style={anchorStyle}>
      <IconButton
        aria-label={t('remote.catalogActions')}
        title={t('remote.catalogActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="size-8! rounded-full! border border-border-input text-t-muted hover:text-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal aria-hidden size="1.1em" />
      </IconButton>
      {open && (
        <Menu anchor={anchor} aria-label={t('remote.catalogActions')}>
          {canRematch && noMatchCount > 0 && (
            <MenuItem
              onClick={() => {
                setOpen(false)
                onRematch(false)
              }}
            >
              {t('remote.retryUnmatched', { count: noMatchCount })}
            </MenuItem>
          )}
          {canRematch && (
            <MenuItem
              onClick={() => {
                setOpen(false)
                onRematch(true)
              }}
            >
              {t('remote.rematchAll')}
            </MenuItem>
          )}
          {onClearScope && (
            <>
              {canRematch && <li role="separator" className="my-1 border-t border-border-subtle" />}
              <MenuItem
                title={t('remote.scopeClearHint')}
                onClick={() => {
                  setOpen(false)
                  onClearScope()
                }}
              >
                {t('remote.scopeClear')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </div>
  )
}

// One thing a tile can do. The tile decides which of them exist; how many fit
// is TileActions' business.
export interface TileAction {
  key: string
  icon: ReactNode
  /** the name, for the tooltip and the menu entry */
  label: string
  /** spelled out for a screen reader: the name plus what it acts on */
  aria: string
  onClick: () => void
  danger?: boolean
}

const SEARCH_KEY = 'weebsync.search.recent'
const LAYOUT_KEY = 'weebsync.files.layout'
// few enough to fit two rows on a phone
const SEARCH_KEEP = 5

// The footer of a catalog tile. A touch device gives a small button 40px of
// height, and four of them across a 140px tile leave 28px of width each -
// upright slabs. Three is what fits at a sane width, so the third slot becomes
// an overflow as soon as there is a fourth action. The buttons share the row
// in equal parts, so every tile ends in the same bar.
const CARD_ACTIONS = 'relative mx-2 mb-2 mt-auto flex gap-1.5 [&_.t-btn]:min-w-6! [&_.t-btn]:flex-1 [&_.t-btn]:px-1!'

function TileActions({
  actions,
  max = 3,
  className = CARD_ACTIONS,
}: {
  actions: TileAction[]
  max?: number
  className?: string
}) {
  const { t } = useTranslation()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  if (actions.length === 0) return null
  // up to `max` buttons; past that the last slot is the overflow
  const inline = actions.length > max ? actions.slice(0, max - 1) : actions
  const rest = actions.slice(inline.length)
  const more = t('remote.tileActions')
  return (
    <div className={className} ref={ref} style={anchorStyle}>
      {inline.map((a) => (
        <Button
          key={a.key}
          size="sm"
          variant={a.danger ? 'danger' : 'default'}
          aria-label={a.aria}
          title={a.label}
          onClick={a.onClick}
        >
          {a.icon}
        </Button>
      ))}
      {rest.length > 0 && (
        // a sibling of the other buttons, not a box around one: wrapped, the
        // slot sized itself and came out narrower than the rest of the row
        <>
          <Button
            size="sm"
            aria-label={more}
            title={more}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <MoreHorizontal aria-hidden size="1.2em" />
          </Button>
          {open && (
            <Menu anchor={anchor} placement="top-end" aria-label={more}>
              {rest.map((a) => (
                <MenuItem
                  key={a.key}
                  onClick={() => {
                    setOpen(false)
                    a.onClick()
                  }}
                >
                  <span className={`flex items-center gap-2 ${a.danger ? 'text-err' : ''}`}>
                    {a.icon}
                    {a.label}
                  </span>
                </MenuItem>
              ))}
            </Menu>
          )}
        </>
      )}
    </div>
  )
}

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

interface SyncFormProps {
  entry: Entry
  serverId: number
  localPath: string
  onLocalPath: (p: string) => void
  /** the folder the sync really writes into, title subfolder included */
  target: string
  mode: SubfolderMode
  onMode: (m: SubfolderMode) => void
  separator: string
  onSeparator: (s: string) => void
  /** the series title a title subfolder is named after */
  title: string
  pending: boolean
  onConfirm: (rename: RenameRule | null) => void
  onClose: () => void
  /** the user's defaults for this folder's kind, applied on open */
  seed?: WatchFields
}

function SyncDialog(props: SyncFormProps) {
  const { t } = useTranslation()
  // mount-to-open: Escape and the backdrop end in onClose, the footer buttons
  // decide explicitly - the parent unmounts either way
  return (
    <Dialog width="max-w-lg" aria-label={t('remote.syncTitle', { name: props.entry.name })} onClose={props.onClose}>
      <SyncForm {...props} />
    </Dialog>
  )
}

// The sync picker without a dialog of its own, for the title card to show in
// place of its content; the back arrow returns there.
function SyncForm({
  entry,
  serverId,
  localPath,
  onLocalPath,
  target,
  mode,
  onMode,
  separator,
  onSeparator,
  title,
  pending,
  onConfirm,
  onClose,
  seed,
  onBack,
  className = '',
}: SyncFormProps & Partial<CardViewProps>) {
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
  const {
    pairs,
    sizes,
    busy: previewBusy,
    hasRule,
  } = useRenamePreview({
    serverId,
    fields: { ...rule, remotePath: entry.path, localPath: target },
    enabled: true,
    fileName: entry.isDir ? undefined : entry.name,
    fileSize: entry.isDir ? undefined : entry.size,
  })
  const { entries: targetEntries, missing: targetMissing } = useTargetFolder(target)
  return (
    <div className={`dialog-body ${className}`}>
      <header className="flex items-start gap-2 border-b border-border-subtle px-5 py-4">
        {onBack && <BackToCard onClick={onBack} />}
        <div className="min-w-0 self-center">
          <h3 className="font-display font-semibold tracking-wider">{t('remote.syncTitle', { name: entry.name })}</h3>
          <span className="mt-1 block truncate font-mono text-xs text-t-muted" title={entry.path}>
            {entry.path}
          </span>
        </div>
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
            <div className="mt-2 flex max-h-56 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary/40">
              <LocalPicker path={localPath} onNavigate={onLocalPath} />
            </div>
          )}
        </div>

        {entry.isDir && (
          <SubfolderChoice
            value={mode}
            onChange={onMode}
            separator={separator}
            onSeparator={onSeparator}
            title={title}
            seasonFolder={seed?.seasonFolder}
          />
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
        <Button variant="primary" disabled={pending} onClick={() => onConfirm(renameOn && hasRule ? rule : null)}>
          <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {entry.isDir ? t('remote.syncFolder') : t('remote.downloadFile')}
        </Button>
      </footer>
    </div>
  )
}

interface CatalogGroup {
  key: string
  media?: Media
  pending?: boolean
  items: CatalogItem[]
}

// CatalogVersions is the catalog's part of the title card: every folder
// version matched to the title, each selectable for sync and individually
// re-matchable.
function CatalogVersions({
  group,
  selected,
  onSelect,
  onRematch,
  onFiles,
  onSync,
  onWatch,
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
}) {
  const { t } = useTranslation()

  return (
    <>
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
    </>
  )
}

interface RematchProps {
  serverId: number
  item: CatalogItem
  onClose: () => void
  /** after a pick went through, with the new record's id (0: match removed) */
  onPicked?: (mediaId: number) => void
}

function RematchDialog(props: RematchProps) {
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

// The match search without a dialog, for the title card to show in place of
// its content.
function RematchForm({
  serverId,
  item,
  onClose,
  onPicked,
  onBack,
  className = '',
}: RematchProps & Partial<CardViewProps>) {
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
    if (onPicked) onPicked(mediaId)
    else onClose()
  }

  return (
    <div className={`overflow-y-auto p-5 ${className}`}>
      <div className="mb-1 flex items-center gap-2">
        {onBack && <BackToCard onClick={onBack} />}
        <h3 className="min-w-0 font-display font-semibold tracking-wider">MATCH: {item.entry.name}</h3>
      </div>
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
  )
}
