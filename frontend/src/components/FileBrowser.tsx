import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtBytes, type Entry } from '../api'

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
  const { data: entries = [], isLoading, error } = useQuery<Entry[]>({
    queryKey: [...queryKey, path],
    queryFn: () => api.get(fetchPath(path)),
  })

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-3 py-2 font-mono text-xs" aria-label="Pfad">
        <button className="text-accent hover:underline" onClick={() => onNavigate('')}>
          /
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <button
              className="max-w-40 truncate text-accent hover:underline"
              onClick={() => onNavigate(crumbs.slice(0, i + 1).join('/'))}
            >
              {c}
            </button>
            {i < crumbs.length - 1 && <span className="text-t-faint">/</span>}
          </span>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-t-muted">lädt…</p>}
        {error && <p className="p-4 text-sm text-err">{error instanceof Error ? error.message : 'Fehler'}</p>}
        {!isLoading && !error && entries.length === 0 && (
          <p className="p-4 text-sm text-t-faint">{emptyHint ?? 'leer'}</p>
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
                    {!e.isDir && <span className="shrink-0 font-mono text-xs text-t-faint">{fmtBytes(e.size)}</span>}
                  </button>
                  {selectable && e.isDir && (
                    <button
                      className="t-btn t-btn--sm my-1 mr-2 shrink-0"
                      aria-label={`${e.name} auswählen`}
                      onClick={() => onSelect(e)}
                    >
                      wählen
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
  const qc = useQueryClient()
  const [newDir, setNewDir] = useState('')
  const mkdir = async () => {
    if (!newDir.trim()) return
    await api.post('/api/browse/local/mkdir', { path: `${path}/${newDir.trim()}` })
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
        emptyHint="leer — Unterordner unten anlegen"
      />
      <div className="flex gap-2 border-t border-border-subtle p-2">
        <input
          className="t-input py-1 text-xs"
          placeholder="neuer Ordner…"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && mkdir()}
        />
        <button className="t-btn t-btn--sm shrink-0" onClick={mkdir}>
          mkdir
        </button>
      </div>
    </div>
  )
}
