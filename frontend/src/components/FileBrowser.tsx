import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, fmtBytes, type Entry } from '../api'
import Loading from './Loading'

// Path breadcrumb: root button plus one button per segment. Shared by the
// classic file list and the catalog grid, so both navigate the same way.
export function PathCrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const { t } = useTranslation()
  const crumbs = path.split('/').filter(Boolean)
  return (
    <nav className="flex flex-wrap items-center border-b border-border-subtle px-2 py-1 font-mono text-xs" aria-label={t('browser.path')}>
      {/* min 24x24 target (WCAG 2.5.8) */}
      <button type="button" className="min-h-6 min-w-6 px-1.5 text-accent hover:underline" onClick={() => onNavigate('')}>
        /
      </button>
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center">
          <button
            type="button"
            className="min-h-6 max-w-40 truncate px-1.5 text-accent hover:underline"
            onClick={() => onNavigate(crumbs.slice(0, i + 1).join('/'))}
          >
            {c}
          </button>
          {i < crumbs.length - 1 && <span className="text-t-faint">/</span>}
        </span>
      ))}
    </nav>
  )
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
}: {
  queryKey: unknown[]
  fetchPath: (path: string) => string
  path: string
  onNavigate: (path: string) => void
  onSelect?: (e: Entry) => void
  selected?: string
  selectDirsOnly?: boolean
  emptyHint?: string
}) {
  const { t } = useTranslation()
  const { data: entries = [], isLoading, error } = useQuery<Entry[]>({
    queryKey: [...queryKey, path],
    queryFn: () => api.get(fetchPath(path)),
  })

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
      <PathCrumbs path={path} onNavigate={onNavigate} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Loading className="p-4" />}
        {error && <p className="wrap-break-word p-4 text-sm text-err">{error instanceof Error ? error.message : t('app.error')}</p>}
        {!isLoading && !error && entries.length === 0 && (
          <p className="p-4 text-sm text-t-muted">{emptyHint ?? t('browser.emptyDir')}</p>
        )}
        {leafDir && (
          <div className="flex items-stretch border-b border-border-subtle bg-bg-secondary/50">
            <span className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-sm text-t-muted">
              <span aria-hidden className="font-mono text-xs text-accent">▾</span>
              <span className="truncate">{t('browser.thisFolder', { name: leafDir.name })}</span>
            </span>
            <button
              type="button"
              className="t-btn t-btn--sm my-1 mr-2 shrink-0"
              aria-label={t('browser.selectItem', { name: leafDir.name })}
              onClick={() => onSelect!(leafDir)}
            >
              {t('browser.select')}
            </button>
          </div>
        )}
        <ul>
          {entries
            .slice()
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
            .map((e) => {
              const selectable = onSelect && (!selectDirsOnly || e.isDir)
              return (
                <li key={e.path} className="flex items-stretch border-b border-border-subtle/50">
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-bg-hover ${
                      selected === e.path ? 'bg-bg-hover text-accent' : 'text-t-secondary'
                    }`}
                    onClick={() => {
                      if (e.isDir) onNavigate(e.path.replace(/^\//, ''))
                      else if (selectable) onSelect(e)
                    }}
                    onDoubleClick={() => selectable && onSelect(e)}
                  >
                    <span aria-hidden className={`font-mono text-xs ${e.isDir ? 'text-accent' : 'text-t-faint'}`}>
                      {e.isDir ? '▸' : '·'}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={e.name}>
                      {e.name}
                    </span>
                    {!e.isDir && <span className="shrink-0 font-mono text-xs text-t-muted">{fmtBytes(e.size)}</span>}
                  </button>
                  {selectable && e.isDir && (
                    <button
                      type="button"
                      className="t-btn t-btn--sm my-1 mr-2 shrink-0"
                      aria-label={t('browser.selectItem', { name: e.name })}
                      onClick={() => onSelect(e)}
                    >
                      {t('browser.select')}
                    </button>
                  )}
                </li>
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
        emptyHint={t('browser.emptyLocal')}
      />
      <div className="flex gap-2 border-t border-border-subtle p-2">
        <label className="sr-only" htmlFor="mkdir-input">
          {t('browser.newFolder')}
        </label>
        <input
          id="mkdir-input"
          className="t-input py-1 text-xs"
          placeholder={t('browser.newFolder')}
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && mkdir()}
        />
        <button type="button" className="t-btn t-btn--sm shrink-0" onClick={mkdir}>
          {t('browser.createFolder')}
        </button>
      </div>
      {mkdirError && (
        <p className="px-2 pb-2 text-xs text-err" role="alert">
          {mkdirError}
        </p>
      )}
    </div>
  )
}
