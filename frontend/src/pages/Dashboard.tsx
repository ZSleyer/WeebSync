import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, Clock, Download as DownloadIcon, FolderOpen, Pause, Play, RefreshCw, RotateCcw, Trash2, TriangleAlert, X, type LucideIcon } from 'lucide-react'

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
import { Link } from 'react-router'
import {
  Badge,
  Button,
  Count,
  Cover,
  Divider,
  EmptyState,
  Input,
  Panel,
  Select,
  Toolbar,
  type BadgeTone,
} from '@weebsync/design-system'
import { api, downloadLabel, fmtBytes, fmtMissing, fmtSpeed, mediaTitle, type Download, type DownloadMeta, type JobsStatus, type Watch } from '../api'
import { countdown } from '../countdown'
import { jobLabel } from '../jobs'
import { useConfirm } from '../components/confirm'
import { FsErrorNote, isFsErrorCode } from '../components/FsErrorNote'
import { useAuth } from '../hooks'
import { ProviderBadges } from './Suggestions'

// history-only status filter: the active queue is short and searchable, its
// three states never need chips
const HISTORY_STATUSES: Download['status'][] = ['done', 'error', 'canceled']

// isRetrying: the download failed on something transient and is waiting out its
// backoff. It stays 'queued' - the wait is what tells the two apart.
const isRetrying = (d: Download) => (d.retryAt ?? 0) * 1000 > Date.now()

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
  // series metadata lives behind its own key: the list above is patched in
  // place by the event stream (whole object per progress tick) and polled every
  // 5s, while a folder's cover and links change about never. The ['downloads']
  // prefix means every mutation below invalidates this too.
  const { data: meta } = useQuery<DownloadMeta>({
    queryKey: ['downloads', 'meta'],
    queryFn: () => api.get('/api/downloads/meta'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  // a download the metadata does not know is newer than the metadata. The
  // endpoint answers with an item for EVERY download, matched or not, so this
  // settles after one refetch instead of looping.
  useEffect(() => {
    if (meta && downloads.some((d) => !meta.items[String(d.id)])) {
      qc.invalidateQueries({ queryKey: ['downloads', 'meta'] })
    }
  }, [downloads, meta, qc])
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
  // 1s tick so the retry countdowns stay live, gated on there being one: an
  // ungated interval re-renders the whole queue every second for nothing
  const [, setTick] = useState(0)
  const anyRetrying = downloads.some((d) => isRetrying(d))
  useEffect(() => {
    if (!anyRetrying) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [anyRetrying])

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
        <Badge className="mt-1">{t('dash.sub')}</Badge>
      </header>

      <BackgroundWork />

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
            <Divider
              className="mb-3"
              label={
                <>
                  <DownloadIcon aria-hidden size="1em" />
                  {t('dash.activeSection')}
                </>
              }
              count={active.length}
            />

            <Toolbar className="mb-3">
              <input
                ref={activeAllRef}
                type="checkbox"
                title={t('dash.selectAll')}
                aria-label={t('dash.selectAll')}
                checked={allActiveSelected}
                onChange={() => toggleSection(activeIds, allActiveSelected)}
              />
              <Input
                className="font-mono text-xs sm:max-w-72"
                type="search"
                placeholder={t('dash.search')}
                aria-label={t('dash.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Toolbar className="ml-auto">
                {anyActive && (
                  <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause' })}>
                    <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.pauseAll')}
                  </Button>
                )}
                {anyPaused && (
                  <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume' })}>
                    <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.resumeAll')}
                  </Button>
                )}
                {(anyActive || anyPaused) && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={bulk.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('dash.cancelAllConfirm'), destructive: true })) bulk.mutate({ a: 'cancel' })
                    }}
                  >
                    <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('dash.cancelAll')}
                  </Button>
                )}
                {!!user?.isAdmin && <GlobalLimitInput />}
              </Toolbar>
            </Toolbar>

      {activeSelected.length > 0 && (
        <Panel className="mb-4 flex flex-wrap items-center gap-2 p-3" role="toolbar" aria-label={t('dash.selectionActions')}>
          <Badge tone="accent">{t('dash.selectedCount', { count: activeSelected.length })}</Badge>
          <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause', ids: activeSelected })}>
            <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.pause')}
          </Button>
          <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume', ids: activeSelected })}>
            <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.resume')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ a: 'cancel', ids: activeSelected })}
          >
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.cancel')}
          </Button>
          <Button size="sm" className="ml-auto" onClick={() => toggleSection(activeIds, true)}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.clearSelection')}
          </Button>
        </Panel>
      )}

            {active.length === 0 &&
              (filtering ? (
                <EmptyState>{t('dash.noMatches')}</EmptyState>
              ) : (
                <EmptyState>
                  <Trans i18nKey="dash.empty">
                    Keine aktiven Downloads. Zum Syncen in die <Link to="/remote" className="text-accent underline">Remote</Link>-Ansicht wechseln.
                  </Trans>
                </EmptyState>
              ))}
            <div className="flex flex-col gap-3">
              {active.map((d) => (
                <DownloadRow
                  key={d.id}
                  d={d}
                  meta={meta}
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
                  watch-list groups - hand-rolled because <Divider> always
                  renders its label as a non-interactive chip */}
              <div className="t-divider mb-3">
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
                <span className="t-divider-rule" />
                <Count>{finished.length}</Count>
              </div>
              {historyOpen && (
                <>
                  <Toolbar className="mb-2">
                    <input
                      ref={historyAllRef}
                      type="checkbox"
                      title={t('dash.selectAll')}
                      aria-label={t('dash.selectAll')}
                      checked={allHistorySelected}
                      onChange={() => toggleSection(historyIds, allHistorySelected)}
                    />
                    <Input
                      className="font-mono text-xs sm:max-w-72"
                      type="search"
                      placeholder={t('dash.search')}
                      aria-label={t('dash.search')}
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                    />
                    {/* toggle chips: <Badge> renders a span, these have to stay
                        buttons with aria-pressed - kept hand-written */}
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
                  </Toolbar>
                  {historySelected.length > 0 && (
                    <Panel
                      className="mb-2 flex flex-wrap items-center gap-2 p-3"
                      role="toolbar"
                      aria-label={t('dash.selectionActions')}
                    >
                      <Badge tone="accent">{t('dash.selectedCount', { count: historySelected.length })}</Badge>
                      <Button
                        size="sm"
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate({ a: 'resume', ids: historySelected })}
                      >
                        <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.retry')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate({ a: 'delete', ids: historySelected })}
                      >
                        <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.removeSelected')}
                      </Button>
                      <Button size="sm" className="ml-auto" onClick={() => toggleSection(historyIds, true)}>
                        <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('dash.clearSelection')}
                      </Button>
                    </Panel>
                  )}
                  {/* not <EmptyState>: this one is the compact p-6/text-sm
                      variant, and its padding must not be overridden */}
                  {finished.length === 0 && historyFiltering && (
                    <Panel className="p-6 text-center text-sm text-t-muted">{t('dash.noMatches')}</Panel>
                  )}
                  <div className="mt-2 flex flex-col gap-2">
                    {(() => {
                      // One unwritable directory fails every episode of a
                      // season, so the same explanation would repeat down the
                      // whole list - hundreds of pixels saying one thing. Spell
                      // a cause out on its first row and let the rest keep the
                      // short error text they had before.
                      const explained = new Set<string>()
                      return finishedShown.map((d) => {
                        const key = `${d.errorCode} ${dirOf(d.localPath)}`
                        const first = isFsErrorCode(d.errorCode) && !explained.has(key)
                        if (first) explained.add(key)
                        return (
                          <HistoryRow
                            key={d.id}
                            d={d}
                            meta={meta}
                            explain={first}
                            selected={selected.has(d.id)}
                            onSelect={(shift) => selectRow(d.id, shift)}
                            onAction={(verb) => action.mutate({ id: d.id, verb })}
                          />
                        )
                      })
                    })()}
                  </div>
                  {finished.length > finishedShown.length && (
                    <Button size="sm" className="mt-3" onClick={() => setShowAllHistory(true)}>
                      {t('dash.showAllHistory', { count: finished.length })}
                    </Button>
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
      <Panel className="p-4">
        {/* same divider anatomy as the section headers on the left, so the
            chip never has to share its row with the counters (it used to
            wrap onto two lines in the narrow column). nowrap sits on the
            divider and is inherited - the chip itself takes no class */}
        <Divider
          className="mb-2 whitespace-nowrap"
          label={
            <>
              <RefreshCw aria-hidden size="1em" />
              {t('dash.syncSummary')}
            </>
          }
          trailing={
            /* inline-flex + min-h keeps the 24px target size (WCAG 2.5.8) */
            <Link
              to="/watches"
              className="inline-flex min-h-6 items-center whitespace-nowrap text-[11px] text-accent hover:underline"
            >
              {t('dash.syncAll')} →
            </Link>
          }
        />
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
                  <Badge tone="warn" className="shrink-0" title={t('watch.behind', { count: w.behind })}>
                    <Clock aria-hidden size="1em" />
                    {w.behind}
                  </Badge>
                )}
                {(w.missing?.length ?? 0) > 0 && (
                  <Badge
                    tone="err"
                    className="shrink-0"
                    title={`${t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) })} (${w.missing!.join(', ')})`}
                  >
                    <TriangleAlert aria-hidden size="1em" />
                    {w.missing!.length}
                  </Badge>
                )}
                {(w.langWaiting ?? 0) > 0 && (
                  <Badge
                    tone="warn"
                    className="shrink-0"
                    title={t('watch.langWaiting', {
                      count: w.langWaiting,
                      lang: [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/'),
                    })}
                  >
                    <Clock aria-hidden size="1em" />
                    {w.langWaiting}
                  </Badge>
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
      </Panel>
    </section>
  )
}

function StatTile({ label, value, wide, children }: { label: string; value: string; wide?: boolean; children?: React.ReactNode }) {
  return (
    <Panel className={`px-4 py-2 ${wide ? 'col-span-2 sm:min-w-44' : 'sm:min-w-20'}`}>
      <Badge>{label}</Badge>
      <div className="flex items-end gap-2">
        <p className="font-mono text-lg text-t-primary">{value}</p>
        {children}
      </div>
    </Panel>
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

// BackgroundWork says what the machine is busy with. Indexing a Plex library
// or crawling a server is felt on a home server, and until now nothing on
// screen connected the fan noise to the app. Admins get the link to where it
// can be held; everyone else at least knows why things are slow.
function BackgroundWork() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const { data } = useQuery<JobsStatus>({
    queryKey: ['jobs', 'status'],
    queryFn: () => api.get('/api/jobs'),
    refetchInterval: 10_000,
  })
  const running = data?.running ?? []
  const paused = data?.paused ?? []
  if (running.length === 0 && paused.length === 0) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 border border-border-subtle bg-bg-card px-3 py-2 text-xs">
      {running.length > 0 && (
        <Badge tone="accent">
          <RefreshCw aria-hidden size="1em" />
          {running.length === 1 ? t('jobs.busyOne', { name: jobLabel(t, running[0]) }) : t('jobs.busy')}
        </Badge>
      )}
      {running.length > 1 && running.map((f) => <Badge key={f}>{jobLabel(t, f)}</Badge>)}
      {paused.map((f) => (
        <Badge key={f} tone="warn">
          {jobLabel(t, f)} · {t('jobs.paused')}
        </Badge>
      ))}
      {user?.isAdmin && (
        <Link to="/settings/jobs" className="text-accent underline">
          {t('settings.nav.jobs')}
        </Link>
      )}
    </div>
  )
}

export function StatusChip({ status }: { status: Download['status'] }) {
  const { t } = useTranslation()
  const tone: BadgeTone =
    status === 'done' ? 'ok' : status === 'error' ? 'err' : status === 'running' ? 'accent' : status === 'paused' ? 'warn' : 'neutral'
  const Icon = STATUS_ICON[status]
  return (
    <Badge tone={tone}>
      <Icon aria-hidden size="1em" />
      {t(`status.${status}`)}
    </Badge>
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

// dirOf is the folder a path lives in, for the browser deep links.
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

// DetailsToggle is the chevron that opens a download's metadata. Not
// <Collapsible>: that renders a section heading with a count badge, and these
// are rows.
function DetailsToggle({ open, name, onToggle }: { open: boolean; name: string; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t('dash.details', { name })}
      className="t-label min-h-6 min-w-6 cursor-pointer justify-center hover:text-accent"
      onClick={onToggle}
    >
      {open ? <ChevronDown aria-hidden size="1em" /> : <ChevronRight aria-hidden size="1em" />}
    </button>
  )
}

// DownloadDetails is the expanded half of a queue or history row: what the file
// becomes, where it comes from, where it lands, and the pages that describe it.
// Shared by both row types so they cannot drift apart.
function DownloadDetails({ d, meta }: { d: Download; meta?: DownloadMeta }) {
  const { t } = useTranslation()
  const { group } = downloadLabel(d, meta)
  const remoteDir = dirOf(d.remotePath)
  const localDir = dirOf(d.localPath)
  const remoteBase = d.remotePath.split('/').pop() ?? ''
  const localBase = d.localPath.split('/').pop() ?? ''
  const showFolder = group?.folder ?? remoteDir
  const remoteLink = (path: string) => `/remote?server=${d.serverId}&path=${encodeURIComponent(path)}`
  return (
    <dl className="mt-3 grid gap-x-4 gap-y-2 border-t border-border-subtle pt-3 text-xs sm:grid-cols-[max-content_1fr]">
      {group?.overview && (
        <>
          <dt className="t-label">{t('dash.overview')}</dt>
          <dd className="line-clamp-4 text-t-secondary">{group.overview}</dd>
        </>
      )}
      <dt className="t-label">{t('dash.renamedTo')}</dt>
      <dd className="min-w-0 break-all font-mono text-t-secondary">
        {remoteBase === localBase ? (
          t('dash.noRename')
        ) : (
          <>
            {remoteBase} <ArrowRight aria-hidden size="1em" className="inline align-[-0.125em] text-accent" /> {localBase}
          </>
        )}
      </dd>
      <dt className="t-label">{t('dash.source')}</dt>
      <dd className="min-w-0 break-all">
        {group?.serverName && <span className="mr-2 text-t-muted">{group.serverName}</span>}
        <Link to={remoteLink(remoteDir)} className="font-mono text-accent underline">
          {remoteDir}
        </Link>
      </dd>
      <dt className="t-label">{t('dash.target')}</dt>
      <dd className="min-w-0 break-all">
        <Link to={`/local?path=${encodeURIComponent(localDir)}`} className="font-mono text-accent underline">
          {localDir}
        </Link>
      </dd>
      <dt className="t-label">{t('dash.linksLabel')}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <Link to={remoteLink(showFolder)} className="t-label hover:text-accent">
          <FolderOpen aria-hidden size="1em" />
          {t('dash.openShow')}
        </Link>
        {group?.providers && group.providers.length > 0 && (
          <ProviderBadges providers={group.providers} links={group.links} />
        )}
      </dd>
    </dl>
  )
}

function DownloadRow({
  d,
  meta,
  selected,
  onSelect,
  onAction,
}: {
  d: Download
  meta?: DownloadMeta
  selected: boolean
  onSelect: (shift: boolean) => void
  onAction: (verb: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const pct = d.size > 0 ? Math.min(100, (d.transferred / d.size) * 100) : 0
  const { label, ep, name, group } = downloadLabel(d, meta)
  return (
    <Panel className={`p-4 ${selected ? 'bg-bg-hover' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <SelectBox checked={selected} name={name} onSelect={onSelect} />
        {/* only a real poster earns the slot; the hatched placeholder on every
            unmatched row would be noise */}
        {group?.cover && <Cover src={group.cover} size="sm" loading="lazy" />}
        {/* a waiting retry is still 'queued', and "queued" alone would hide
            that this download already failed once. The countdown replaces the
            status chip rather than joining it: two chips saying when this row
            will run is one too many for a phone line. */}
        {isRetrying(d) ? (
          <Badge tone="warn">
            <RefreshCw aria-hidden size="1em" />
            {t('dash.retryIn', { n: d.attempts ?? 1, when: countdown(t, d.retryAt!, true) })}
          </Badge>
        ) : (
          <StatusChip status={d.status} />
        )}
        {ep && <Badge tone="accent">{ep}</Badge>}
        {/* own line on a phone: cover, status chip and episode badge leave the
            title a few characters otherwise */}
        <span className="min-w-0 basis-full truncate text-sm text-t-primary sm:flex-1 sm:basis-auto" title={d.remotePath}>
          {label}
          {label !== name && <span className="block truncate font-mono text-xs text-t-muted">{name}</span>}
        </span>
        <span className="font-mono text-xs text-t-muted">
          {fmtBytes(d.transferred)} / {fmtBytes(d.size)}
        </span>
        {d.status === 'running' && d.bytesPerSec != null && (
          <span className="font-mono text-xs text-accent">{fmtSpeed(d.bytesPerSec)}</span>
        )}
        {/* why it is waiting, in the row's own words - a countdown without a
            reason is an unexplained pause */}
        {isRetrying(d) && d.error && (
          <span className="max-w-64 truncate text-xs text-err" title={d.error}>
            {d.error}
          </span>
        )}
        <DetailsToggle open={open} name={name} onToggle={() => setOpen((o) => !o)} />
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
      {open && <DownloadDetails d={d} meta={meta} />}
      {/* one row at every width. On a phone the buttons drop their captions and
          keep the icon, which is what leaves the limit control room to stay on
          the line instead of claiming one of its own */}
      <div className="mt-2 flex flex-nowrap items-center gap-2">
        {d.status === 'running' || d.status === 'queued' ? (
          <Button size="sm" className="shrink-0" aria-label={t('dash.pause')} onClick={() => onAction('pause')}>
            <Pause aria-hidden size="1em" className="inline align-[-0.125em] sm:mr-1" />
            <span className="hidden sm:inline">{t('dash.pause')}</span>
          </Button>
        ) : (
          <Button size="sm" className="shrink-0" aria-label={t('dash.resume')} onClick={() => onAction('resume')}>
            <Play aria-hidden size="1em" className="inline align-[-0.125em] sm:mr-1" />
            <span className="hidden sm:inline">{t('dash.resume')}</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          className="shrink-0"
          aria-label={t('dash.cancel')}
          onClick={() => onAction('cancel')}
        >
          <X aria-hidden size="1em" className="inline align-[-0.125em] sm:mr-1" />
          <span className="hidden sm:inline">{t('dash.cancel')}</span>
        </Button>
        <RateLimitInput d={d} />
      </div>
    </Panel>
  )
}

// HistoryRow is a finished download: one compact line, expandable to the same
// details as a queue row. Worth expanding here too - the file exists now, so the
// link into the local browser actually leads somewhere.
function HistoryRow({
  d,
  meta,
  explain,
  selected,
  onSelect,
  onAction,
}: {
  d: Download
  meta?: DownloadMeta
  // spell this row's failure out in full: set on the first row of each cause,
  // so one unwritable directory is explained once and not once per episode
  explain: boolean
  selected: boolean
  onSelect: (shift: boolean) => void
  onAction: (verb: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { label, ep, name, group } = downloadLabel(d, meta)
  const explained = explain && isFsErrorCode(d.errorCode)
  return (
    <div className="border border-border-subtle bg-bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <SelectBox checked={selected} name={name} onSelect={onSelect} />
        {group?.cover && <Cover src={group.cover} size="sm" loading="lazy" />}
        <StatusChip status={d.status} />
        {ep && <Badge tone="accent">{ep}</Badge>}
        {/* own line on a phone, same reason as the queue row */}
        <span className="min-w-0 basis-full truncate text-xs text-t-secondary sm:flex-1 sm:basis-auto" title={d.remotePath}>
          {label}
        </span>
        {/* an explained failure gets its own full-width row below; only an
            unclassified one still has to make do with a truncated string */}
        {d.error && !explained && <span className="max-w-64 truncate text-xs text-err" title={d.error}>{d.error}</span>}
        <span className="font-mono text-xs text-t-muted">{fmtBytes(d.size)}</span>
        {(d.status === 'error' || d.status === 'canceled') && (
          <Button size="sm" onClick={() => onAction('resume')}>
            <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('dash.retry')}
          </Button>
        )}
        <Button size="sm" variant="danger" aria-label={t('dash.remove', { id: d.id })} onClick={() => onAction('delete')}>
          <X aria-hidden size="1.2em" />
        </Button>
        <DetailsToggle open={open} name={name} onToggle={() => setOpen((o) => !o)} />
      </div>
      {explained && <FsErrorNote code={d.errorCode!} dir={dirOf(d.localPath)} className="mt-2" />}
      {open && <DownloadDetails d={d} meta={meta} />}
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
    // one line at every width: three stacked rows for a control nobody sets
    // twice is a lot of phone screen. The caption goes screen-reader-only on a
    // phone rather than away, so the field keeps its accessible name
    <label className="ml-auto flex min-w-0 flex-nowrap items-center gap-2 text-xs text-t-muted">
      <span className="sr-only shrink-0 sm:not-sr-only">{label}</span>
      {/* the width needs the bang: .t-input sets width:100% unlayered, which
          beats a plain w-14 utility and lets the field eat the whole row */}
      <Input
        size="sm"
        className="w-14! shrink-0 font-mono sm:w-24!"
        type="number"
        min={0}
        step="any"
        placeholder="∞"
        value={shown}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <Select
        size="sm"
        wrapperClassName="shrink-0"
        aria-label={t('dash.limitUnit')}
        value={unit}
        onChange={(e) => setUnit(e.target.value as 'KiB' | 'MiB')}
      >
        <option value="KiB">KiB/s</option>
        <option value="MiB">MiB/s</option>
      </Select>
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
