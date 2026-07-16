import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, fmtBytes, fmtSpeed, type Download } from '../api'
import { useAuth } from '../hooks'

const STATUSES: Download['status'][] = ['running', 'queued', 'paused', 'done', 'error', 'canceled']

export default function Dashboard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: downloads = [] } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<Set<Download['status']>>(new Set())
  const filtering = query.trim() !== '' || statusFilter.size > 0
  const matches = (d: Download) =>
    (statusFilter.size === 0 || statusFilter.has(d.status)) &&
    (query.trim() === '' || d.remotePath.toLowerCase().includes(query.trim().toLowerCase()))

  const active = downloads.filter((d) => (d.status === 'running' || d.status === 'queued' || d.status === 'paused') && matches(d))
  const finished = downloads.filter((d) => d.status !== 'running' && d.status !== 'queued' && d.status !== 'paused' && matches(d))
  const finishedShown = finished.slice(0, filtering ? finished.length : 20)
  const totalSpeed = downloads.reduce((s, d) => s + (d.status === 'running' ? (d.bytesPerSec ?? 0) : 0), 0)
  const anyActive = downloads.some((d) => d.status === 'running' || d.status === 'queued')
  const anyPaused = downloads.some((d) => d.status === 'paused')

  // multi-select: checkbox click toggles, shift-click selects the range in
  // display order, Escape clears
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const lastClick = useRef<number | null>(null)
  const visibleIds = [...active, ...finishedShown].map((d) => d.id)
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
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
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
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('dash.title')}</h2>
          <span className="t-label mt-1">{t('dash.sub')}</span>
        </div>
        <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
          <StatTile label={t('dash.active')} value={String(active.filter((d) => d.status === 'running').length)} />
          <StatTile label={t('dash.queue')} value={String(active.filter((d) => d.status === 'queued').length)} />
          <StatTile label={t('dash.speed')} value={fmtSpeed(totalSpeed)} wide>
            <SpeedSparkline current={totalSpeed} />
          </StatTile>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(anyActive || anyPaused) && (
          <>
            {anyActive && (
              <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause' })}>
                {t('dash.pauseAll')}
              </button>
            )}
            {anyPaused && (
              <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume' })}>
                {t('dash.resumeAll')}
              </button>
            )}
            <button
              className="t-btn t-btn--sm t-btn--danger"
              disabled={bulk.isPending}
              onClick={() => {
                if (confirm(t('dash.cancelAllConfirm'))) bulk.mutate({ a: 'cancel' })
              }}
            >
              {t('dash.cancelAll')}
            </button>
          </>
        )}
        {!!user?.isAdmin && <GlobalLimitInput />}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="t-input w-full py-1.5 font-mono text-xs sm:w-56"
          type="search"
          placeholder={t('dash.search')}
          aria-label={t('dash.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div role="group" aria-label={t('dash.filterStatus')} className="flex flex-wrap items-center gap-1">
          <input
            type="checkbox"
            className="mr-1"
            title={t('dash.selectAll')}
            aria-label={t('dash.selectAll')}
            checked={allVisibleSelected}
            onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleIds))}
          />
          {STATUSES.map((st) => (
            <button
              key={st}
              aria-pressed={statusFilter.has(st)}
              className={`t-label min-h-6 cursor-pointer ${statusFilter.has(st) ? 't-label--accent' : ''}`}
              onClick={() => toggleStatus(st)}
            >
              {t(`status.${st}`)}
            </button>
          ))}
          {filtering && (
            <button
              className="t-label min-h-6 cursor-pointer hover:text-accent"
              onClick={() => {
                setQuery('')
                setStatusFilter(new Set())
              }}
            >
              ✕ {t('dash.filterClear')}
            </button>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="t-panel mb-4 flex flex-wrap items-center gap-2 p-3" role="toolbar" aria-label={t('dash.selectionActions')}>
          <span className="t-label t-label--accent">{t('dash.selectedCount', { count: selected.size })}</span>
          <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause', ids: [...selected] })}>
            {t('dash.pause')}
          </button>
          <button className="t-btn t-btn--sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume', ids: [...selected] })}>
            {t('dash.resume')}
          </button>
          <button
            className="t-btn t-btn--sm t-btn--danger"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ a: 'cancel', ids: [...selected] })}
          >
            {t('dash.cancel')}
          </button>
          <button
            className="t-btn t-btn--sm t-btn--danger"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ a: 'delete', ids: [...selected] })}
          >
            {t('dash.removeSelected')}
          </button>
          <button className="t-btn t-btn--sm ml-auto" onClick={() => setSelected(new Set())}>
            ✕ {t('dash.clearSelection')}
          </button>
        </div>
      )}

      <section aria-label={t('dash.activeSection')}>
        {active.length === 0 &&
          (filtering ? (
            <div className="t-panel p-8 text-center text-t-muted">{t('dash.noMatches')}</div>
          ) : (
            <div className="t-panel p-8 text-center text-t-muted">
              <Trans i18nKey="dash.empty">
                Keine aktiven Downloads. Ab in den <Link to="/browser" className="text-accent underline">Browser</Link> zum Syncen.
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

      {finished.length > 0 && (
        <section aria-label={t('dash.finishedSection')} className="mt-8">
          <span className="t-label mb-3">{t('dash.history')}</span>
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
                    {t('dash.retry')}
                  </button>
                )}
                <button
                  className="t-btn t-btn--sm t-btn--danger"
                  aria-label={t('dash.remove', { id: d.id })}
                  onClick={() => action.mutate({ id: d.id, verb: 'delete' })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
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
  return <span className={`t-label ${cls}`}>{t(`status.${status}`)}</span>
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
            {t('dash.pause')}
          </button>
        ) : (
          <button className="t-btn t-btn--sm shrink-0" onClick={() => onAction('resume')}>
            {t('dash.resume')}
          </button>
        )}
        <button className="t-btn t-btn--sm t-btn--danger shrink-0" onClick={() => onAction('cancel')}>
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
