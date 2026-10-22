import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  Eye,
  Files as FilesIcon,
  Folder,
  Info,
  ListChecks,
  MoreHorizontal,
  Music,
  PenLine,
  Pencil,
  Pin,
  Play,
  RefreshCw,
  Replace,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'

// icon per AniList airing status, shown inside the detail dialog's t-label chip
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SeriesCardView, useSeriesModal, type CardViewProps, type SeriesAction } from '../components/SeriesModal'
import { useToast } from '../components/toast'
import { RematchDialog, RematchForm, rematchTitle } from '../components/Rematch'
import { MatchHint } from '../components/MatchHint'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import ActionSheet from '../components/ActionSheet'
import Press from '../components/Press'
import PickerBack from '../components/PickerBack'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  Row,
  RowAction,
  Rows,
  SectionHeading,
  Select,
  Switch,
  enterPage,
  localTransition,
  useMediaQuery,
  useMenu,
  useReveal,
} from 'fluid-lycoris'
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
  type Watch,
} from '../api'
import {
  CATALOG_SORTS,
  CATALOG_STATUSES,
  filterByStatus,
  sortGroups,
  useCatalogSort,
  useCatalogStatus,
  type CatalogSort,
  type CatalogStatus,
} from '../components/catalogSort'
import { CatalogPendingTile, CatalogTile, useTileRise, vtName } from '../components/CatalogTile'
import { CatalogViewSwitch } from '../components/CatalogViewSwitch'
import SourcePicker from '../components/SourcePicker'
import { scopeChanged, useCatalogView, useScopeInfo } from '../components/useCatalogView'
import ScopeRuleLine from '../components/ScopeRuleLine'
import { FileBrowser, LocalPicker, openKind, PathCrumbs, PHONE_SORTS } from '../components/FileBrowser'
import { useStored } from '../hooks/useStored'
import { catalogTitle, firstVideo, isVideo, playHref, viewHref, viewKind } from '../components/playLinks'
import PathInput from '../components/PathInput'
import FileIcon from '../components/FileIcon'
import PageActions, { PageToolbar, WIDE_MQ } from '../components/PageActions'
import { TrashButton } from './Trash'
import RenameOptions, { type RenameProfile, type RenameRule } from '../components/RenameOptions'
import RenamePreview from '../components/RenamePreview'
import { useRenamePreview } from '../components/useRenamePreview'
import {
  subfolderMode,
  subfolderTargetDir,
  syncRequestPath,
  useLocalTargetLabel,
  useTargetFolder,
} from '../components/useTargetFolder'
import HostKeyPrompt from '../components/HostKeyPrompt'
import FolderBookmarks, { BookmarkToggle } from '../components/FolderBookmarks'
import { useBookmarks } from '../components/bookmarks'
import SubfolderChoice from '../components/SubfolderChoice'
import UpcomingSeason from '../components/UpcomingSeason'
import WatchDialog, { WatchForm, type WatchFields } from '../components/WatchDialog'
import { applyDefaults, useFolderKind, useWatchDefaults } from '../components/watchDefaults'
import { useConfirm } from '../components/confirm'
import { useAuth, useProviders } from '../hooks'
import { SkeletonRows } from '../components/Loading'
import { CatalogWhy } from '../components/CatalogWhy'
import { InlineRename, type Renaming } from '../components/InlineRename'
import './files.css'

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
// Files keeps its folder in the URL, one history entry per step. A jump
// (navigation state from the search) still mounts it afresh, so a stale
// search text or selection does not carry over.
export function FilesJump() {
  const { state } = useLocation()
  return <Files key={(state as { jump?: number } | null)?.jump ?? 0} />
}

export default function Files() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const goTo = useNavigate()
  const { data: servers = [], isSuccess: serversIn } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const [params, setParams] = useSearchParams()
  // the source from the link, else the one used last, else the first server
  // once the list is in, else the local library
  // The link is the state: source and folder live in the URL, so every step
  // into a folder or to another server is a history entry and the back
  // gesture goes up one folder before it leaves the page.
  const chosen: Source | null = sourceFromParams(params) ?? sourceFromStorage()
  // a server remembered from an earlier visit (or named in an old link) may
  // have been deleted since: once the list is in, it falls back like no choice
  const gone = typeof chosen === 'number' && serversIn && !servers.some((s) => s.id === chosen)
  const source: Source = (gone ? null : chosen) ?? servers[0]?.id ?? 'local'
  const isLocal = source === 'local'
  // the catalog API addresses the local library as server 0
  const active = isLocal ? 0 : source
  const series = useSeriesModal()
  // A file plays from its title's card when the folder it lies in - or, for a
  // season folder, the one above - is matched to a title: the card opens on
  // its episodes, the file marked. The match is what the catalog of the level
  // above says (the same query, so a catalog seen before answers from cache).
  // A file of no known title plays directly.
  const playFile = async (e: Entry) => {
    // a book, a song, a document: the viewer, no title card in between
    if (!isVideo(e.name)) {
      if (viewKind(e.name)) goTo(viewHref(active, e.path))
      return
    }
    try {
      const it = await catalogTitle(qc, active, e.path)
      if (it) {
        series.open({
          source: it.source,
          id: it.media.id,
          media: it.media,
          folders: [{ server: active, path: it.dir }],
          playPath: e.path,
          tab: 'episodes',
        })
        return
      }
    } catch {
      // no catalog to ask: the file still plays
    }
    goTo(playHref(active, e.path))
  }
  // deep links (the dashboard queue, suggestions) open the browser at a folder
  const path = (params.get('path') ?? '').replace(/^\//, '')
  // null = untouched, so the default target fills in; an emptied field is a
  // choice too (the download folder itself) and must not refill
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [picked, setSelection] = useState<Entry | null>(null)
  // back or forward lands in another folder: a row picked in the old one goes
  const selection = picked && picked.path.replace(/^\//, '').replace(/\/?[^/]*$/, '') === path ? picked : null
  // a finger held on a row: its actions as a sheet
  const [sheet, setSheet] = useState<Entry | null>(null)
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
      ? applyDefaults(blankWatch(syncEntry.path, localPath ?? ''), syncKind?.kind, defaults, syncKind)
      : null
  // a target picked on this page wins, the default one fills in otherwise;
  // the subfolder choice follows the default only while nothing was picked
  const syncLocal = localPath ?? syncSeed?.localPath ?? ''
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
  // one step in the browser: a new entry, the search is left behind
  const go = (src: Source, to: string) => {
    const next = new URLSearchParams()
    if (src === 'local') next.set('source', 'local')
    else next.set('server', String(src))
    if (to) next.set('path', to)
    setParams(next)
    setQuery('')
  }
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

  // Normalising (a missing or stale source, the search text) replaces the
  // entry instead of adding one, so it never costs a back press.
  useEffect(() => {
    // no source named yet and the server list still out: "local" would stick
    if (!chosen && !serversIn) return
    const next = new URLSearchParams()
    if (isLocal) next.set('source', 'local')
    else next.set('server', String(source))
    if (path) next.set('path', path)
    if (query.trim()) next.set('q', query)
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [isLocal, source, path, query, params, setParams, chosen, serversIn])
  const pickSource = (s: Source, to = '') => {
    go(s, to)
    setSelection(null)
    try {
      localStorage.setItem(SOURCE_KEY, String(s))
    } catch {
      /* best effort */
    }
  }

  // default classic, catalog only for folders the user saved as catalog
  // (server-side scope mark); "once"/"saved" switch and persist per folder
  const { view, value: viewValue, set: setView } = useCatalogView(active, path)

  // undo for an accidental sync click: cancel the just-queued batch
  const cancelQueued = async (ids: number[]) => {
    try {
      const out = await api.post<{ canceled: number }>('/api/downloads/cancel', { ids })
      toast({ message: t('remote.syncCanceled', { count: out.canceled }) })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : t('app.error'), error: true })
    }
  }
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
    // what was queued, with the way back while the toast stands
    onSuccess: (r) => {
      const ids = r.ids ?? []
      toast({
        message: t('remote.queued', { count: r.queued }),
        undo: ids.length > 0 ? () => void cancelQueued(ids) : undefined,
      })
    },
    onError: (e) => toast({ message: e instanceof Error ? e.message : t('app.error'), error: true }),
  })

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
    initial: applyDefaults(blankWatch(entry.path, localPath ?? ''), watchKind?.kind, defaults, watchKind),
    onSave: async (f: WatchFields) => {
      await api.post('/api/watches', { serverId: active, ...f })
      // the auto-sync page, and the card's auto-sync section on the way back,
      // show the new watch
      await qc.invalidateQueries({ queryKey: ['watches'] })
      toast({ message: t('watch.created') })
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
      title: t('files.deleteTitle', { name: e.name }),
      message: e.isDir ? t('local.deleteDirConfirm', { name: e.name }) : t('local.deleteConfirm', { name: e.name }),
      confirmLabel: t('files.deleteForever'),
      destructive: true,
    })
    if (!ok) return
    setError('')
    try {
      // recursive only for directories: a folder the user confirmed goes
      // completely, a file needs no flag
      await api.del('/api/browse/local', { path: e.path, recursive: e.isDir })
      refreshLocal()
      toast({ message: t('files.deleted') })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  // selection mode (local library, admins): rows get a check, a tap toggles,
  // and the bar acts on all of them. A local delete skips the trash, so it
  // asks first; no undo pretends otherwise.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [checkedPlace, setCheckedPlace] = useState(`${source}:${path}`)
  if (checkedPlace !== `${source}:${path}`) {
    setCheckedPlace(`${source}:${path}`)
    setChecked(new Set())
  }
  const toggle = (e: Entry) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (!next.delete(e.path)) next.add(e.path)
      return next
    })
  const startSelecting = (e: Entry) => {
    setSelection(null)
    setChecked(new Set([e.path]))
  }
  const removeChecked = async () => {
    const paths = [...checked]
    const ok = await confirm({
      title: t('files.deleteManyTitle', { count: paths.length }),
      message: t('files.deleteManyConfirm', { count: paths.length }),
      confirmLabel: t('files.deleteForever'),
      destructive: true,
    })
    if (!ok) return
    setError('')
    let done = 0
    for (const p of paths) {
      try {
        // a folder in the selection goes with its content, like a single delete
        await api.del('/api/browse/local', { path: p, recursive: true })
        done++
      } catch (err) {
        setError(err instanceof Error ? err.message : t('app.error'))
        break
      }
    }
    setChecked(new Set())
    refreshLocal()
    if (done > 0) toast({ message: t('files.deletedMany', { count: done }) })
  }

  const copyPath = (e: Entry) =>
    navigator.clipboard.writeText(e.path).then(
      () => toast({ message: t('files.pathCopied') }),
      () => toast({ message: `${t('files.copyFailed')} ${e.path}`, error: true }),
    )

  // the catalog tiles' long-press sheet: rename and delete on the local library
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
            icon: <Trash2 aria-hidden size="1.2em" />,
            label: t('local.delete'),
            aria: t('local.deleteItem', { name: e.name }),
            onClick: () => removeLocal(e),
            danger: true,
          },
        ]
      : []

  // what a picked entry can do: the bar on a phone, the info panel on a
  // desktop and the sheet a long press opens read the same list, so they
  // agree. Opening first, then fetching (remote) or editing (local), the
  // path last.
  const actionsOf = (e: Entry): FileAction[] => {
    const kind = e.isDir ? null : openKind(e.name)
    return [
      ...(kind
        ? [
            {
              key: 'open',
              icon: kind === 'play' ? Play : kind === 'listen' ? Music : BookOpen,
              label: t(kind === 'play' ? 'player.play' : kind === 'listen' ? 'files.listen' : 'viewer.open'),
              primary: isLocal,
              onClick: () => playFile(e),
            },
          ]
        : []),
      ...(!isLocal
        ? [
            {
              key: 'sync',
              icon: Download,
              label: t(e.isDir ? 'files.syncFolder' : 'files.loadFile'),
              primary: true,
              onClick: () => {
                setSyncEntry(e)
                setInCard(false)
              },
            },
            ...(e.isDir
              ? [
                  {
                    key: 'watch',
                    icon: Eye,
                    label: t('watch.add'),
                    onClick: () => {
                      setWatchEntry(e)
                      setInCard(false)
                    },
                  },
                ]
              : []),
          ]
        : []),
      ...(canEdit
        ? [
            {
              key: 'rename',
              icon: Pencil,
              label: t('local.rename'),
              aria: t('local.renameItem', { name: e.name }),
              onClick: () => renameLocal(e),
            },
            // the batch renamer works on a folder's episodes; it opens with
            // this folder already chosen
            ...(e.isDir
              ? [
                  {
                    key: 'episodes',
                    icon: PenLine,
                    label: t('local.renameEpisodes'),
                    onClick: () => goTo(`/rename?path=${encodeURIComponent(e.path.replace(/^\//, ''))}`),
                  },
                ]
              : []),
            {
              key: 'select',
              icon: ListChecks,
              label: t('files.selectMany'),
              onClick: () => startSelecting(e),
            },
            {
              key: 'delete',
              icon: Trash2,
              label: t('local.delete'),
              aria: t('local.deleteItem', { name: e.name }),
              variant: 'danger' as const,
              onClick: () => removeLocal(e),
            },
          ]
        : []),
      { key: 'copy', icon: Copy, label: t('files.copyPath'), onClick: () => void copyPath(e) },
    ]
  }
  const actionButton = (a: FileAction, className = '') => (
    <Button
      key={a.key}
      variant={a.variant ?? (a.primary ? 'primary' : undefined)}
      disabled={a.disabled}
      aria-label={a.aria}
      onClick={a.onClick}
      className={className}
    >
      <a.icon aria-hidden size={18} className="mr-1.5 inline shrink-0 align-[-0.2em]" />
      {a.label}
    </Button>
  )

  const navigate = (p: string) => {
    go(source, p.replace(/^\//, ''))
    setSelection(null)
  }
  const browseUrl = (p: string) =>
    isLocal
      ? `/api/browse/local?path=${encodeURIComponent(p)}`
      : `/api/servers/${active}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`
  const [sort, setSort] = useStored<string>('weebsync.files.sort', 'name')
  const selecting = checked.size > 0
  // saved folders: the toggle sits with the path, the menu with the source
  const bookmarks = useBookmarks()
  const here = <BookmarkToggle here={{ source, path }} store={bookmarks} />
  // the phone's bar for a picked entry: up to two actions, the rest in the sheet
  const barActions = selection ? actionsOf(selection).filter((a) => a.key !== 'copy') : []
  const barMain = barActions.slice(0, 2)

  return (
    <div className="page-fill flex min-h-0 flex-1 flex-col">
      {/* the shell carries the page title (app bar on a phone, title row on
          a desktop); the trash rides with it */}
      <PageActions>
        <CatalogViewSwitch value={viewValue} onChange={setView} />
        <TrashButton />
      </PageActions>

      {!isLocal && servers.length === 0 ? (
        <EmptyState>
          <Trans
            i18nKey="remote.noServers"
            components={{ go: <Link to="/settings/servers" className="text-accent underline" /> }}
          />
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 gap-8">
          <section className="flex min-h-64 min-w-0 flex-1 flex-col lg:min-h-0" aria-label={t('files.title')}>
            <div className="ws-cl-bar">
              {/* the source and the search as one field on a phone: the server
                  is the chip at the start of the search */}
              <div className="ws-cl-field">
                {/* names the source, switches it, and holds the way to a new one */}
                <SourcePicker value={source} servers={servers} onChange={pickSource} className="ws-src" />
                {!isLocal && (
                  <label className="ws-cl-search">
                    <Search aria-hidden size={18} />
                    <input
                      type="search"
                      enterKeyHint="search"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
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
                  </label>
                )}
              </div>
              {/* a saved folder is one step away, whichever source it is on */}
              <FolderBookmarks store={bookmarks} servers={servers} onOpen={(b) => pickSource(b.source, b.path)} />
              {view === 'classic' && !query.trim() && (
                <Select
                  wrapperClassName="ws-cl-sort"
                  aria-label={t('files.sortBy')}
                  value={(PHONE_SORTS as readonly string[]).includes(sort) ? sort : 'name'}
                  onChange={(e) => setSort(e.target.value)}
                >
                  {PHONE_SORTS.map((s) => (
                    <option key={s} value={s}>
                      {t(`files.sort_${s.replace('-', '')}`)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {/* Recent searches only while the field is focused and still empty,
              in the flow instead of floating: typing hands over to the live
              results. No <datalist> - mobile browsers (Chrome, Firefox, iOS
              Safari) float its suggestions over the input and the results and
              keep them there while typing. */}
            {!isLocal && searchFocus && !query && recentSearches.length > 0 && (
              <div
                className="ws-cl-recent"
                role="group"
                aria-label={t('remote.recentSearches')}
                // keep focus in the input, so a tap here does not close the row first
                onMouseDown={(e) => e.preventDefault()}
              >
                <span>{t('remote.recentSearches')}</span>
                {recentSearches.map((q) => (
                  <span key={q} className="ws-rq">
                    <button type="button" className="t-link t-link--2" onClick={() => setQuery(q)}>
                      {q}
                    </button>
                    <button
                      type="button"
                      className="ws-rq-x"
                      aria-label={t('remote.forgetSearch', { q })}
                      onClick={() => forgetSearch(q)}
                    >
                      <X aria-hidden size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {error && (
              <p className="py-2 text-sm text-err" role="alert">
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
                onShow={(e) => {
                  // a found file: its folder, the file picked in it
                  navigate(e.path.slice(0, e.path.lastIndexOf('/')))
                  setQuery('')
                  setSelection(e)
                }}
              />
            ) : view === 'classic' ? (
              <FileBrowser
                listClassName="ws-list-scroll"
                crumbsAfter={here}
                queryKey={isLocal ? ['local'] : ['remote', active]}
                fetchPath={browseUrl}
                path={path}
                onNavigate={navigate}
                onSelect={setSelection}
                selected={selection?.path}
                emptyHint={isLocal ? t('files.emptyLocalHint') : undefined}
                serverId={isLocal ? undefined : active}
                renaming={inPlace}
                onPlay={playFile}
                sortable
                sort={sort}
                onSort={setSort}
                checked={canEdit ? checked : undefined}
                onToggle={canEdit ? toggle : undefined}
                onContextSelect={setSelection}
                onLongPress={(e) => {
                  setSelection(e)
                  setSheet(e)
                }}
              />
            ) : (
              <CatalogGrid
                serverId={active}
                path={path}
                crumbsAfter={here}
                pin={{
                  on: viewValue === 'catalogPersist',
                  toggle: () => setView(viewValue === 'catalogPersist' ? 'catalogOnce' : 'catalogPersist'),
                }}
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

            {/* a picked entry on a phone: a card that sticks to the bottom of
                the list, the main actions in reach of the thumb */}
            {selection && !selecting && (
              <div className="ws-cl-actions" role="region" aria-label={t('remote.selectionBar')}>
                <span className="ws-cl-glyph" data-dir={selection.isDir || undefined}>
                  <FileIcon isDir={selection.isDir} name={selection.name} />
                </span>
                <strong title={selection.path}>{selection.name}</strong>
                {barMain.map((a) => actionButton(a))}
                <IconButton
                  aria-label={t('catalog.more')}
                  title={t('catalog.more')}
                  onClick={() => setSheet(selection)}
                >
                  <MoreHorizontal aria-hidden size={20} />
                </IconButton>
              </div>
            )}
          </section>
          {selection && !selecting && (
            <FileInfo
              entry={selection}
              source={isLocal ? t('files.local') : (servers.find((s) => s.id === active)?.name ?? '')}
              actions={actionsOf(selection).map((a) => actionButton(a, 'justify-start'))}
              onClose={() => setSelection(null)}
            />
          )}
        </div>
      )}

      {selecting && (
        // on a phone it takes the tab bar's place, on a desktop it floats
        <PageToolbar>
          <div className="ws-sel-bar" role="toolbar" aria-label={t('files.selection')}>
            <button type="button" className="ws-sel-done" onClick={() => setChecked(new Set())}>
              <X aria-hidden size={20} />
              <span>{t('files.checkedCount', { count: checked.size })}</span>
            </button>
            <button
              type="button"
              onClick={() => goTo(`/rename?path=${encodeURIComponent(path)}`)}
              aria-label={t('local.renameEpisodes')}
            >
              <PenLine aria-hidden size={20} />
              <span>{t('local.rename')}</span>
            </button>
            <button type="button" className="ws-sel-danger" onClick={() => void removeChecked()}>
              <Trash2 aria-hidden size={20} />
              <span>{t('local.delete')}</span>
            </button>
          </div>
        </PageToolbar>
      )}

      {sheet && (
        <ActionSheet
          title={sheet.name}
          actions={actionsOf(sheet)
            .filter((x) => !x.disabled)
            .map((x) => ({
              key: x.key,
              label: x.label,
              icon: <x.icon aria-hidden size="1.1em" />,
              danger: x.variant === 'danger',
              onClick: x.onClick,
            }))}
          onClose={() => setSheet(null)}
        />
      )}
      {syncEntry &&
        syncSeed &&
        (inCard ? (
          <SeriesCardView title={t('remote.syncTitle', { name: syncEntry.name })} onClose={() => setSyncEntry(null)}>
            {(v) => <SyncForm {...v} {...syncProps(syncEntry, syncSeed)} />}
          </SeriesCardView>
        ) : (
          <SyncDialog {...syncProps(syncEntry, syncSeed)} />
        ))}
      {watchEntry &&
        !kindPending &&
        (inCard ? (
          <SeriesCardView title={watchProps(watchEntry).title} onClose={() => setWatchEntry(null)}>
            {(v) => <WatchForm {...v} {...watchProps(watchEntry)} />}
          </SeriesCardView>
        ) : (
          <WatchDialog {...watchProps(watchEntry)} />
        ))}
    </div>
  )
}

interface FileAction {
  key: string
  icon: LucideIcon
  label: string
  aria?: string
  variant?: 'primary' | 'danger'
  /** the entry's main action: filled in the bar and the panel */
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}

// The selection on a desktop: what it is, where it lies and what it can do,
// beside the list instead of a bar under it. The list reflows beside it.
function FileInfo({
  entry,
  source,
  actions,
  onClose,
}: {
  entry: Entry
  source: string
  actions: ReactNode
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const ext = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '').toUpperCase() : ''
  const time = Date.parse(entry.modTime) || 0
  return (
    <aside aria-labelledby="file-info-title" className="ws-fi">
      <div className="ws-fi-hd">
        <h2 id="file-info-title">{t('files.info')}</h2>
        <IconButton aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X aria-hidden size={20} />
        </IconButton>
      </div>
      <div className="ws-fi-top">
        <span className="ws-fi-ic">
          <FileIcon isDir={entry.isDir} name={entry.name} />
        </span>
        <div className="min-w-0">
          <h3>{entry.name}</h3>
          <p>
            {source} · {entry.isDir ? t('files.kindFolder') : ext || t('files.kindFile')}
          </p>
        </div>
      </div>
      <dl className="ws-fi-dl">
        <dt>{t('files.where')}</dt>
        <dd className="font-mono">{entry.path}</dd>
        {!entry.isDir && (
          <>
            <dt>{t('files.colSize')}</dt>
            <dd>{fmtBytes(entry.size)}</dd>
          </>
        )}
        {time > 0 && (
          <>
            <dt>{t('files.colDate')}</dt>
            <dd>{new Date(time).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          </>
        )}
      </dl>
      <div className="ws-fi-acts">{actions}</div>
    </aside>
  )
}

// Search over the server's remote index (built passively + by the crawler,
// may be incomplete while it grows), below the folder the browser stands in.
function SearchResults({
  serverId,
  path,
  query,
  onOpenDir,
  onShow,
}: {
  serverId: number
  path: string
  query: string
  onOpenDir: (path: string) => void
  /** a found file: go to its folder and pick it there */
  onShow: (e: Entry) => void
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
    // the horizontal axis stays with the page's swipe zone, see the browser
    <div className="ws-list-scroll t-scroll min-h-0 flex-1" style={{ touchAction: 'pan-y pinch-zoom' }}>
      {isLoading && <SkeletonRows />}
      {data && data.results.length === 0 && (
        <div className="ws-empty">
          <b>{t('files.noHits', { q: q.trim() })}</b>
          {data.indexed < 100 && <span>{t('remote.indexBuilding')}</span>}
        </div>
      )}
      <ul className="ws-cl-rows">
        {data?.results.map((e) => {
          const dir = e.path.slice(0, e.path.lastIndexOf('/')) || '/'
          return (
            <li key={e.path} className="ws-cl-row">
              <div className="ws-cl-in">
                <span className="ws-cl-glyph" data-dir={e.isDir || undefined}>
                  <FileIcon isDir={e.isDir} name={e.name} />
                </span>
                <div className="ws-cl-main cursor-default!">
                  <strong>{e.name}</strong>
                  <span className="ws-cl-meta font-mono">{dir}</span>
                </div>
                {!e.isDir && <span className="ws-cl-size">{fmtBytes(e.size)}</span>}
                <button
                  type="button"
                  className="ws-cl-pick"
                  aria-label={t(e.isDir ? 'files.openItem' : 'files.showItem', { name: e.name })}
                  onClick={() => (e.isDir ? onOpenDir(e.path) : onShow(e))}
                >
                  {t(e.isDir ? 'files.openPath' : 'files.show')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {data && <p className="mt-2.5 text-sm text-t-muted">{t('remote.indexCount', { count: data.indexed })}</p>}
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
  pin,
  crumbsAfter,
}: {
  serverId: number
  path: string
  /** phone: the pin (keep this folder a catalog folder) lives in the overflow menu */
  pin?: { on: boolean; toggle: () => void }
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
  /** a control behind the path, for the folder in view */
  crumbsAfter?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const goTo = useNavigate()
  // the local library is everyone's: its matches, sources and rules are an
  // admin's to change (the server refuses anyone else). A remote server's
  // catalog belongs to whoever added the server.
  const { data: me } = useAuth()
  const canCurate = serverId !== 0 || !!me?.isAdmin
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
  const caps = useProviders()
  const qc = useQueryClient()
  const listing = `${serverId}:${path}`
  const [keyRejectedFor, setKeyRejectedFor] = useState<string | null>(null)
  const [rematch, setRematch] = useState<CatalogItem | null>(null)
  const [rematchInCard, setRematchInCard] = useState(false)
  // the folder whose match is being explained
  const [why, setWhy] = useState<CatalogItem | null>(null)
  // phone: the source chip's sheet (choice, rule, why)
  const [scopeSheet, setScopeSheet] = useState(false)
  const wide = useMediaQuery(WIDE_MQ)
  // a scope rule marks this folder: the source chip carries a dot for it
  const ruleInfo = useScopeInfo(serverId, path).data
  const ruleOn = !!(ruleInfo?.ruleId && ruleInfo.ruleKind === ruleInfo.scope)
  // WeebSync set this folder's mark itself: the chip says so, a pick below is the user's
  const detectedMark = !!ruleInfo?.detected && !!ruleInfo.scope
  // under the source choice, in the sheet and the popover alike: the rule that
  // marks folders like this one, and why a title matched. `close` shuts the
  // sheet before the why dialog opens over it
  const scopeMore = (close: () => void) =>
    path || (whyHere && data?.scope) ? (
      <div className="ws-scope-more">
        {detectedMark && <p className="text-xs text-t-muted">{t('remote.detectedHint')}</p>}
        {path && canCurate && <ScopeRuleLine serverId={serverId} path={path} kindLabel={scopeLabel} />}
        {whyHere && data?.scope !== '' && (
          <button
            type="button"
            className="t-link self-start text-sm"
            onClick={() => {
              close()
              setWhy(whyHere)
            }}
          >
            {t('explain.whySource')}
          </button>
        )}
      </div>
    ) : null
  // the folder's source shows on any title matching looked at: the first one
  const whyHere = (data?.items ?? []).find((it) => it.source && !it.pending)
  const toast = useToast()
  // a title plays from its first episode; the player walks on from there
  const play = async (e: Entry) => {
    if (starting) return
    setStarting(e.path)
    try {
      const first = await firstVideo(serverId, e.path)
      // no close() first: its delayed step back would pop the player again.
      // An open card stays in history behind it, so back returns to it.
      if (first) goTo(playHref(serverId, first))
      else toast({ message: t('player.noVideo') })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : t('app.error'), error: true })
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
    ...(canCurate
      ? [
          {
            key: 'rematch',
            label: t('series.action.rematch'),
            icon: <Replace aria-hidden size="1em" />,
            more: true,
            onClick: () => rematchInside(it),
          },
        ]
      : []),
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
      actions:
        g.items.length === 1
          ? barActions(g.items[0])
          : [
              {
                key: 'versions',
                label: t('remote.versions', { count: g.items.length }),
                icon: <ChevronDown aria-hidden size="1em" className={ico} />,
                target: VERSIONS_ID,
                onClick: () => {},
              },
            ],
      folders: g.items.map((v) => ({ server: serverId, path: v.entry.path })),
      extra: (
        <CatalogVersions
          group={g}
          selected={selected}
          onSelect={(e) => {
            series.close()
            onSelect(e)
          }}
          onRematch={canCurate ? rematchInside : undefined}
          onWhy={(it) => setWhy(it)}
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
    // why this series, or why none: only for a folder matching has looked at
    const whyAction: TileAction[] =
      !g.pending && it.source
        ? [
            {
              key: 'why',
              icon: <CircleHelp aria-hidden size="1.2em" />,
              label: t(g.media ? 'explain.whyMatch' : 'explain.whyNone'),
              aria: `${t(g.media ? 'explain.whyMatch' : 'explain.whyNone')}: ${it.entry.name}`,
              onClick: () => setWhy(it),
            },
          ]
        : []
    return g.media
      ? [
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
          ...whyAction,
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
          // "Zuordnung korrigieren" spelled out overflows a 131px
          // tile, so it travels as the Replace glyph the detail
          // dialog uses, with the name in title/aria
          ...(!g.pending && it.source && canCurate
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
          ...whyAction,
          ...(cardActions?.(it.entry) ?? []),
        ]
  }
  const [scopeError, setScopeError] = useState('')
  const [sort, setSort] = useCatalogSort()
  const [status, setStatus] = useCatalogStatus()
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

  const scopeOptions = [
    { value: 'auto', label: t('remote.scopeAuto') },
    { value: 'anime', label: t('remote.scopeAnime') },
    { value: 'manga', label: t('remote.scopeManga') },
    { value: 'tv', label: t('remote.scopeTv') },
    { value: 'movie', label: t('remote.scopeMovie') },
    ...(caps?.tvdbApiKeySet ? [{ value: 'tvdb', label: t('remote.scopeTvdb') }] : []),
  ]
  const scopeLabel = (kind: string) => scopeOptions.find((o) => o.value === kind)?.label ?? kind
  // the chip's word: the label without its provider ("Anime" for "Anime (AniList)")
  // while that still names one choice; the sheet and popover keep the full one
  const scopeShort = (kind: string) => {
    const bare = (l: string) => l.replace(/\s*\([^)]*\)$/, '')
    const short = bare(scopeLabel(kind))
    return scopeOptions.filter((o) => bare(o.label) === short).length === 1 ? short : scopeLabel(kind)
  }

  // mark the current folder's metadata source; '' clears the own mark so the
  // parent's (or the anime default) applies again
  const setScope = async (kind: string) => {
    setScopeError('')
    try {
      await api.put(`/api/servers/${serverId}/catalog/scope`, { path: path ? '/' + path : '', kind })
      scopeChanged(qc, serverId)
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  // the watches say what a remote folder is to the user: an Auto-Sync, and
  // how many of its episodes are on disk already
  const { data: watches = [] } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    enabled: serverId !== 0,
  })
  const watchOf = (g: CatalogGroup) =>
    serverId === 0
      ? undefined
      : watches.find((w) => w.serverId === serverId && g.items.some((v) => v.entry.path === w.remotePath))

  // bundle folders matched to the same anime into one card; the version
  // (folder) is picked in a dialog. Unmatched/pending folders stay individual.
  // The source belongs in the key: AniList, TMDB series, TMDB films and TVDB
  // number their entries independently, so a film and a show can share an id
  // and would otherwise collapse into one card that hides both their buttons.
  const allGroups = useMemo(() => {
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
  // the grid holds the titles and the folders still being matched; a folder
  // matching found nothing for lists under its own heading, and one without a
  // source (no scope yet, an alphabet shelf) is plain structure
  const tiles = useMemo(
    () =>
      filterByStatus(
        sortGroups(
          allGroups.filter((g) => g.media || g.pending),
          sort,
        ),
        status,
      ),
    [allGroups, sort, status],
  )
  const unmatched = allGroups.filter((g) => !g.media && !g.pending && g.items[0].source)
  const plain = allGroups.filter((g) => !g.media && !g.pending && !g.items[0].source)
  const seriesCount = allGroups.filter((g) => g.media).length

  // a folder that was being matched and now is: its cover arrives from a zoom
  const pendingNow = items
    .filter((i) => i.pending)
    .map((i) => i.entry.path)
    .join('\n')
  const [pendingBefore, setPendingBefore] = useState(pendingNow)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set())
  if (pendingBefore !== pendingNow) {
    const was = new Set(pendingBefore.split('\n'))
    setFresh(new Set(items.filter((i) => i.media && was.has(i.entry.path)).map((i) => i.entry.path)))
    setPendingBefore(pendingNow)
  }

  // the grid enters with the page and with another folder; a sort or filter
  // change morphs the tiles to their new places instead (no rise on top), and
  // the scroll reveal is set up again after every re-render of the list
  const grid = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useTileRise(grid, `${serverId}:${path}:${isLoading}`)
  useEffect(() => {
    if (!isLoading && root.current) enterPage(root.current)
  }, [serverId, path, isLoading])
  useReveal(grid, '.t-reveal', `${path}:${sort}:${status}:${tiles.length}`)
  const reflow = (update: () => void) => {
    const box = grid.current
    const cells = () => (box ? ([...box.children] as HTMLElement[]) : [])
    const name = () => {
      const h = innerHeight
      for (const c of cells()) {
        const r = c.getBoundingClientRect()
        // only the tiles on screen morph: every named tile is a snapshot
        c.style.setProperty('--vt', r.bottom > 0 && r.top < h && c.dataset.vtKey ? c.dataset.vtKey : 'none')
      }
    }
    name()
    void localTransition(box, () => {
      flushSync(update)
      name()
    }).finally(() => {
      for (const c of cells()) c.style.removeProperty('--vt')
    })
  }

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
      after={crumbsAfter}
    />
  )

  if (isLoading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {crumbs}
        {/* the real grid's shape while the folder loads, so nothing jumps */}
        <div className="ws-cat-grid mt-12" role="status" aria-label={t('remote.catalogLoading')}>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="ws-cat-tile ws-cat-tile--pending animate-pulse" aria-hidden>
              <span className="ws-cat-cover ws-cat-sk" />
              <span className="mt-2 h-3 w-4/5 rounded-xs bg-bg-hover" />
              <span className="mt-1.5 h-2.5 w-1/2 rounded-xs bg-bg-hover" />
            </div>
          ))}
        </div>
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
          <p className="py-6 text-sm text-err">{error instanceof Error ? error.message : t('app.error')}</p>
        )}
      </div>
    )
  }

  const subOf = (g: CatalogGroup): ReactNode => {
    const it = g.items[0]
    if (watchOf(g)) return <span className="ws-cat-sub--sync">{t('catalog.autoSync')}</span>
    if (g.items.length > 1) return t('remote.versions', { count: g.items.length })
    if (it.local) return `${t('local.videoCount', { count: it.local.videos })} · ${fmtBytes(it.local.bytes)}`
    const next = g.media?.nextAiringEpisode
    if (next) {
      const at = new Date(next.airingAt * 1000)
      return t('catalog.nextShort', {
        episode: next.episode,
        day: at.toLocaleDateString(i18n.language, { weekday: 'short' }),
      })
    }
    return undefined
  }
  const haveOf = (g: CatalogGroup) => watchOf(g)?.localFiles ?? g.items[0].local?.videos ?? 0
  const folderName = (name: string) => name.replace(/\s*\[[^\]]*\]\s*$/, '') || name

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      {/* the path, then one row of chips: order, airing state, the source and
          the overflow. Stacked on a phone, side by side on a desktop; outside
          the scroller, so its scrollbar can't clip the last chip */}
      <div className="ws-cat-top">
        {crumbs}
        <div className="ws-cat-chips">
          {tiles.length + (status ? 1 : 0) > 1 && (
            <>
              <Select
                size="sm"
                wrapperClassName="ws-chip-sel"
                aria-label={t('remote.sort')}
                value={sort}
                onChange={(e) => reflow(() => setSort(e.target.value as CatalogSort))}
              >
                {CATALOG_SORTS.map((c) => (
                  <option key={c} value={c}>
                    {t(`remote.sort_${c}`)}
                  </option>
                ))}
              </Select>
              <Select
                size="sm"
                wrapperClassName="ws-chip-sel"
                aria-label={t('remote.statusFilter')}
                value={status}
                onChange={(e) => reflow(() => setStatus(e.target.value as CatalogStatus | ''))}
              >
                <option value="">{t('remote.status_all')}</option>
                {CATALOG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`remote.status_${s}`)}
                  </option>
                ))}
              </Select>
            </>
          )}
          {canCurate && (
            <ScopeChip
              wide={wide}
              value={data?.scope ?? ''}
              label={data?.scope === '' ? t('remote.scopeNone') : scopeShort(data?.scope ?? '')}
              ruleOn={ruleOn}
              options={scopeOptions}
              onPick={(v) => void setScope(v)}
              onSheet={() => setScopeSheet(true)}
              more={scopeMore}
            />
          )}
          {canCurate && detectedMark && <span className="ws-chip-note">{t('remote.detected')}</span>}
          <CatalogActions
            canRematch={canCurate && data?.scope !== '' && pendingCount === 0 && items.length > 0}
            noMatchCount={noMatchCount}
            onRematch={triggerRematch}
            onClearScope={canCurate && data && data.scope !== '' ? () => setScope('') : undefined}
            pin={pin}
          />
        </div>
      </div>
      {/* touch-action is only read up to the nearest scroll container, and on a
          phone this one fills the screen - the page's swipe zone sits above it
          and the browser never sees it, so a sideways drag in here became a
          scroll gesture and the page never turned. It has to allow the
          horizontal axis itself. */}
      <div className="ws-list-scroll t-scroll min-h-0 flex-1 pt-2 pb-4" style={{ touchAction: 'pan-y pinch-zoom' }}>
        {/* the notes on the folder's source: an error, the ask to pick one,
            the matching still running */}
        <div className="ws-cat-info">
          {scopeError && (
            <p className="ws-cat-note text-err!" role="alert">
              {scopeError}
            </p>
          )}
          {data?.scope === '' ? (
            <p className="ws-cat-note" role="status">
              {t('remote.scopePick')}
            </p>
          ) : data?.matchingOff ? (
            <p className="ws-cat-note" role="status">
              {t('remote.matchingOff')}
            </p>
          ) : (
            pendingCount > 0 && (
              <p className="ws-cat-note" role="status">
                {t('remote.matchingCount', { count: pendingCount })}
              </p>
            )
          )}
        </div>
        {/* a leaf folder holds files, not titles: offer the classic list instead
          of leaving the user at a dead end */}
        {items.length === 0 && (
          <div className="flex flex-wrap items-center gap-3 py-6">
            <p className="text-sm text-t-muted">{t('remote.noFolders')}</p>
            <Button size="sm" onClick={() => onOpenFiles(path)}>
              {t('remote.showFiles')}
            </Button>
          </div>
        )}
        {plain.length > 0 && (
          <Rows dense className="ws-cat-section">
            {plain.map((g) => (
              <Row
                key={g.key}
                leading={<Folder size={18} />}
                tone="accent-2"
                title={
                  <button type="button" className="text-left" onClick={() => onNavigate(g.items[0].entry.path)}>
                    {g.items[0].entry.name}
                  </button>
                }
              />
            ))}
          </Rows>
        )}
        {unmatched.length > 0 && (
          <section className="ws-cat-section" aria-labelledby="cat-nomatch">
            <SectionHeading
              id="cat-nomatch"
              tone="accent-2"
              title={t('catalog.noMatchTitle')}
              action={<span className="text-sm text-t-muted tabular-nums">{unmatched.length}</span>}
            />
            <Rows>
              {unmatched.map((g) => {
                const it = g.items[0]
                return (
                  <Row
                    key={g.key}
                    leading={<Folder size={18} />}
                    title={
                      renaming?.path === it.entry.path ? (
                        <InlineRename name={it.entry.name} onDone={renaming.onDone} className="w-full" />
                      ) : (
                        <span className="break-words">{folderName(it.entry.name)}</span>
                      )
                    }
                    sub={
                      <>
                        {t('catalog.noMatchSub')}
                        {canCurate && <MatchHint serverId={serverId} item={it} variant="row" />}
                      </>
                    }
                    trailing={
                      <span className="flex shrink-0 items-center">
                        <RowAction tone="accent-2" onClick={() => setWhy(it)}>
                          {t('catalog.why')}
                        </RowAction>
                        <IconButton
                          aria-label={t('catalog.moreFor', { name: it.entry.name })}
                          title={t('catalog.more')}
                          onClick={() => setSheet(g)}
                        >
                          <MoreHorizontal aria-hidden size="1.2em" />
                        </IconButton>
                      </span>
                    }
                  />
                )
              })}
            </Rows>
            {tiles.length > 0 && (
              <SectionHeading
                className="mt-6"
                tone="accent-2"
                title={t('catalog.matchedTitle')}
                action={<span className="text-sm text-t-muted tabular-nums">{seriesCount}</span>}
              />
            )}
          </section>
        )}
        {status && tiles.length === 0 && items.length > 0 && <p className="ws-cat-note">{t('catalog.noneInStatus')}</p>}
        <div ref={grid} className="ws-cat-grid">
          {tiles.map((g, i) => {
            const it = g.items[0]
            const name = mediaTitle(g.media, it.entry.name)
            return (
              <Press
                key={g.key}
                onLongPress={() => setSheet(g)}
                className="ws-cat-cell t-reveal"
                data-vt-key={vtName(g.key)}
                data-fresh={fresh.has(it.entry.path) || undefined}
              >
                {g.media ? (
                  <CatalogTile
                    media={g.media}
                    name={name}
                    sub={subOf(g)}
                    have={haveOf(g)}
                    selected={g.items.some((v) => v.entry.path === selected)}
                    onOpen={() => showDetail(g)}
                    onMenu={() => setSheet(g)}
                    eager={i < 9}
                    priority={i === 0}
                  />
                ) : (
                  <CatalogPendingTile name={folderName(it.entry.name)} />
                )}
                {g.media && g.items.length === 1 && renaming?.path === it.entry.path && (
                  <InlineRename name={it.entry.name} onDone={renaming.onDone} className="mt-1 w-full font-mono" />
                )}
              </Press>
            )
          })}
        </div>
        {items.length > 0 && (
          <p className="ws-cat-foot">
            {t('catalog.footFolders', { count: items.length })}, {t('catalog.footSeries', { count: seriesCount })}
          </p>
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
        {scopeSheet && (
          // the source chip's sheet: what the folder is matched against, the
          // rule that marks folders like it, and why a title matched
          <Dialog sheet width="max-w-sm" aria-labelledby="cat-scope-h" onClose={() => setScopeSheet(false)}>
            <header className="px-5 pt-4 pb-1">
              <h2 id="cat-scope-h" className="font-display text-lg font-semibold">
                {t('remote.scopeAs')}
              </h2>
            </header>
            <div role="radiogroup" aria-labelledby="cat-scope-h" className="ws-scope-opts px-4">
              {scopeOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={data?.scope === o.value}
                  className="ws-scope-opt"
                  onClick={() => {
                    setScopeSheet(false)
                    if (data?.scope !== o.value) void setScope(o.value)
                  }}
                >
                  <span aria-hidden className="ws-radio" />
                  {o.label}
                </button>
              ))}
            </div>
            <div className="mx-4 mb-4">{scopeMore(() => setScopeSheet(false))}</div>
          </Dialog>
        )}
        {why && (
          <CatalogWhy
            serverId={serverId}
            folder={why.entry.path}
            onClose={() => setWhy(null)}
            onRematch={
              canCurate
                ? () => {
                    setRematch(why)
                    setRematchInCard(false)
                    setWhy(null)
                  }
                : undefined
            }
          />
        )}
        {rematch &&
          (rematchInCard ? (
            <SeriesCardView title={rematchTitle(t, rematch)} onClose={() => setRematch(null)}>
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

// The folder's source as a chip: what its titles are looked up as. A tap opens
// the choice with the rule and the why under it, as a sheet on a phone and as
// a popover hanging from the chip on a desktop. A dot on the chip says a rule
// marked the folder; an unset source shows in the accent and asks for one.
function ScopeChip({
  wide,
  value,
  label,
  ruleOn,
  options,
  onPick,
  onSheet,
  more,
}: {
  wide: boolean
  value: string
  label: string
  ruleOn: boolean
  options: { value: string; label: string }[]
  onPick: (value: string) => void
  onSheet: () => void
  /** the rule and the why under the choice; `close` shuts the popover first */
  more: (close: () => void) => ReactNode
}) {
  const { t } = useTranslation()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  const chip = (
    <button
      type="button"
      className="ws-chip"
      data-unset={value === '' || undefined}
      aria-haspopup={wide ? 'listbox' : 'dialog'}
      aria-expanded={wide ? open : undefined}
      onClick={() => (wide ? setOpen((o) => !o) : onSheet())}
    >
      {ruleOn && <span aria-hidden className="ws-chip-dot" />}
      <span className="sr-only">{t('remote.scopeAs')} </span>
      {label}
      <ChevronDown aria-hidden size={14} />
    </button>
  )
  if (!wide) return chip
  return (
    <div className="relative" ref={ref} style={anchorStyle}>
      {chip}
      {open && (
        <Menu anchor={anchor} placement="bottom-end" aria-label={t('remote.scopeAs')} className="ws-scope-pop">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              selected={o.value === value}
              trailing={o.value === value ? <Check aria-hidden size={16} /> : undefined}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onPick(o.value)
              }}
            >
              {o.label}
            </MenuItem>
          ))}
          <li role="none" className="ws-scope-pop-more">
            {more(() => setOpen(false))}
          </li>
        </Menu>
      )}
    </div>
  )
}

// CatalogActions holds what a catalog folder can have done to it: pull the
// automatic matches again, and forget the source this folder was marked with.
// Behind an overflow button, because none of it is part of looking at the
// cards - the row above stayed readable only as long as it was two chips.
function CatalogActions({
  canRematch,
  noMatchCount,
  onRematch,
  onClearScope,
  pin,
}: {
  canRematch: boolean
  noMatchCount: number
  onRematch: (all: boolean) => void
  /** absent while the folder carries no source mark */
  onClearScope?: () => void
  /** phone: keep the folder a catalog folder, the desktop's pin button */
  pin?: { on: boolean; toggle: () => void }
}) {
  const { t } = useTranslation()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  if (!canRematch && !onClearScope && !pin) return null
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
        <Menu kind="menu" anchor={anchor} aria-label={t('remote.catalogActions')}>
          {pin && (
            <>
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={pin.on}
                onClick={() => {
                  setOpen(false)
                  pin.toggle()
                }}
              >
                <Pin aria-hidden size={16} className="mr-2 inline" fill={pin.on ? 'currentColor' : 'none'} />
                {t('remote.catalogPersist')}
              </MenuItem>
              {(canRematch || onClearScope) && <li role="separator" className="my-1 border-t border-border-subtle" />}
            </>
          )}
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
// few enough to fit two rows on a phone
const SEARCH_KEEP = 5

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
  inPage,
  className = '',
}: SyncFormProps & Partial<CardViewProps>) {
  const { t } = useTranslation()
  const [browse, setBrowse] = useState(false)
  // the user's defaults seed the rename rule once, on open
  const [renameOn, setRenameOn] = useState(!!seed?.template)
  const [rule, setRule] = useState<RenameRule>(() => (seed ? ruleOf(seed) : EMPTY_RULE))
  const caps = useProviders()
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
  const targetLabel = useLocalTargetLabel(target)
  return (
    <div className={`dialog-body ${className}`}>
      <header className={`border-b border-border-subtle px-5 ${inPage ? 'py-3' : 'py-4'}`}>
        {/* in the series page its bar names the form, the path stays */}
        {!inPage && (
          <h2 className="font-display font-semibold tracking-wider">{t('remote.syncTitle', { name: entry.name })}</h2>
        )}
        <span className={`block truncate font-mono text-xs text-t-muted ${inPage ? '' : 'mt-1'}`} title={entry.path}>
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
            <div className="mt-2 flex max-h-56 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary/40">
              <PickerBack path={localPath} onNavigate={onLocalPath} />
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
            {t('remote.syncTarget')} <span className="font-mono text-t-secondary">{targetLabel}</span>
          </p>
          {/* no folder name: the full path is right above, and several
                levels can be missing at once */}
          {targetMissing && <p className="text-ctl-sm text-t-muted">{t('watch.targetMissing')}</p>}
        </div>

        <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionRename')}>
          <div className="flex items-center justify-between">
            <Badge tone="accent">{t('watch.sectionRename')}</Badge>
            <Switch
              label={t('watch.renameToggle')}
              labelClassName="text-sm text-t-secondary"
              checked={renameOn}
              onChange={(e) => setRenameOn(e.target.checked)}
            />
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

// the heading the action row's versions button jumps to
const VERSIONS_ID = 'ws-catalog-versions'

// CatalogVersions is the catalog's part of the title card: every folder
// version matched to the title, each selectable for sync and individually
// re-matchable.
function CatalogVersions({
  group,
  selected,
  onSelect,
  onRematch,
  onWhy,
  onFiles,
  onSync,
  onWatch,
}: {
  group: CatalogGroup
  selected?: string
  onSelect: (e: Entry) => void
  /** absent for someone who may not change the match */
  onRematch?: (it: CatalogItem) => void
  /** why this version got its series, or none */
  onWhy?: (it: CatalogItem) => void
  onFiles: (e: Entry) => void
  // a card bundling several folders cannot sync "the" title - the version is
  // picked here, where each row stands for exactly one folder
  onSync?: (e: Entry) => void
  onWatch?: (e: Entry) => void
}) {
  const { t } = useTranslation()

  return (
    <section className="mt-4 border-t border-border-subtle pt-4">
      <h4 id={VERSIONS_ID} tabIndex={-1} className="t-label mb-2">
        {t('remote.versions', { count: group.items.length })}
      </h4>
      <ul>
        {group.items.map((it) => (
          <li
            key={it.entry.path}
            className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2 last:border-b-0"
          >
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
            {onRematch && (
              <Button size="sm" className="shrink-0" onClick={() => onRematch(it)}>
                <Replace aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.changeMatch')}
              </Button>
            )}
            {onWhy && it.source && !it.pending && (
              <Button
                size="sm"
                className="shrink-0"
                aria-label={`${t('explain.whyMatch')}: ${it.entry.name}`}
                onClick={() => onWhy(it)}
              >
                <CircleHelp aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('explain.why')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
