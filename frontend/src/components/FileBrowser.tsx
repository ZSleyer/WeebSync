import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BookOpen, Eye, FolderOpen, FolderPlus, Pencil, Play } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@weebsync/design-system'
import { api, ApiError, fmtBytes, keyConflictOf, type Entry } from '../api'
import FileIcon from './FileIcon'
import { useStored } from '../hooks/useStored'
import Press from './Press'
import HostKeyPrompt from './HostKeyPrompt'
import Loading from './Loading'
import PathInput from './PathInput'
import { InlineRename, type Renaming } from './InlineRename'
import { isVideo, viewKind } from './playLinks'

// Path breadcrumb: root button plus one button per segment. Shared by the
// classic file list and the catalog grid, so both navigate the same way. Given
// fetchPath/queryKey, an edit button swaps the crumbs for a PathInput so a deep
// path can be typed with autocomplete instead of clicked level by level.
export function PathCrumbs({
  path,
  onNavigate,
  fetchPath,
  queryKey,
}: {
  path: string
  onNavigate: (path: string) => void
  fetchPath?: (path: string) => string
  queryKey?: unknown[]
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const crumbs = path.split('/').filter(Boolean)

  if (editing && fetchPath && queryKey) {
    return (
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1">
        <PathInput
          value={draft}
          onChange={setDraft}
          onCommit={(p) => {
            onNavigate(p.replace(/^\//, ''))
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
          fetchPath={fetchPath}
          queryKey={queryKey}
          ariaLabel={t('remote.editPath')}
          autoFocus
        />
      </div>
    )
  }

  const canEdit = !!(fetchPath && queryKey)
  const startEdit = () => {
    setDraft(path)
    setEditing(true)
  }
  return (
    // clicking the empty path area (not a crumb) opens the editor; crumb
    // buttons stop propagation so they still navigate
    <nav
      className={`flex flex-wrap items-center border-b border-border-subtle px-2 py-1 font-mono text-xs ${canEdit ? 'cursor-text' : ''}`}
      aria-label={t('remote.path')}
      onClick={canEdit ? startEdit : undefined}
    >
      {/* min 24x24 target (WCAG 2.5.8) */}
      <button
        type="button"
        className="min-h-6 min-w-6 px-1.5 text-accent hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          onNavigate('')
        }}
      >
        /
      </button>
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center">
          <button
            type="button"
            className="min-h-6 min-w-6 max-w-40 truncate px-1.5 text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              onNavigate(crumbs.slice(0, i + 1).join('/'))
            }}
          >
            {c}
          </button>
          {i < crumbs.length - 1 && <span className="text-t-faint">/</span>}
        </span>
      ))}
      {canEdit && (
        <button
          type="button"
          className="ml-auto flex min-h-6 min-w-6 items-center justify-center px-1.5 text-t-muted hover:text-accent"
          aria-label={t('remote.editPath')}
          title={t('remote.editPath')}
          onClick={(e) => {
            e.stopPropagation()
            startEdit()
          }}
        >
          <Pencil aria-hidden size="0.9em" />
        </button>
      )}
    </nav>
  )
}

type SortKey = 'name' | 'size' | 'date'
const time = (e: Entry) => Date.parse(e.modTime) || 0
const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true })
const ORDER: Record<SortKey, (a: Entry, b: Entry) => number> = {
  name: byName,
  size: (a, b) => a.size - b.size,
  date: (a, b) => time(a) - time(b),
}

/** A listing in the order picked: folders first, then by name, size or date, either way round. */
export function sortEntries(entries: Entry[], sort: string) {
  const desc = sort.startsWith('-')
  const by = ORDER[sort.replace('-', '') as SortKey] ?? byName
  return entries.slice().sort((a, b) => Number(b.isDir) - Number(a.isDir) || (desc ? -1 : 1) * by(a, b) || byName(a, b))
}

// Breadcrumb + list view over a browse endpoint. Works for the local
// picker (/api/browse/local) and the classic remote view.
export function FileBrowser({
  queryKey,
  fetchPath,
  path,
  onNavigate,
  onSelect,
  selected,
  selectDirsOnly,
  emptyHint,
  actions,
  serverId,
  renaming,
  onPlay,
  sortable,
  onLongPress,
}: {
  queryKey: unknown[]
  fetchPath: (path: string) => string
  path: string
  onNavigate: (path: string) => void
  onSelect?: (e: Entry) => void
  selected?: string
  selectDirsOnly?: boolean
  emptyHint?: string
  // extra per-row controls, e.g. rename/delete on the local files page
  actions?: (e: Entry) => ReactNode
  /** the remote server listed here; a host key it asks to review is offered in place */
  serverId?: number
  /** the row whose name is being edited in place */
  renaming?: Renaming
  /** opens a video in the player: its row's icon becomes the play button */
  onPlay?: (e: Entry) => void
  /** the file manager's columns: name, size and date to sort by */
  sortable?: boolean
  /** a finger held on a row: the row's actions */
  onLongPress?: (e: Entry) => void
}) {
  const { t, i18n } = useTranslation()
  // '-date' is newest first; kept across folders and visits
  const [sort, setSort] = useStored<string>('weebsync.files.sort', 'name')
  const by = sort.replace('-', '') as SortKey
  const desc = sort.startsWith('-')
  // a column clicked again turns round; dates start with the newest
  const pick = (k: SortKey) => setSort(by === k ? (desc ? k : `-${k}`) : k === 'date' ? '-date' : k)
  const day = (e: Entry) =>
    time(e) > 0
      ? new Date(e.modTime).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit', year: '2-digit' })
      : ''
  const head = (k: SortKey, label: string, className: string) => (
    <button
      type="button"
      aria-pressed={by === k}
      onClick={() => pick(k)}
      className={`flex min-h-6 items-center gap-1 hover:text-t-primary ${by === k ? 'text-t-primary' : ''} ${className}`}
    >
      {label}
      {by === k && (desc ? <ArrowDown aria-hidden size="1em" /> : <ArrowUp aria-hidden size="1em" />)}
      {by === k && <span className="sr-only">{t(desc ? 'files.sortDesc' : 'files.sortAsc')}</span>}
    </button>
  )
  const qc = useQueryClient()
  const {
    data: entries = [],
    isLoading,
    error,
  } = useQuery<Entry[]>({
    queryKey: [...queryKey, path],
    queryFn: () => api.get(fetchPath(path)),
  })
  // a key the user rejected stays out of the way until the next listing
  const listing = `${serverId}:${path}`
  const [rejectedFor, setRejectedFor] = useState<string | null>(null)
  const conflict = serverId !== undefined && rejectedFor !== listing ? keyConflictOf(error) : null
  // the folders' select button gets a column of its own, kept empty on the
  // files, so the size and date line up down the list
  const selCol = !!sortable && !!onSelect && !selectDirsOnly && entries.some((e) => e.isDir)

  const crumbs = path.split('/').filter(Boolean)

  // a leaf folder (only files inside) is selectable as a whole, so a season
  // folder can be synced/watched from within; the absolute path comes from
  // the first child since `path` is root-relative
  const leafDir: Entry | null =
    onSelect && path && entries.length > 0 && entries.every((e) => !e.isDir)
      ? {
          name: crumbs[crumbs.length - 1],
          path: entries[0].path.slice(0, entries[0].path.lastIndexOf('/')),
          size: 0,
          isDir: true,
          modTime: '',
        }
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PathCrumbs path={path} onNavigate={onNavigate} fetchPath={fetchPath} queryKey={queryKey} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Loading className="p-4" />}
        {conflict ? (
          <HostKeyPrompt
            className="m-4"
            serverId={serverId!}
            conflict={conflict}
            onAccepted={() => qc.invalidateQueries({ queryKey })}
            onRejected={() => setRejectedFor(listing)}
          />
        ) : (
          error &&
          // a folder that is not there (deleted, renamed, an old link) is said
          // so in words; the breadcrumbs above lead back up
          (error instanceof ApiError && error.status === 404 ? (
            <p className="p-4 text-sm text-t-muted">{t('remote.dirNotFound')}</p>
          ) : (
            <p className="wrap-break-word p-4 text-sm text-err">
              {error instanceof Error ? error.message : t('app.error')}
            </p>
          ))
        )}
        {!isLoading && !error && entries.length === 0 && (
          <p className="p-4 text-sm text-t-muted">{emptyHint ?? t('remote.emptyDir')}</p>
        )}
        {leafDir && (
          <div className="flex items-stretch border-b border-border-subtle bg-bg-secondary/50">
            <span className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-sm text-t-muted">
              <FolderOpen aria-hidden size="1em" className="shrink-0 text-accent" />
              <span className="truncate">{t('remote.thisFolder', { name: leafDir.name })}</span>
            </span>
            <Button
              size="sm"
              className="my-1 mr-2 shrink-0"
              aria-label={t('remote.selectItem', { name: leafDir.name })}
              onClick={() => onSelect!(leafDir)}
            >
              {t('remote.select')}
            </Button>
          </div>
        )}
        {sortable && entries.length > 0 && (
          <div
            role="group"
            aria-label={t('files.sortBy')}
            className="flex items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-t-muted"
          >
            {head('name', t('files.colName'), 'mr-auto')}
            {head('size', t('files.colSize'), 'w-20 justify-end')}
            {head('date', t('files.colDate'), 'hidden w-20 justify-end sm:flex')}
            {selCol && <span aria-hidden className="w-20 shrink-0" />}
          </div>
        )}
        <ul>
          {sortEntries(entries, sortable ? sort : 'name').map((e) => {
            const selectable = onSelect && (!selectDirsOnly || e.isDir)
            if (renaming?.path === e.path)
              return (
                <li key={e.path} className="flex items-center gap-2 border-b border-border-subtle/50 px-3 py-1">
                  <FileIcon isDir={e.isDir} name={e.name} />
                  <InlineRename name={e.name} onDone={renaming.onDone} />
                </li>
              )
            const playable = !!onPlay && !e.isDir && (isVideo(e.name) || !!viewKind(e.name))
            return (
              <Press
                as="li"
                key={e.path}
                onLongPress={onLongPress && (() => onLongPress(e))}
                className="group/row flex items-stretch border-b border-border-subtle/50"
              >
                {playable && <PlayIcon name={e.name} onPlay={() => onPlay(e)} />}
                <button
                  type="button"
                  className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left text-sm transition-colors hover:bg-bg-hover ${
                    playable ? 'pl-1' : 'pl-3'
                  } ${selected === e.path ? 'bg-bg-hover text-accent' : 'text-t-secondary'}`}
                  onClick={() => {
                    if (e.isDir) onNavigate(e.path.replace(/^\//, ''))
                    else if (selectable) onSelect(e)
                  }}
                  // a video plays and a book opens on a double click; anything else is picked
                  onDoubleClick={() => (playable ? onPlay(e) : selectable && onSelect(e))}
                >
                  {!playable && <FileIcon isDir={e.isDir} name={e.name} />}
                  <span className="min-w-0 flex-1 truncate" title={e.name}>
                    {e.name}
                  </span>
                  {sortable ? (
                    <>
                      <span className="w-20 shrink-0 text-right font-mono text-xs text-t-muted">
                        {!e.isDir && fmtBytes(e.size)}
                      </span>
                      <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-t-muted sm:block">
                        {day(e)}
                      </span>
                    </>
                  ) : (
                    !e.isDir && <span className="shrink-0 font-mono text-xs text-t-muted">{fmtBytes(e.size)}</span>
                  )}
                </button>
                {selectable && e.isDir && (
                  <Button
                    size="sm"
                    className={`my-1 mr-2 shrink-0 ${selCol ? 'w-18' : ''}`}
                    aria-label={t('remote.selectItem', { name: e.name })}
                    onClick={() => onSelect(e)}
                  >
                    {t('remote.select')}
                  </Button>
                )}
                {selCol && !e.isDir && <span aria-hidden className="mr-2 w-18 shrink-0" />}
                {actions?.(e)}
              </Press>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

// PlayIcon is a row's file icon that is also its play button: the file's
// glyph turns into what opening it does under the pointer or focus - play for
// a video or a song, the book for a volume or a PDF, the eye for anything to
// look at - so a file opens from where it is listed instead of from an action bar.
export function PlayIcon({ name, onPlay }: { name: string; onPlay: () => void }) {
  const { t } = useTranslation()
  const kind = viewKind(name)
  // a song plays like a video; everything else opens
  const plays = isVideo(name) || kind === 'audio'
  return (
    <button
      type="button"
      className="t-play-icon"
      aria-label={plays ? t('player.playItem', { name }) : t('viewer.openItem', { name })}
      title={plays ? t('player.play') : t('viewer.open')}
      onClick={onPlay}
    >
      <FileIcon isDir={false} name={name} className="t-play-icon__file" />
      {plays ? (
        <Play aria-hidden size="1em" className="t-play-icon__play" fill="currentColor" strokeWidth={0} />
      ) : kind === 'comic' || kind === 'epub' || kind === 'pdf' ? (
        <BookOpen aria-hidden size="1em" className="t-play-icon__play" />
      ) : (
        <Eye aria-hidden size="1em" className="t-play-icon__play" />
      )}
    </button>
  )
}

// Local destination picker with mkdir.
export function LocalPicker({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [newDir, setNewDir] = useState('')
  const [mkdirError, setMkdirError] = useState('')
  const mkdir = async () => {
    if (!newDir.trim()) return
    setMkdirError('')
    try {
      await api.post('/api/browse/local/mkdir', { path: `${path}/${newDir.trim()}` })
    } catch (err) {
      setMkdirError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    setNewDir('')
    qc.invalidateQueries({ queryKey: ['local'] })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileBrowser
        queryKey={['local']}
        fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
        path={path}
        onNavigate={onNavigate}
        emptyHint={t('remote.emptyLocal')}
      />
      <div className="flex gap-2 border-t border-border-subtle p-2">
        <label className="sr-only" htmlFor="mkdir-input">
          {t('remote.newFolder')}
        </label>
        <Input
          id="mkdir-input"
          className="py-1 text-xs"
          placeholder={t('remote.newFolder')}
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && mkdir()}
        />
        <Button size="sm" className="shrink-0" onClick={mkdir}>
          <FolderPlus aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('remote.createFolder')}
        </Button>
      </div>
      {mkdirError && (
        <p className="px-2 pb-2 text-xs text-err" role="alert">
          {mkdirError}
        </p>
      )}
    </div>
  )
}
