import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Clock, Download as DownloadIcon, Pause, Play, RefreshCw, RotateCcw, Trash2, TriangleAlert, X, type LucideIcon } from 'lucide-react'

// icon per download status, shown inside the t-label chips (inline-flex, 4px gap)
const STATUS_ICON: Record<Download['status'], LucideIcon> = {
  running: Play,
  queued: Clock,
  paused: Pause,
  done: Check,
  error: TriangleAlert,
  canceled: X,
}
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, fmtBytes, fmtMissing, fmtSpeed, mediaTitle, type Download, type Watch } from '../api'
import { useConfirm } from '../components/confirm'
import { useAuth } from '../hooks'

// history-only status filter: the active queue is short and searchable, its
// three states never need chips
const HISTORY_STATUSES: Download['status'][] = ['done', 'error', 'canceled']

export default function Dashboard() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: downloads = [] } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })
  // active queue and history filter independently: searching the queue must
  // not reshuffle the history and vice versa
  const [query, setQuery] = useState('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [statusFilter, setStatusFilter] = useState<Set<Download['status']>>(new Set())
  const filtering = query.trim() !== ''
  const historyFiltering = historyQuery.trim() !== '' || statusFilter.size > 0
  const nameMatch = (d: Download, q: string) => q.trim() === '' || d.remotePath.toLowerCase().includes(q.trim().toLowerCase())

  const active = downloads.filter(
    (d) => (d.status === 'running' || d.status === 'queued' || d.status === 'paused') && nameMatch(d, query),
  )
  // section visibility keys off the unfiltered set: a filter with zero hits
  // must not hide the section (and with it the very chips to undo the filter)
  const finishedAll = downloads.filter((d) => d.status !== 'running' && d.status !== 'queued' && d.status !== 'paused')
  const finished = finishedAll.filter(
    (d) => (statusFilter.size === 0 || statusFilter.has(d.status)) && nameMatch(d, historyQuery),
  )
  const finishedShown = finished.slice(0, historyFiltering || showAllHistory ? finished.length : 20)
  const totalSpeed = downloads.reduce((s, d) => s + (d.status === 'running' ? (d.bytesPerSec ?? 0) : 0), 0)
  const anyActive = downloads.some((d) => d.status === 'running' || d.status === 'queued')
  const anyPaused = downloads.some((d) => d.status === 'paused')

  // multi-select: checkbox click toggles, shift-click selects the range in
  // display order, Escape clears
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const lastClick = useRef<number | null>(null)
  const visibleIds = [...active, ...finishedShown].map((d) => d.id)
  // per-section select-all; history spans every matching download (not just
  // the rendered slice) so bulk actions reach the full history
  const activeIds = active.map((d) => d.id)
  const historyIds = finished.map((d) => d.id)
  const selectRow = (id: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (shift && lastClick.current !== null) {
        const a = visibleIds.indexOf(lastClick.current)
        const b = visibleIds.indexOf(id)
        if (a !== -1 && b !== -1) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(visibleIds[i])
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastClick.current = id
  }
  // per-section slices of the shared selection, so each section shows its own
  // toolbar with only the actions that make sense there
  const activeSelected = activeIds.filter((id) => selected.has(id))
  const historySelected = historyIds.filter((id) => selected.has(id))
  const allActiveSelected = activeIds.length > 0 && activeIds.every((id) => selected.has(id))
  const allHistorySelected = historyIds.length > 0 && historyIds.every((id) => selected.has(id))
  // native indeterminate state for the select-all boxes on partial selection
  const activeAllRef = useRef<HTMLInputElement>(null)
  const historyAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (activeAllRef.current)
      activeAllRef.current.indeterminate = activeIds.some((id) => selected.has(id)) && !allActiveSelected
    if (historyAllRef.current)
      historyAllRef.current.indeterminate = historyIds.some((id) => selected.has(id)) && !allHistorySelected
  })
  // toggling a section's select-all only touches that section's ids
  const toggleSection = (ids: number[], all: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)))
      return next
    })
  const [historyOpen, setHistoryOpen] = useState(true)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: string }) =>
      verb === 'delete' ? api.del(`/api/downloads/${id}`) : api.post(`/api/downloads/${id}/${verb}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })
  const bulk = useMutation({
    mutationFn: ({ a, ids }: { a: 'pause' | 'resume' | 'cancel' | 'delete'; ids?: number[] }) =>
      api.post('/api/downloads/bulk', { action: a, ids: ids ?? [] }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['downloads'] })
      setSelected(new Set())
    },
  })
  const toggleStatus = (st: Download['status']) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(st)) next.delete(st)
      else next.add(st)
      return next
    })
  }

  return (
    <div>
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('dash.title')}</h2>
        <span className="t-label mt-1">{t('dash.sub')}</span>
      </header>

      {/* phones stack status overview on top; from lg it becomes the right
          column next to the transfer queue */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <aside className="flex flex-col gap-4 lg:order-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
            <StatTile label={t('dash.active')} value={String(active.filter((d) => d.status === 'running').length)} />
            <StatTile label={t('dash.queue')} value={String(active.filter((d) => d.status === 'queued').length)} />
            <StatTile label={t('dash.speed')} value={fmtSpeed(totalSpeed)} wide>
              <SpeedSparkline current={totalSpeed} />
            </StatTile>
          </div>
          <SyncSummary />
        </aside>

        <div className="min-w-0 lg:order-1">
          <section aria-label={t('dash.activeSection')}>
            <div className="mb-3 flex items-center gap-2">
              <span className="t-label t-label--accent">
                <DownloadIcon aria-hidden size="1em" />
                {t('dash.activeSection')}
              </span>
              <span className="h-px flex-1 bg-border-subtle" />
              <span className="font-mono text-[11px] text-t-muted">{active.length}</span>
            </div>

            <div className="t-toolbar mb-3">
              <input
                ref={activeAllRef}
                type="checkbox"
                title={t('dash.selectAll')}
                aria-label={t('dash.selectAll')}
                checked={allActiveSelected}
                onChange={() => toggleSection(activeIds, allActiveSelected)}
              />
              <input
                className="t-input font-mono text-xs sm:max-w-72"
                type="search"
                placeholder={t('dash.search')}
                aria-label={t('dash.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span className="t-toolbar ml-auto">
                {anyActive && (
                  <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause' })}>
                    <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.pauseAll')}
                  </button>
                )}
                {anyPaused && (
                  <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume' })}>
                    <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.resumeAll')}
                  </button>
                )}
                {(anyActive || anyPaused) && (
                  <button
                    className="t-btn t-btn--sm t-btn--danger"
                    disabled={bulk.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('dash.cancelAllConfirm'), destructive: true })) bulk.mutate({ a: 'cancel' })
                    }}
                  >
                    <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.cancelAll')}
                  </button>
                )}
                {!!user?.isAdmin && <GlobalLimitInput />}
              </span>
            </div>

      {activeSelected.length > 0 && (
        <div className="t-panel mb-4 flex flex-wrap items-center gap-2 p-3" role="toolbar" aria-label={t('dash.selectionActions')}>
          <span className="t-label t-label--accent">{t('dash.selectedCount', { count: activeSelected.length })}</span>
          <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause', ids: activeSelected })}>
            <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.pause')}
          </button>
          <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume', ids: activeSelected })}>
            <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.resume')}
          </button>
          <button
            className="t-btn t-btn--sm t-btn--danger"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ a: 'cancel', ids: activeSelected })}
          >
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.cancel')}
          </button>
          <button className="t-btn t-btn--sm ml-auto" onClick={() => toggleSection(activeIds, true)}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.clearSelection')}
          </button>
        </div>
      )}

            {active.length === 0 &&
              (filtering ? (
                <div className="t-panel p-8 text-center text-t-muted">{t('dash.noMatches')}</div>
              ) : (
                <div className="t-panel p-8 text-center text-t-muted">
                  <Trans i18nKey="dash.empty">
                    Keine aktiven Downloads. Zum Syncen in die <Link to="/remote" className="text-accent underline">Remote</Link>-Ansicht wechseln.
                  </Trans>
                </div>
              ))}
            <div className="flex flex-col gap-3">
              {active.map((d) => (
                <DownloadRow
                  key={d.id}
                  d={d}
                  selected={selected.has(d.id)}
                  onSelect={(shift) => selectRow(d.id, shift)}
                  onAction={(verb) => action.mutate({ id: d.id, verb })}
                />
              ))}
            </div>
          </section>

          {finishedAll.length > 0 && (
            <section aria-label={t('dash.finishedSection')} className="mt-8">
              {/* divider header doubles as the collapse toggle, like the
                  watch-list groups */}
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  className="t-label t-label--accent cursor-pointer"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  {historyOpen ? (
                    <ChevronDown aria-hidden size="1em" />
                  ) : (
                    <ChevronRight aria-hidden size="1em" />
                  )}
                  {t('dash.history')}
                </button>
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="font-mono text-[11px] text-t-muted">{finished.length}</span>
              </div>
              {historyOpen && (
                <>
                  <div className="t-toolbar mb-2">
                    <input
                      ref={historyAllRef}
                      type="checkbox"
                      title={t('dash.selectAll')}
                      aria-label={t('dash.selectAll')}
                      checked={allHistorySelected}
                      onChange={() => toggleSection(historyIds, allHistorySelected)}
                    />
                    <input
                      className="t-input font-mono text-xs sm:max-w-72"
                      type="search"
                      placeholder={t('dash.search')}
                      aria-label={t('dash.search')}
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                    />
                    <div role="group" aria-label={t('dash.filterStatus')} className="flex flex-wrap items-center gap-1">
                      {HISTORY_STATUSES.map((st) => {
                        const Icon = STATUS_ICON[st]
                        return (
                          <button
                            key={st}
                            aria-pressed={statusFilter.has(st)}
                            className={`t-label cursor-pointer ${statusFilter.has(st) ? 't-label--accent' : ''}`}
                            onClick={() => toggleStatus(st)}
                          >
                            <Icon aria-hidden size="1em" />
                            {t(`status.${st}`)}
                          </button>
                        )
                      })}
                      {historyFiltering && (
                        <button
                          className="t-label cursor-pointer hover:text-accent"
                          onClick={() => {
                            setHistoryQuery('')
                            setStatusFilter(new Set())
                          }}
                        >
                          <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                          {t('dash.filterClear')}
                        </button>
                      )}
                    </div>
                  </div>
                  {historySelected.length > 0 && (
                    <div
                      className="t-panel mb-2 flex flex-wrap items-center gap-2 p-3"
                      role="toolbar"
                      aria-label={t('dash.selectionActions')}
                    >
                      <span className="t-label t-label--accent">{t('dash.selectedCount', { count: historySelected.length })}</span>
                      <button
                        className="t-btn t-btn--sm"
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate({ a: 'resume', ids: historySelected })}
                      >
                        <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.retry')}
                      </button>
                      <button
                        className="t-btn t-btn--sm t-btn--danger"
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate({ a: 'delete', ids: historySelected })}
                      >
                        <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.removeSelected')}
                      </button>
                      <button className="t-btn t-btn--sm ml-auto" onClick={() => toggleSection(historyIds, true)}>
                        <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.clearSelection')}
                      </button>
                    </div>
                  )}
                  {finished.length === 0 && historyFiltering && (
                    <div className="t-panel p-6 text-center text-sm text-t-muted">{t('dash.noMatches')}</div>
                  )}
                  <div className="mt-2 flex flex-col gap-2">
                    {finishedShown.map((d) => (
              <div key={d.id} className="flex items-center gap-3 border border-border-subtle bg-bg-card px-3 py-2 text-sm">
                <SelectBox
                  checked={selected.has(d.id)}
                  name={d.remotePath.split('/').pop() ?? ''}
                  onSelect={(shift) => selectRow(d.id, shift)}
                />
                <StatusChip status={d.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-secondary" title={d.remotePath}>
                  {d.remotePath.split('/').pop()}
                </span>
                {d.error && <span className="max-w-64 truncate text-xs text-err" title={d.error}>{d.error}</span>}
                <span className="font-mono text-xs text-t-muted">{fmtBytes(d.size)}</span>
                {(d.status === 'error' || d.status === 'canceled') && (
                  <button className="t-btn t-btn--sm" onClick={() => action.mutate({ id: d.id, verb: 'resume' })}>
                    <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.retry')}
                  </button>
                )}
                <button
                  className="t-btn t-btn--sm t-btn--danger"
                  aria-label={t('dash.remove', { id: d.id })}
                  onClick={() => action.mutate({ id: d.id, verb: 'delete' })}
                >
                  <X aria-hidden size="1.2em" />
                </button>
                      </div>
                    ))}
                  </div>
                  {finished.length > finishedShown.length && (
                    <button className="t-btn t-btn--sm mt-3" onClick={() => setShowAllHistory(true)}>
                      {t('dash.showAllHistory', { count: finished.length })}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// Compact auto-sync overview on the dashboard: status counters + only the
// watches that need attention (behind, waiting, or blocked on a dub/sub).
function SyncSummary() {
  const { t } = useTranslation()
  const { data: watches = [] } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    refetchInterval: 30_000,
  })
  if (watches.length === 0) return null

  const waiting = watches.filter((w) => w.waiting).length
  const complete = watches.filter((w) => w.complete).length
  const behind = watches.reduce((s, w) => s + (w.behind ?? 0), 0)
  const title = (w: Watch) => w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')
  const airFmt = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  // "interesting" = actionable: behind, waiting for an airing, dub/sub-gated, or a gap
  const interesting = watches.filter(
    (w) => (w.behind ?? 0) > 0 || w.waiting || (w.langWaiting ?? 0) > 0 || (w.missing?.length ?? 0) > 0,
  )

  return (
    <section aria-label={t('dash.syncSummary')}>
      <div className="t-panel p-4">
        {/* same divider anatomy as the section headers on the left, so the
            chip never has to share its row with the counters (it used to
            wrap onto two lines in the narrow column) */}
        <div className="mb-2 flex items-center gap-2">
          <span className="t-label t-label--accent whitespace-nowrap">
            <RefreshCw aria-hidden size="1em" />
            {t('dash.syncSummary')}
          </span>
          <span className="h-px flex-1 bg-border-subtle" />
          <Link to="/watches" className="whitespace-nowrap text-[11px] text-accent hover:underline">
            {t('dash.syncAll')} →
          </Link>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-t-muted">
          <span>{t('dash.syncWatched', { count: watches.length })}</span>
          {waiting > 0 && <span>{t('dash.syncWaiting', { count: waiting })}</span>}
          {complete > 0 && <span>{t('dash.syncComplete', { count: complete })}</span>}
          {behind > 0 && <span className="text-warn">{t('dash.syncBehind', { count: behind })}</span>}
        </div>
        {interesting.length === 0 ? (
          <p className="text-xs text-t-muted">{t('dash.syncAllGood')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle/50">
            {interesting.slice(0, 8).map((w) => (
              <li key={w.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-t-secondary" title={w.remotePath}>
                  {title(w)}
                </span>
                {/* compact chips: icon + count only, the sidebar column is too
                    narrow for the full sentences - they live in the tooltip */}
                {(w.behind ?? 0) > 0 && (
                  <span className="t-label t-label--warn shrink-0" title={t('watch.behind', { count: w.behind })}>
                    <Clock aria-hidden size="1em" />
                    {w.behind}
                  </span>
                )}
                {(w.missing?.length ?? 0) > 0 && (
                  <span
                    className="t-label t-label--err shrink-0"
                    title={`${t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) })} (${w.missing!.join(', ')})`}
                  >
                    <TriangleAlert aria-hidden size="1em" />
                    {w.missing!.length}
                  </span>
                )}
                {(w.langWaiting ?? 0) > 0 && (
                  <span
                    className="t-label t-label--warn shrink-0"
                    title={t('watch.langWaiting', {
                      count: w.langWaiting,
                      lang: [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/'),
                    })}
                  >
                    <Clock aria-hidden size="1em" />
                    {w.langWaiting}
                  </span>
                )}
                {w.waiting && w.nextAiringAt ? (
                  <span className="shrink-0 font-mono text-[11px] text-t-muted">{airFmt(w.nextAiringAt)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {interesting.length > 8 && (
          <p className="mt-2 text-[11px] text-t-muted">{t('dash.syncMore', { count: interesting.length - 8 })}</p>
        )}
      </div>
    </section>
  )
}

function StatTile({ label, value, wide, children }: { label: string; value: string; wide?: boolean; children?: React.ReactNode }) {
  return (
    <div className={`t-panel px-4 py-2 ${wide ? 'col-span-2 sm:min-w-44' : 'sm:min-w-20'}`}>
      <span className="t-label">{label}</span>
      <div className="flex items-end gap-2">
        <p className="font-mono text-lg text-t-primary">{value}</p>
        {children}
      </div>
    </div>
  )
}

// Single-series live sparkline (last 60 samples), accent stroke on the
// panel surface; the tile's number is the direct label.
function SpeedSparkline({ current }: { current: number }) {
  const { t } = useTranslation()
  const [hist, setHist] = useState<number[]>([])
  const latest = useRef(current)
  latest.current = current
  useEffect(() => {
    const timer = setInterval(() => {
      setHist((h) => [...h.slice(-59), latest.current])
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  const max = Math.max(...hist, 1)
  const w = 96
  const h = 24
  const points = hist.map((v, i) => `${(i / 59) * w},${h - (v / max) * (h - 2) - 1}`).join(' ')
  return (
    <svg width={w} height={h} className="mb-1 shrink-0" role="img" aria-label={t('dash.speedChart')}>
      {hist.length > 1 && (
        <polyline points={points} fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinejoin="round" />
      )}
    </svg>
  )
}

export function StatusChip({ status }: { status: Download['status'] }) {
  const { t } = useTranslation()
  const cls =
    status === 'done' ? 't-label--ok' : status === 'error' ? 't-label--err' : status === 'running' ? 't-label--accent' : status === 'paused' ? 't-label--warn' : ''
  const Icon = STATUS_ICON[status]
  return (
    <span className={`t-label ${cls}`}>
      <Icon aria-hidden size="1em" />
      {t(`status.${status}`)}
    </span>
  )
}

// Selection checkbox: click toggles, shift-click selects a range (handled by
// the parent), Space works natively via the checkbox semantics.
function SelectBox({ checked, name, onSelect }: { checked: boolean; name: string; onSelect: (shift: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <input
      type="checkbox"
      aria-label={t('dash.select', { name })}
      checked={checked}
      onClick={(e) => onSelect(e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onSelect(e.shiftKey)
        }
      }}
      onChange={() => {}}
    />
  )
}

function DownloadRow({
  d,
  selected,
  onSelect,
  onAction,
}: {
  d: Download
  selected: boolean
  onSelect: (shift: boolean) => void
  onAction: (verb: string) => void
}) {
  const { t } = useTranslation()
  const pct = d.size > 0 ? Math.min(100, (d.transferred / d.size) * 100) : 0
  const name = d.remotePath.split('/').pop() ?? d.remotePath
  return (
    <div className={`t-panel p-4 ${selected ? 'bg-bg-hover' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <SelectBox checked={selected} name={name} onSelect={onSelect} />
        <StatusChip status={d.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-t-primary" title={d.remotePath}>
          {name}
        </span>
        <span className="font-mono text-xs text-t-muted">
          {fmtBytes(d.transferred)} / {fmtBytes(d.size)}
        </span>
        {d.status === 'running' && d.bytesPerSec != null && (
          <span className="font-mono text-xs text-accent">{fmtSpeed(d.bytesPerSec)}</span>
        )}
      </div>
      <div
        className="h-2 w-full bg-bg-secondary"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('dash.progressOf', { name })}
      >
        <div
          className={`h-full bg-accent transition-[width] duration-500 ${d.status === 'running' ? 't-progress-running' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* single row from sm upwards: buttons keep their size, the limit
          control stays on the same line instead of wrapping below */}
      <div className="mt-2 flex flex-wrap items-center gap-2 sm:flex-nowrap">
        {d.status === 'running' || d.status === 'queued' ? (
          <button className="t-btn t-btn--sm shrink-0" onClick={() => onAction('pause')}>
            <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.pause')}
          </button>
        ) : (
          <button className="t-btn t-btn--sm shrink-0" onClick={() => onAction('resume')}>
            <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.resume')}
          </button>
        )}
        <button className="t-btn t-btn--sm t-btn--danger shrink-0" onClick={() => onAction('cancel')}>
          <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('dash.cancel')}
        </button>
        <RateLimitInput d={d} />
      </div>
    </div>
  )
}

const MIB = 1024 * 1024

// Rate limit input with a KiB/s | MiB/s unit picker; stores bytes/s.
// Single line by design (whitespace-nowrap).
function LimitInput({ label, bytes, onSave }: { label: string; bytes: number; onSave: (b: number) => Promise<void> }) {
  const { t } = useTranslation()
  const [unit, setUnit] = useState<'KiB' | 'MiB'>(bytes >= MIB && bytes % MIB === 0 ? 'MiB' : 'KiB')
  const [val, setVal] = useState<string | null>(null)
  const factor = unit === 'MiB' ? MIB : 1024
  const shown = val ?? (bytes > 0 ? String(bytes / factor) : '')
  const save = async () => {
    if (val === null) return
    const n = Number(val)
    if (Number.isNaN(n) || n < 0) return
    try {
      await onSave(Math.round(n * factor))
    } finally {
      setVal(null) // re-derive from server state either way
    }
  }
  return (
    <label className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-t-muted">
      {label}
      <input
        className="t-input w-24 py-1 font-mono text-xs"
        type="number"
        min={0}
        step="any"
        placeholder="∞"
        value={shown}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <span className="t-select-wrap shrink-0">
        <select
          className="t-select py-1 text-xs"
          aria-label={t('dash.limitUnit')}
          value={unit}
          onChange={(e) => setUnit(e.target.value as 'KiB' | 'MiB')}
        >
          <option value="KiB">KiB/s</option>
          <option value="MiB">MiB/s</option>
        </select>
      </span>
    </label>
  )
}

// Quick global rate limit (admin): reads the current value from the admin
// settings query, writes via the dedicated dashboard endpoint.
function GlobalLimitInput() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: settings } = useQuery<{ globalRateLimit: number }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  return (
    <LimitInput
      label={t('dash.globalLimit')}
      bytes={settings?.globalRateLimit ?? 0}
      onSave={async (b) => {
        await api.put('/api/downloads/ratelimit', { rateLimit: b })
        qc.invalidateQueries({ queryKey: ['settings'] })
      }}
    />
  )
}

function RateLimitInput({ d }: { d: Download }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  return (
    <LimitInput
      label={t('dash.limit')}
      bytes={d.rateLimit}
      onSave={async (b) => {
        await api.put(`/api/downloads/${d.id}/ratelimit`, { rateLimit: b })
        qc.invalidateQueries({ queryKey: ['downloads'] })
      }}
    />
  )
}
