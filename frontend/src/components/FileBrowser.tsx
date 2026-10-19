import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BookOpen, Check, FolderPlus, Music, Pencil, Play } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Input } from 'fluid-lycoris'
import { api, ApiError, fmtBytes, keyConflictOf, type Entry } from '../api'
import FileIcon from './FileIcon'
import { useStored } from '../hooks/useStored'
import Press from './Press'
import HostKeyPrompt from './HostKeyPrompt'
import { SkeletonRows } from './Loading'
import PathInput from './PathInput'
import { InlineRename, type Renaming } from './InlineRename'
import { isVideo, viewKind } from './playLinks'
import './fileBrowser.css'

// Path breadcrumb: root button plus one button per segment, on one line that
// scrolls sideways, the folder you are in last and bold. Shared by the
// classic file list and the catalog grid, so both navigate the same way. Given
// fetchPath/queryKey, the pen swaps the crumbs for a PathInput so a deep path
// can be typed with autocomplete instead of clicked level by level.
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
  // a deep path scrolls: the folder you are in is the part to see
  const nav = useRef<HTMLElement>(null)
  // and the folders before it fade out at the edge while they are cut off
  const cut = (el: HTMLElement) => el.toggleAttribute('data-cut', el.scrollLeft > 1)
  useLayoutEffect(() => {
    const el = nav.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
    cut(el)
  }, [path, editing])

  if (editing && fetchPath && queryKey) {
    const open = (p: string) => {
      onNavigate(p.replace(/^\//, ''))
      setEditing(false)
    }
    return (
      <form
        className="ws-path-in"
        onSubmit={(e) => {
          e.preventDefault()
          open(draft)
        }}
      >
        <PathInput
          value={draft}
          onChange={setDraft}
          onCommit={open}
          onCancel={() => setEditing(false)}
          fetchPath={fetchPath}
          queryKey={queryKey}
          ariaLabel={t('remote.editPath')}
          autoFocus
        />
        <Button type="submit">{t('files.openPath')}</Button>
      </form>
    )
  }

  const canEdit = !!(fetchPath && queryKey)
  return (
    <div className="ws-crumbs-row">
      <nav ref={nav} className="ws-crumbs" aria-label={t('remote.path')} onScroll={(e) => cut(e.currentTarget)}>
        <button type="button" aria-label={t('files.root')} onClick={() => onNavigate('')}>
          /
        </button>
        {crumbs.map((c, i) =>
          i === crumbs.length - 1 ? (
            // the folder you are in: a tap types a path instead, the phone's
            // way in (it has no pencil)
            canEdit ? (
              <button
                key={i}
                type="button"
                aria-current="location"
                className="ws-crumb-here"
                title={t('remote.editPath')}
                onClick={() => {
                  setDraft(path)
                  setEditing(true)
                }}
              >
                {c}
              </button>
            ) : (
              <b key={i} aria-current="location">
                {c}
              </b>
            )
          ) : (
            <span key={i} className="contents">
              <button type="button" onClick={() => onNavigate(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
              <span aria-hidden className="ws-crumb-sep" />
            </span>
          ),
        )}
      </nav>
      {canEdit && (
        <IconButton
          className="ws-icon-sm ws-crumbs-edit"
          aria-label={t('remote.editPath')}
          title={t('remote.editPath')}
          onClick={() => {
            setDraft(path)
            setEditing(true)
          }}
        >
          <Pencil aria-hidden size={18} />
        </IconButton>
      )}
    </div>
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

/** The orders a phone offers in its sort menu (the desktop has the column heads). */
export const PHONE_SORTS = ['name', '-date', '-size'] as const

/** What opening a file does, by kind: plays a video or a song, opens a book or a document. */
export function openKind(name: string): 'play' | 'listen' | 'read' | null {
  if (isVideo(name)) return 'play'
  const kind = viewKind(name)
  if (!kind) return null
  return kind === 'audio' ? 'listen' : 'read'
}

/** The open button at a file row's end: play, the note, or the book. */
export function OpenButton({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const { t } = useTranslation()
  const kind = openKind(entry.name)
  if (!kind) return null
  const Icon = kind === 'play' ? Play : kind === 'listen' ? Music : BookOpen
  const plays = kind !== 'read'
  return (
    <IconButton
      className="ws-icon-sm ws-cl-open"
      aria-label={plays ? t('player.playItem', { name: entry.name }) : t('viewer.openItem', { name: entry.name })}
      title={plays ? t('player.play') : t('viewer.open')}
      onClick={(ev) => {
        ev.stopPropagation()
        onOpen()
      }}
    >
      <Icon aria-hidden size={20} {...(kind === 'play' ? { fill: 'currentColor', strokeWidth: 0 } : {})} />
    </IconButton>
  )
}

// Breadcrumb + list view over a browse endpoint. Works for the local
// picker (/api/browse/local) and the classic file manager (`sortable`), where
// rows carry their open button, a check in selection mode and the columns.
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
  sort: sortProp,
  onSort,
  checked,
  onToggle,
  onContextSelect,
  listClassName,
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
  /** opens a file in the player or viewer: its row gets an open button */
  onPlay?: (e: Entry) => void
  /** the file manager's columns: name, size and date to sort by */
  sortable?: boolean
  /** a finger held on a row: the row's actions */
  onLongPress?: (e: Entry) => void
  /** the order, when the page holds it (the phone's sort menu lives in its bar) */
  sort?: string
  onSort?: (sort: string) => void
  /** selection mode: the checked paths; a row tap toggles while any is checked */
  checked?: ReadonlySet<string>
  /** given, rows carry a check that starts or extends a multi-selection */
  onToggle?: (e: Entry) => void
  /** a right click on a row (desktop): selects it */
  onContextSelect?: (e: Entry) => void
  /** extra classes for the scrolling list, for the page that hosts it */
  listClassName?: string
}) {
  const { t, i18n } = useTranslation()
  // '-date' is newest first; kept across folders and visits
  const [ownSort, setOwnSort] = useStored<string>('weebsync.files.sort', 'name')
  const sort = sortProp ?? ownSort
  const setSort = onSort ?? setOwnSort
  const by = sort.replace('-', '') as SortKey
  const desc = sort.startsWith('-')
  const selecting = !!checked && checked.size > 0
  // a column clicked again turns round; dates and sizes start with the largest
  const pick = (k: SortKey) => setSort(by === k ? (desc ? k : `-${k}`) : k === 'name' ? 'name' : `-${k}`)
  const day = (e: Entry) =>
    time(e) > 0
      ? new Date(e.modTime).toLocaleDateString(i18n.language, { day: 'numeric', month: 'numeric', year: '2-digit' })
      : ''
  const head = (k: SortKey, label: string, className: string) => (
    <button type="button" aria-pressed={by === k} onClick={() => pick(k)} className={className}>
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

  const empty = (bold: string, hint?: string) => (
    <div className="ws-empty">
      <b>{bold}</b>
      {hint && <span>{hint}</span>}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PathCrumbs path={path} onNavigate={onNavigate} fetchPath={fetchPath} queryKey={queryKey} />
      <div className={`t-scroll min-h-0 flex-1${listClassName ? ` ${listClassName}` : ''}`}>
        {isLoading && <SkeletonRows full={sortable} />}
        {conflict ? (
          <HostKeyPrompt
            className="my-4"
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
            empty(t('remote.dirNotFound'))
          ) : (
            <p className="wrap-break-word py-4 text-sm text-err">
              {error instanceof Error ? error.message : t('app.error')}
            </p>
          ))
        )}
        {!isLoading && !error && entries.length === 0 && empty(t('files.emptyDir'), emptyHint)}
        {leafDir && (
          <div className="ws-leaf">
            <span>{t('files.thisFolder')}</span>
            <b>{leafDir.name}</b>
            <button
              type="button"
              className="t-link t-link--2"
              aria-label={t('remote.selectItem', { name: leafDir.name })}
              onClick={() => onSelect!(leafDir)}
            >
              {t('files.pick')}
            </button>
          </div>
        )}
        {sortable && entries.length > 0 && (
          <div role="group" aria-label={t('files.sortBy')} className="ws-cl-head">
            {head('name', t('files.colName'), 'ws-cl-h-name')}
            {head('date', t('files.colDate'), 'ws-cl-h-date')}
            {head('size', t('files.colSize'), 'ws-cl-h-size')}
          </div>
        )}
        <ul className={`ws-cl-rows ${sortable ? 'ws-cl-rows--full' : ''}`} data-selecting={selecting || undefined}>
          {sortEntries(entries, sortable ? sort : 'name').map((e) => {
            const selectable = onSelect && (!selectDirsOnly || e.isDir)
            const isChecked = !!checked?.has(e.path)
            if (renaming?.path === e.path)
              return (
                <li key={e.path} className="ws-cl-row">
                  <div className="ws-cl-in">
                    <span className="ws-cl-glyph" data-dir={e.isDir || undefined}>
                      <FileIcon isDir={e.isDir} name={e.name} />
                    </span>
                    <InlineRename name={e.name} onDone={renaming.onDone} className="ws-cl-rename" />
                  </div>
                </li>
              )
            const openable = !!onPlay && !e.isDir && !!openKind(e.name)
            const tap = () => {
              if (selecting && onToggle) onToggle(e)
              else if (e.isDir) onNavigate(e.path.replace(/^\//, ''))
              else if (selectable) onSelect(e)
            }
            const context = (ev: MouseEvent) => {
              if (!onContextSelect || !matchMedia('(pointer: fine)').matches) return
              ev.preventDefault()
              onContextSelect(e)
            }
            return (
              <Press
                as="li"
                key={e.path}
                onLongPress={onLongPress && !selecting ? () => onLongPress(e) : undefined}
                className="ws-cl-row"
                data-kind={e.isDir ? 'dir' : 'file'}
              >
                <div
                  className="ws-cl-in"
                  data-sel={selected === e.path || undefined}
                  data-checked={isChecked || undefined}
                  onContextMenu={context}
                >
                  {onToggle && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isChecked}
                      aria-label={t('files.checkItem', { name: e.name })}
                      className="ws-cl-check"
                      onClick={() => onToggle(e)}
                    >
                      <Check aria-hidden size={14} strokeWidth={3} />
                    </button>
                  )}
                  <span className="ws-cl-glyph" data-dir={e.isDir || undefined}>
                    <FileIcon isDir={e.isDir} name={e.name} />
                  </span>
                  <button
                    type="button"
                    className="ws-cl-main"
                    onClick={tap}
                    // a video plays and a book opens on a double click; anything else is picked
                    onDoubleClick={() => !selecting && (openable ? onPlay(e) : selectable && onSelect(e))}
                  >
                    <strong>{e.name}</strong>
                    {sortable && !e.isDir && <span className="ws-cl-meta">{day(e)}</span>}
                    {!sortable && !e.isDir && <span className="ws-cl-meta">{fmtBytes(e.size)}</span>}
                  </button>
                  {sortable && (
                    <>
                      <span className="ws-cl-date">{day(e)}</span>
                      <span className="ws-cl-size">{!e.isDir && fmtBytes(e.size)}</span>
                    </>
                  )}
                  {selectable && e.isDir && !selecting ? (
                    <button
                      type="button"
                      className="ws-cl-pick"
                      aria-label={t('remote.selectItem', { name: e.name })}
                      onClick={() => onSelect(e)}
                    >
                      {t('files.pick')}
                    </button>
                  ) : openable && !selecting ? (
                    <OpenButton entry={e} onOpen={() => onPlay(e)} />
                  ) : (
                    sortable && <span aria-hidden className="ws-cl-sp" />
                  )}
                  {actions?.(e)}
                </div>
              </Press>
            )
          })}
        </ul>
      </div>
    </div>
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
          kind="code"
          enterKeyHint="done"
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
