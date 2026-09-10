import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CalendarDays, Check, ChevronDown, ChevronRight, Clock, Download as DownloadIcon, Eye, FolderOpen, Pause, Play, RefreshCw, RotateCcw, Trash2, TriangleAlert, X, type LucideIcon } from 'lucide-react'

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
  ActionBar,
  Badge,
  Button,
  CalendarEntry,
  Count,
  Cover,
  Divider,
  EmptyState,
  Input,
  Panel,
  Progress,
  Select,
  Skeleton,
  Sparkline,
  StatTile,
  Toolbar,
  TransferCard,
  useMediaQuery,
  type BadgeTone,
} from '@weebsync/design-system'
import { api, downloadLabel, fmtBytes, fmtMissing, fmtSpeed, mediaTitle, type Download, type DownloadMeta, type JobsStatus, type SystemStatus, type Watch } from '../api'
import { upcomingAirings } from '../airings'
import { avgSpeed, useSpeedHistory } from '../speedHistory'
import { countdown } from '../countdown'
import { jobLabel } from '../jobs'
import { useConfirm } from '../components/confirm'
import PageActions, { PageFooter, WIDE_MQ } from '../components/PageActions'
import { FsErrorNote, isFsErrorCode } from '../components/FsErrorNote'
import { useAuth, usePersistedQuery } from '../hooks'
import { ProviderBadges } from '../components/ProviderBadges'

// history-only status filter: the active queue is short and searchable, its
// three states never need chips
const HISTORY_STATUSES: Download['status'][] = ['done', 'error', 'canceled']

// isRetrying: the download failed on something transient and is waiting out its
// backoff. It stays 'queued' - the wait is what tells the two apart.
const isRetrying = (d: Download) => (d.retryAt ?? 0) * 1000 > Date.now()
// remaining puts a duration into the countdown's words. Under a minute it
// counts seconds - "in 0 min" is what the last stretch of every download
// read otherwise - and a duration already spent is no time at all.
const remaining = (t: Parameters<typeof countdown>[0], secs: number) => (secs > 0 ? countdown(t, Date.now() / 1000 + secs, secs < 60) : null)

export default function Dashboard() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: downloads = [], isLoading } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })
  // the series behind a download, for the hero's line about it: the watch
  // list is what knows the year, the studio and the score. Persisted, so a
  // return to the page never waits on it.
  const { data: watches = [], isLoading: watchesLoading } = usePersistedQuery<Watch[]>('watches', () => api.get('/api/watches'), {
    refetchInterval: () => 30_000,
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

  const activeAll = downloads.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
  const matched = activeAll.filter((d) => nameMatch(d, query))
  // the transfer in progress leads the queue as the hero card, ahead of the
  // list's newest-first order; while nothing runs, the first one waiting
  // takes its place
  const hero = matched.find((d) => d.status === 'running') ?? matched[0]
  const rank = (d: Download) => (d === hero ? 0 : d.status === 'running' ? 1 : d.status === 'paused' ? 2 : 3)
  const active = [...matched].sort((a, b) => rank(a) - rank(b))
  // section visibility keys off the unfiltered set: a filter with zero hits
  // must not hide the section (and with it the very chips to undo the filter)
  const finishedAll = downloads.filter((d) => d.status !== 'running' && d.status !== 'queued' && d.status !== 'paused')
  const finished = finishedAll.filter(
    (d) => (statusFilter.size === 0 || statusFilter.has(d.status)) && nameMatch(d, historyQuery),
  )
  const finishedShown = finished.slice(0, historyFiltering || showAllHistory ? finished.length : 20)
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
  // the queue folds like the history does: on a phone a long queue is what
  // stands between the top of the page and the week's releases
  const [queueOpen, setQueueOpen] = useState(true)
  // the history toolbar is one row on a phone: box, search, status select,
  // clear. The search keeps what is left, which is too little for the full
  // placeholder - a short one there, the aria-label stays the full sentence
  const phone = useMediaQuery('(width < 40rem)')
  // the speed tiles are the desktop aside's; on a phone the hero carries the
  // rate itself, and the tiles' every-second render would be for nothing
  const wide = useMediaQuery(WIDE_MQ)
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
      <header className="mb-6 hidden items-start justify-between gap-4 lg:flex">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('dash.title')}</h2>
          <Badge className="mt-1">{t('dash.sub')}</Badge>
        </div>
        {/* the page-wide, reversible actions: top right of the header on
            desktop, the app bar on a phone. Cancelling everything is
            destructive and stays down at the queue's toolbar */}
        <PageActions>
          {anyActive && (
            <Button size="sm" disabled={bulk.isPending} aria-label={t('dash.pauseAll')} onClick={() => bulk.mutate({ a: 'pause' })}>
              <Pause aria-hidden size="1em" className="inline align-[-0.125em] lg:mr-1" />
              <span className="hidden lg:inline">{t('dash.pauseAll')}</span>
            </Button>
          )}
          {anyPaused && (
            <Button size="sm" disabled={bulk.isPending} aria-label={t('dash.resumeAll')} onClick={() => bulk.mutate({ a: 'resume' })}>
              <Play aria-hidden size="1em" className="inline align-[-0.125em] lg:mr-1" />
              <span className="hidden lg:inline">{t('dash.resumeAll')}</span>
            </Button>
          )}
        </PageActions>
      </header>

      <BackgroundWork />

      {/* a phone reads top to bottom: the queue, then what is coming and what
          needs a hand, then the history. From lg the middle part is the
          right column beside both (a main pane and a supporting pane), so
          the three are grid siblings placed by breakpoint rather than one
          column nested in another */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <aside className="order-2 flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {wide && activeAll.some((d) => d.status === 'running') && <SpeedTiles downloads={activeAll} />}
          {watchesLoading ? (
            <div role="status" aria-label={t('app.loading')} className="flex animate-pulse flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Panel key={i} className="flex items-center gap-3 p-2">
                  <Skeleton shape="cover" size="sm" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="w-2/3" />
                    <Skeleton className="w-1/3" />
                  </div>
                </Panel>
              ))}
            </div>
          ) : watches.length === 0 ? (
            <EmptyState>
              <Trans i18nKey="dash.noWatches">
                Noch keine Serie überwacht. In <Link to="/files" className="text-accent underline">Dateien</Link> einen Ordner beobachten.
              </Trans>
            </EmptyState>
          ) : (
            <>
              <UpNext watches={watches} limit={wide ? 5 : 3} />
              <Attention watches={watches} />
            </>
          )}
          <StorageTile />
        </aside>

          <section aria-label={t('dash.transferSection')} className="order-1 min-w-0 lg:col-start-1 lg:row-start-1">
            {/* divider header doubles as the collapse toggle, like the
                history's - hand-rolled because <Divider> always renders its
                label as a non-interactive chip */}
            <div className="t-divider mb-3">
              <button
                type="button"
                className="t-label t-label--accent cursor-pointer"
                aria-expanded={queueOpen}
                onClick={() => setQueueOpen((o) => !o)}
              >
                {queueOpen ? <ChevronDown aria-hidden size="1em" /> : <ChevronRight aria-hidden size="1em" />}
                <DownloadIcon aria-hidden size="1em" />
                {t('dash.transferSection')}
              </button>
              <span className="t-divider-rule" />
              <Count>{activeAll.length}</Count>
            </div>
            {queueOpen && (
            <>
            {/* the toolbar earns its row from the second download on:
                select-all, search and cancel-everything over a single card
                are chrome in front of the one thing on screen */}
            {activeAll.length > 1 && (
            <Toolbar className="mb-3">
              <input
                ref={activeAllRef}
                type="checkbox"
                title={t('dash.selectAll')}
                aria-label={t('dash.selectAll')}
                checked={allActiveSelected}
                onChange={() => toggleSection(activeIds, allActiveSelected)}
              />
              {/* the checkbox and the search share the first row on a phone,
                  the bulk controls take the second */}
              <Input
                className="min-w-0 flex-1 font-mono text-xs sm:max-w-72 sm:flex-none"
                type="search"
                placeholder={t('dash.search')}
                aria-label={t('dash.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Toolbar className="ml-auto basis-full sm:basis-auto">
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
                {!!user?.isAdmin && <GlobalLimitInput />}
              </Toolbar>
            </Toolbar>
            )}

            {/* the first answer is still out: a card in the hero's shape and
                two rows, so the page does not jump when it lands. Only then -
                a refetch never shows this */}
            {isLoading && (
              <div role="status" aria-label={t('app.loading')} className="flex animate-pulse flex-col gap-3">
                <Panel className="flex gap-4 p-4">
                  <Skeleton shape="cover" />
                  <div className="min-w-0 flex-1 space-y-2.5 py-1">
                    <Skeleton className="w-2/3" />
                    <Skeleton className="w-1/3" />
                    <Skeleton shape="block" className="mt-4 h-2 w-full" />
                  </div>
                </Panel>
                {[0, 1].map((i) => (
                  <Panel key={i} className="flex gap-3 p-3">
                    <Skeleton shape="cover" size="sm" />
                    <div className="min-w-0 flex-1 space-y-2 py-1">
                      <Skeleton className="w-1/2" />
                      <Skeleton shape="block" className="h-1 w-full" />
                    </div>
                  </Panel>
                ))}
              </div>
            )}
            {!isLoading &&
              active.length === 0 &&
              (filtering ? (
                <EmptyState>{t('dash.noMatches')}</EmptyState>
              ) : (
                // idle is the normal state, and it must not cost a screen: one
                // line with the way to the next download, not a tall blank
                <Panel className="p-3 text-sm text-t-muted">
                  <Trans i18nKey="dash.idle">
                    Nichts wird übertragen. <Link to="/files" className="text-accent underline">Dateien</Link> öffnen, um etwas zu laden.
                  </Trans>
                </Panel>
              ))}
            <div className="flex flex-col gap-3">
              {active.map((d) => (
                <DownloadRow
                  key={d.id}
                  d={d}
                  meta={meta}
                  watches={watches}
                  variant={d === hero ? 'hero' : 'row'}
                  selected={selected.has(d.id)}
                  onSelect={(shift) => selectRow(d.id, shift)}
                  onAction={(verb) => action.mutate({ id: d.id, verb })}
                />
              ))}
            </div>
            </>
            )}
          </section>

          {finishedAll.length > 0 && (
            <section aria-label={t('dash.finishedSection')} className="order-3 min-w-0 lg:col-start-1 lg:row-start-2">
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
                      className="min-w-0 flex-1 font-mono text-xs sm:max-w-72 sm:flex-none"
                      type="search"
                      placeholder={phone ? t('dash.searchShort') : t('dash.search')}
                      aria-label={t('dash.search')}
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                    />
                    {/* one select on a phone, so the filter shares the row
                        with the search instead of taking a second one as
                        three chips. Single choice there: the chips' multi
                        select is a desktop nicety, not something the phone
                        row has room for */}
                    <Select
                      size="sm"
                      // important: .t-select-wrap sets display outside the
                      // utilities layer and would win over a plain sm:hidden
                      wrapperClassName="sm:hidden!"
                      aria-label={t('dash.filterStatus')}
                      value={statusFilter.size === 1 ? [...statusFilter][0] : ''}
                      onChange={(e) => setStatusFilter(e.target.value ? new Set([e.target.value as Download['status']]) : new Set())}
                    >
                      <option value="">{t('dash.filterAll')}</option>
                      {HISTORY_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {t(`status.${st}`)}
                        </option>
                      ))}
                    </Select>
                    {/* toggle chips: <Badge> renders a span, these have to stay
                        buttons with aria-pressed - kept hand-written */}
                    <div role="group" aria-label={t('dash.filterStatus')} className="hidden flex-wrap items-center gap-1 sm:flex">
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
                    {/* clears what the search and status filter currently
                        match, so one button covers "everything" and "only the
                        failed ones". Disabled on an empty match: the bulk
                        endpoint reads an empty id list as "all of it" */}
                    <Toolbar className="ml-auto">
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={t('dash.clearHistory')}
                        title={t('dash.clearHistory')}
                        disabled={bulk.isPending || historyIds.length === 0}
                        onClick={async () => {
                          if (
                            await confirm({
                              message: t('dash.clearHistoryConfirm', { count: historyIds.length }),
                              destructive: true,
                            })
                          )
                            bulk.mutate({ a: 'delete', ids: historyIds })
                        }}
                      >
                        <Trash2 aria-hidden size="1em" className="inline align-[-0.125em] sm:mr-1" />
                        <span className="hidden sm:inline">{t('dash.clearHistory')}</span>
                      </Button>
                    </Toolbar>
                  </Toolbar>
                  {/* not <EmptyState>: this one is the compact p-6/text-sm
                      variant, and its padding must not be overridden */}
                  {finished.length === 0 && historyFiltering && (
                    <Panel className="p-6 text-center text-sm text-t-muted">{t('dash.noMatches')}</Panel>
                  )}
                  {/* one bracketed block with hairlines between the rows,
                      the sync summary's recipe: twenty bordered cards under
                      each other read as twenty boxes, not as a list */}
                  <Panel className="mt-2">
                    <ul className="divide-y divide-border-subtle">
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
                    </ul>
                  </Panel>
                  {finished.length > finishedShown.length && (
                    <Button size="sm" className="mt-3" onClick={() => setShowAllHistory(true)}>
                      {t('dash.showAllHistory', { count: finished.length })}
                    </Button>
                  )}
                </>
              )}
            </section>
          )}
          {/* the selection's actions while rows are selected: the shell's footer
              row above the tab bar on a phone, a floating toolbar at the foot
              of the viewport on desktop. Inside the queue column, not under the
              whole grid: the summary column is usually the taller one, and the
              bar sat at its foot with a screen's worth of nothing between it
              and the rows */}
          {selected.size > 0 && (
            <div className="order-4 lg:col-start-1">
            <PageFooter>
              <ActionBar aria-label={t('dash.selectionActions')} floating>
                <Badge tone="accent">{t('dash.selectedCount', { count: selected.size })}</Badge>
                {activeSelected.length > 0 && (
                  <>
                    <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'pause', ids: activeSelected })}>
                      <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('dash.pause')}
                    </Button>
                    <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume', ids: activeSelected })}>
                      <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('dash.resume')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'cancel', ids: activeSelected })}>
                      <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('dash.cancel')}
                    </Button>
                  </>
                )}
                {historySelected.length > 0 && (
                  <>
                    <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'resume', ids: historySelected })}>
                      <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('dash.retry')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={bulk.isPending} onClick={() => bulk.mutate({ a: 'delete', ids: historySelected })}>
                      <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('dash.removeSelected')}
                    </Button>
                  </>
                )}
                <Button size="sm" className="ml-auto lg:ml-2" onClick={() => setSelected(new Set())}>
                  <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('dash.clearSelection')}
                </Button>
              </ActionBar>
            </PageFooter>
            </div>
          )}
      </div>
    </div>
  )
}

// what to call a watch: the override, else the matched title, else the folder
const watchTitle = (w: Watch) => w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')

// The rate over the last minute and how long the queue has left, beside the
// queue on desktop. Only while something runs: a tile saying 0 B/s says
// nothing, and the hero already carries its own rate on a phone.
function SpeedTiles({ downloads }: { downloads: Download[] }) {
  const { t } = useTranslation()
  const hist = useSpeedHistory()
  const running = downloads.filter((d) => d.status === 'running')
  const total = running.reduce((s, d) => s + (d.bytesPerSec ?? 0), 0)
  const open = downloads.reduce((s, d) => s + Math.max(0, d.size - d.transferred), 0)
  // the mean of the last ten seconds, not the instant: a burst would swing
  // the arrival by hours. Nothing while it is still zero
  const avg = avgSpeed(10)
  return (
    <div className="flex flex-col gap-3">
      <StatTile
        label={t('dash.speed')}
        value={fmtSpeed(total)}
        detail={t('dash.speedOver', { count: running.length })}
        trend={<Sparkline values={hist} label={t('dash.speedChart')} className="mb-1.5 text-accent" />}
      />
      {avg > 0 && (
        <StatTile
          label={t('dash.remaining')}
          value={remaining(t, open / avg)}
          detail={t('dash.remainingOpen', { size: fmtBytes(open) })}
        />
      )}
    </div>
  )
}

// The next releases the providers know of, for the coming week: the reason
// to open the app between downloads, two taps closer than the calendar.
function UpNext({ watches, limit }: { watches: Watch[]; limit: number }) {
  const { t } = useTranslation()
  const events = upcomingAirings(watches, Date.now(), 7).slice(0, limit)
  const when = (ts: number) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <section aria-label={t('dash.upNext')}>
      <Divider
        className="mb-2 whitespace-nowrap"
        label={
          <>
            <CalendarDays aria-hidden size="1em" />
            {t('dash.upNext')}
          </>
        }
        trailing={
          /* inline-flex + min-h keeps the 24px target size (WCAG 2.5.8) */
          <Link
            to="/watches?view=calendar"
            className="inline-flex min-h-6 items-center whitespace-nowrap text-[11px] text-accent hover:underline"
          >
            {t('dash.calendar')} →
          </Link>
        }
      />
      {events.length === 0 ? (
        <p className="text-xs text-t-muted">{t('dash.upNextEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={`${e.watch.id}-${e.episode}-${e.at}`}>
              <CalendarEntry
                cover={e.watch.media?.coverImage?.large}
                title={watchTitle(e.watch)}
                episode={
                  <>
                    {t('watch.nextEp', { n: e.episode })}
                    {e.episodeAbs && e.episodeAbs !== e.episode ? ` (${e.episodeAbs})` : ''}
                  </>
                }
                time={when(e.at)}
                countdown={countdown(t, e.at)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// The watches that need a hand: behind the broadcast, a gap, waiting on a
// dub or sub, or a failed check. Counters alone were what this used to be;
// a number of watched series is not something anyone acts on.
function Attention({ watches }: { watches: Watch[] }) {
  const { t } = useTranslation()
  const needy = watches.filter(
    (w) => (w.behind ?? 0) > 0 || (w.missing?.length ?? 0) > 0 || (w.langWaiting ?? 0) > 0 || w.lastResult !== '',
  )
  const shown = needy.slice(0, 5)
  return (
    <section aria-label={t('dash.attention')}>
      <Divider
        className="mb-2 whitespace-nowrap"
        label={
          <>
            <Eye aria-hidden size="1em" />
            {t('dash.attention')}
          </>
        }
        count={needy.length}
      />
      {needy.length === 0 ? (
        <p className="text-xs text-t-muted">{t('dash.attentionEmpty', { count: watches.length })}</p>
      ) : (
        <Panel>
          <ul className="divide-y divide-border-subtle">
            {shown.map((w) => (
              <li key={w.id}>
                <Link to="/watches" className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-bg-hover">
                  {w.media?.coverImage?.large && <Cover src={w.media.coverImage.large} size="sm" loading="lazy" />}
                  <span className="min-w-0 flex-1 truncate text-t-secondary" title={w.remotePath}>
                    {watchTitle(w)}
                  </span>
                  {/* compact chips: icon + count only, the column is too narrow
                      for the sentences - they live in the tooltip */}
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
                  {w.lastResult !== '' && (
                    <Badge tone="err" className="shrink-0" title={w.lastResult}>
                      <X aria-hidden size="1em" />
                      {t('dash.checkFailed')}
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {needy.length > shown.length && (
        <Link to="/watches" className="mt-2 inline-flex min-h-6 items-center text-[11px] text-accent hover:underline">
          {t('dash.attentionMore', { count: needy.length - shown.length })}
        </Link>
      )}
    </section>
  )
}

// How full the download disk is, for the admin who can do something about
// it. The status endpoint is admin-gated, so nobody else asks.
function StorageTile() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const { data } = useQuery<SystemStatus>({
    queryKey: ['status'],
    queryFn: () => api.get('/api/status'),
    refetchInterval: 60_000,
    enabled: !!user?.isAdmin,
  })
  const disk = data?.disk
  if (!disk?.totalBytes) return null
  const pct = (disk.usedBytes / disk.totalBytes) * 100
  return (
    <StatTile
      label={t('dash.storage')}
      value={t('dash.storageFree', { size: fmtBytes(disk.freeBytes) })}
      detail={t('dash.storageOf', { used: fmtBytes(disk.usedBytes), total: fmtBytes(disk.totalBytes) })}
      trend={
        <Progress
          value={pct}
          tone={pct >= 95 ? 'err' : pct >= 85 ? 'warn' : 'ok'}
          size="sm"
          label={t('dash.storageUsed', { pct: Math.round(pct) })}
          className="mb-2 w-20"
        />
      }
    />
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
  // the suggestion blob is a per-user cache that rebuilds every half hour;
  // the suggestions screen says so itself, the dashboard names the heavy work
  const running = (data?.running ?? []).filter((f) => f !== 'suggestions')
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
        <Link to="/settings/jobs" className="inline-flex min-h-6 items-center text-accent underline">
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
// the parent), Space works natively via the checkbox semantics. The label
// pads the hit area out to 40px without moving anything: the negative margin
// gives the padding back, so the visible box stays the 24px it is.
function SelectBox({ checked, name, onSelect }: { checked: boolean; name: string; onSelect: (shift: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <label className="-m-2 flex shrink-0 p-2">
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
    </label>
  )
}

// dirOf is the folder a path lives in, for the browser deep links.
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

// DetailsToggle is the chevron that opens a download's metadata: a square
// small button, the same box as the row's other actions.
function DetailsToggle({ open, name, onToggle }: { open: boolean; name: string; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <Button size="sm" className="aspect-square px-0!" aria-expanded={open} aria-label={t('dash.details', { name })} onClick={onToggle}>
      {open ? <ChevronDown aria-hidden size="1.2em" /> : <ChevronRight aria-hidden size="1.2em" />}
    </Button>
  )
}

// DownloadDetails is the expanded half of a queue or history row: what the file
// becomes, where it comes from, where it lands, and the pages that describe it.
// Shared by both row types so they cannot drift apart. Labels are small caps
// text, not chips: a chip is a control or a status, and a caption over a path
// is neither.
function DownloadDetails({ d, meta }: { d: Download; meta?: DownloadMeta }) {
  const { t } = useTranslation()
  const { group } = downloadLabel(d, meta)
  const remoteDir = dirOf(d.remotePath)
  const localDir = dirOf(d.localPath)
  const remoteBase = d.remotePath.split('/').pop() ?? ''
  const localBase = d.localPath.split('/').pop() ?? ''
  const showFolder = group?.folder ?? remoteDir
  const remoteLink = (path: string) => `/files?server=${d.serverId}&path=${encodeURIComponent(path)}`
  const caption = 'mb-0.5 font-display text-[11px] font-semibold uppercase tracking-wider text-t-muted'
  return (
    <div className="mt-3 border-t border-border-subtle pt-3 text-xs">
      {/* source and target side by side from sm on, everything else full
          width; a rename only when there is one - "no renaming" was a line
          saying nothing */}
      <dl className="grid gap-3 sm:grid-cols-2">
        {group?.overview && (
          <div className="min-w-0 sm:col-span-2">
            <dt className={caption}>{t('dash.overview')}</dt>
            <dd className="line-clamp-3 text-t-secondary">{group.overview}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className={caption}>{t('dash.source')}</dt>
          <dd className="break-all">
            {group?.serverName && <span className="mr-2 text-t-muted">{group.serverName}</span>}
            <Link to={remoteLink(remoteDir)} className="font-mono text-accent underline">
              {remoteDir}
            </Link>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={caption}>{t('dash.target')}</dt>
          <dd className="break-all">
            <Link to={`/files?source=local&path=${encodeURIComponent(localDir)}`} className="font-mono text-accent underline">
              {localDir}
            </Link>
          </dd>
        </div>
        {remoteBase !== localBase && (
          <div className="min-w-0 sm:col-span-2">
            <dt className={caption}>{t('dash.renamedTo')}</dt>
            {/* two lines, the new name under the old: file names are long,
                and inline the arrow vanished somewhere in the middle */}
            <dd className="break-all font-mono">
              <span className="block text-t-muted">{remoteBase}</span>
              <span className="block text-t-secondary">
                <ArrowRight aria-hidden size="1em" className="mr-1 inline align-[-0.125em] text-accent" />
                {localBase}
              </span>
            </dd>
          </div>
        )}
        <div className="min-w-0 sm:col-span-2">
          <dt className={caption}>{t('dash.linksLabel')}</dt>
          {/* the one row made of controls, so chips are right here. The
              catalog link leads first and in the accent tone: it stays inside
              the app, the provider pages behind it all leave it */}
          <dd className="flex flex-wrap items-center gap-1.5">
            <Link to={remoteLink(showFolder)} className="t-label t-label--accent">
              <FolderOpen aria-hidden size="1em" />
              {t('dash.openShow')}
            </Link>
            {group?.providers && group.providers.length > 0 && <ProviderBadges providers={group.providers} links={group.links} />}
          </dd>
        </div>
      </dl>
    </div>
  )
}

function DownloadRow({
  d,
  meta,
  watches,
  variant,
  selected,
  onSelect,
  onAction,
}: {
  d: Download
  meta?: DownloadMeta
  watches: Watch[]
  variant: 'hero' | 'row'
  selected: boolean
  onSelect: (shift: boolean) => void
  onAction: (verb: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const pct = d.size > 0 ? Math.min(100, (d.transferred / d.size) * 100) : 0
  const { label, ep, name, group } = downloadLabel(d, meta)
  const running = d.status === 'running'
  // the hero says what it is loading: year, studio and score of the series,
  // which only the watch behind the folder knows
  const media = variant === 'hero' && group?.watchId ? watches.find((w) => w.id === group.watchId)?.media : undefined
  const about = media
    ? [media.seasonYear || null, media.studios?.[0], media.averageScore ? `${media.averageScore} %` : null].filter(Boolean).join(' · ')
    : undefined
  // the arrival, from the backend's own smoothed rate; nothing while the
  // rate is still zero, a division by that is not a time
  const eta = running && d.bytesPerSec ? remaining(t, (d.size - d.transferred) / d.bytesPerSec) : null
  // each figure keeps to one piece: a phone breaks the line, and "26.7 /
  // KiB/s" split across two is not a rate
  const stats = [`${fmtBytes(d.transferred)} / ${fmtBytes(d.size)}`, running && d.bytesPerSec != null ? fmtSpeed(d.bytesPerSec) : null, eta]
    .filter(Boolean)
    .map((part, i) => (
      <span key={i} className="whitespace-nowrap">
        {i > 0 && <span aria-hidden> · </span>}
        {part}
      </span>
    ))
  return (
    <TransferCard
      variant={variant}
      selected={selected}
      leading={<SelectBox checked={selected} name={name} onSelect={onSelect} />}
      cover={group?.cover}
      title={label}
      subtitle={label !== name ? name : undefined}
      badges={
        <>
          {/* a waiting retry is still 'queued', and "queued" alone would hide
              that this download already failed once. The countdown replaces
              the status chip rather than joining it: two chips saying when
              this row will run is one too many for a phone line. */}
          {isRetrying(d) ? (
            <Badge tone="warn">
              <RefreshCw aria-hidden size="1em" />
              {t('dash.retryIn', { n: d.attempts ?? 1, when: countdown(t, d.retryAt!, true) })}
            </Badge>
          ) : (
            <StatusChip status={d.status} />
          )}
          {ep && <Badge tone="accent">{ep}</Badge>}
          {/* why it is waiting, in the row's own words - a countdown without
              a reason is an unexplained pause */}
          {isRetrying(d) && d.error && (
            <span className="max-w-64 truncate text-xs text-err" title={d.error}>
              {d.error}
            </span>
          )}
        </>
      }
      meta={about}
      stats={stats}
      trailing={<DetailsToggle open={open} name={name} onToggle={() => setOpen((o) => !o)} />}
      percent={pct}
      progressLabel={t('dash.progressOf', { name })}
      active={running}
      actions={
        <>
          {/* on a phone the buttons drop their captions and keep the icon,
              which is what leaves the limit control room to stay on the line */}
          {running || d.status === 'queued' ? (
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
        </>
      }
    >
      {open && <DownloadDetails d={d} meta={meta} />}
    </TransferCard>
  )
}

// HistoryRow is a finished download: one list row, expandable to the same
// details as a queue row. Worth expanding here too - the file exists now, so the
// link into the local browser actually leads somewhere. The row itself carries
// no buttons: retry and remove live in the expanded half, bulk selection covers
// the many-at-once case, and the line is left to the title and one meta line.
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
  const StatusIcon = STATUS_ICON[d.status]
  const tone = d.status === 'done' ? 'text-ok' : d.status === 'error' ? 'text-err' : 'text-t-muted'
  return (
    <li className={`px-3 py-2 text-sm ${selected ? 'bg-bg-hover' : ''}`}>
      {/* box, cover, then the whole rest of the line is the details toggle -
          a sibling of the checkbox, never its parent */}
      <div className="flex items-center gap-3">
        <SelectBox checked={selected} name={name} onSelect={onSelect} />
        {/* a spacer keeps the text column flush down a divided list; the
            hatched placeholder on every unmatched row would be noise */}
        {group?.cover ? <Cover src={group.cover} size="sm" loading="lazy" /> : <span aria-hidden className="w-10 shrink-0" />}
        {/* no aria-label: the visible title and meta line are the button's
            name, aria-expanded says what it does */}
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-t-primary" title={d.remotePath}>
              {label}
            </span>
            {/* status, episode and size as one line of text: the chips this
                used to be were two more boxes on a line that had five */}
            <span className="mt-0.5 block truncate text-xs text-t-muted">
              {/* text-xs on the span itself, not only inherited: the audit's
                  nowrap check measures a detached clone, which would grow to
                  the body size without it */}
              <span className={`text-xs capitalize ${tone}`}>
                <StatusIcon aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t(`status.${d.status}`)}
              </span>
              {ep && <span aria-hidden> · </span>}
              {ep}
              <span aria-hidden> · </span>
              {fmtBytes(d.size)}
            </span>
          </span>
          {open ? (
            <ChevronDown aria-hidden size="1.2em" className="shrink-0 text-t-muted" />
          ) : (
            <ChevronRight aria-hidden size="1.2em" className="shrink-0 text-t-muted" />
          )}
        </button>
      </div>
      {/* the failure gets its own line under the row, explained or not: inline
          it fought the title for the little width left, and on a tablet the
          title lost every time */}
      {explained ? (
        <FsErrorNote code={d.errorCode!} dir={dirOf(d.localPath)} className="mt-2" />
      ) : (
        d.error && (
          <p className="mt-1 truncate text-xs text-err" title={d.error}>
            {d.error}
          </p>
        )
      )}
      {open && (
        <>
          <DownloadDetails d={d} meta={meta} />
          <div className="mt-3 flex flex-wrap gap-2">
            {(d.status === 'error' || d.status === 'canceled') && (
              <Button size="sm" onClick={() => onAction('resume')}>
                <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('dash.retry')}
              </Button>
            )}
            <Button size="sm" variant="danger" aria-label={t('dash.remove', { id: d.id })} onClick={() => onAction('delete')}>
              <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('dash.removeSelected')}
            </Button>
          </div>
        </>
      )}
    </li>
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
