import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, fmtBytes, fmtSpeed, type Download } from '../api'

export default function Dashboard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: downloads = [] } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })

  const active = downloads.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
  const finished = downloads.filter((d) => !active.includes(d))
  const totalSpeed = downloads.reduce((s, d) => s + (d.status === 'running' ? (d.bytesPerSec ?? 0) : 0), 0)

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: string }) =>
      verb === 'delete' ? api.del(`/api/downloads/${id}`) : api.post(`/api/downloads/${id}/${verb}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })

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

      <section aria-label={t('dash.activeSection')}>
        {active.length === 0 && (
          <div className="t-panel p-8 text-center text-t-muted">
            <Trans i18nKey="dash.empty">
              Keine aktiven Downloads. Ab in den <Link to="/browser" className="text-accent underline">Browser</Link> zum Syncen.
            </Trans>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {active.map((d) => (
            <DownloadRow key={d.id} d={d} onAction={(verb) => action.mutate({ id: d.id, verb })} />
          ))}
        </div>
      </section>

      {finished.length > 0 && (
        <section aria-label={t('dash.finishedSection')} className="mt-8">
          <span className="t-label mb-3">{t('dash.history')}</span>
          <div className="mt-2 flex flex-col gap-2">
            {finished.slice(0, 20).map((d) => (
              <div key={d.id} className="flex items-center gap-3 border border-border-subtle bg-bg-card px-3 py-2 text-sm">
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

function DownloadRow({ d, onAction }: { d: Download; onAction: (verb: string) => void }) {
  const { t } = useTranslation()
  const pct = d.size > 0 ? Math.min(100, (d.transferred / d.size) * 100) : 0
  const name = d.remotePath.split('/').pop() ?? d.remotePath
  return (
    <div className="t-panel p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
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
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {d.status === 'running' || d.status === 'queued' ? (
          <button className="t-btn t-btn--sm" onClick={() => onAction('pause')}>
            {t('dash.pause')}
          </button>
        ) : (
          <button className="t-btn t-btn--sm" onClick={() => onAction('resume')}>
            {t('dash.resume')}
          </button>
        )}
        <button className="t-btn t-btn--sm t-btn--danger" onClick={() => onAction('cancel')}>
          {t('dash.cancel')}
        </button>
        <RateLimitInput d={d} />
      </div>
    </div>
  )
}

function RateLimitInput({ d }: { d: Download }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [val, setVal] = useState(d.rateLimit > 0 ? String(d.rateLimit / 1024) : '')
  const save = async () => {
    const kib = Number(val)
    if (Number.isNaN(kib) || kib < 0) return
    await api.put(`/api/downloads/${d.id}/ratelimit`, { rateLimit: Math.round(kib * 1024) })
    qc.invalidateQueries({ queryKey: ['downloads'] })
  }
  return (
    <label className="ml-auto flex items-center gap-2 text-xs text-t-muted">
      {t('dash.limit')}
      <input
        className="t-input w-24 py-1 font-mono text-xs"
        type="number"
        min={0}
        placeholder="∞"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      KiB/s
    </label>
  )
}
