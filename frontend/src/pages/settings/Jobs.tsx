import { Check, ChevronLeft, ChevronRight, Pause, Play, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Checkbox, Dialog, Input, Panel, Select } from '@weebsync/design-system'
import { api, fmtBytes, type JobsStatus, type Media } from '../../api'
import { jobFamily, jobLabel } from '../../jobs'
import { useConfirm } from '../../components/confirm'
import i18n from '../../locales'

/* Uniformity rules for this page (user requirement: identical elements must
   always align vertically across rows/panels):
   - every row is a two-cell grid `ROW_GRID`: name cell left, one right-anchored
     cell (justify-self-end) that owns the row's right edge - no ad-hoc margins.
     Below md both cells span the full width and stack; the right cell stays
     right-anchored, so stats/buttons keep identical x positions across rows.
     The label track has a hard 10rem minimum and side-by-side layout only
     starts at md - a label must never render narrower than readable; when
     space runs out the row stacks instead.
   - all numbers render font-mono tabular-nums; stat columns have fixed widths.
   - count badges (matched/unmatched) share a fixed min-width so the pair
     columnizes across rows, and match the small-button height (24px, 32px on
     touch) so badge rows and button rows read as one system.
   - every NumEdit input is w-20 h-6 (t-btn--sm height) with the unit folded
     into the label ("TTL (h)") - nothing ever renders to the right of an
     input, keeping edges flush. */
const ROW_GRID =
  'grid grid-cols-[minmax(10rem,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border-subtle text-sm'
const CELL_LEFT = 'col-span-full flex min-w-0 flex-wrap items-center gap-2 md:col-span-1'
const CELL_RIGHT = 'col-span-full flex flex-wrap items-center justify-end gap-2 md:col-span-1 md:justify-self-end'
const NUM = 'text-right font-mono text-xs tabular-nums text-t-muted'
const NUMEDIT_GRID = 'grid grid-cols-[auto_5rem] items-center gap-x-2 gap-y-1'
// extra utilities handed to <Badge>, which supplies the chip base itself
const COUNT_BADGE = 'min-h-6 min-w-28 shrink-0 justify-center px-2.5 tabular-nums [@media(pointer:coarse)]:min-h-8'

// Pinned contract with the admin endpoints (Workstream A) - keep in sync.

// One rebuildable body of data, as /api/admin/data reports it. The backend
// sends slugs only; every word on screen comes from settings.jobs.data.* here,
// so the page stays bilingual.
type StoreKind = 'cache' | 'derived' | 'decision'

interface DataStore {
  name: string // "cache:plex", "series", ...
  kind: StoreKind
  tables: string[]
  rows: number
  bytes: number // cache stores only, 0 elsewhere
  oldest: string // SQLite UTC "2026-07-15 20:32:40", may be ""
  newest: string
  ttlSec: number // cache stores only
  stale: number // cache stores only: rows past their TTL
  rebuild: string // job/mechanism slug, "" = on demand
  needs: string[] // store slugs that have to be filled first
  keptOnReset: boolean
}

interface AdminData {
  stores: DataStore[]
}

interface ResetResult {
  deleted: Record<string, number>
  kept: string[]
  queued: number
}

interface IndexServer {
  id: number
  name: string
  rows: number
  dirs: number
  pendingDirs: number
  stalestListedAt: string
  intervalMin?: number // crawler tick, 0/absent = default
  batch?: number // dirs per tick, 0/absent = default
}

interface MatchStat {
  serverId: number
  name: string
  source: string
  total: number
  matched: number
  unmatched: number
  manual: number
}

interface TtlConfig {
  anilistH: number
  tmdbH: number
  plexH: number
}

interface AdminJobs {
  running: string[]
  matchQueue: number
  plex: { configured: boolean; suggestionsAt: string; ttlSec: number }
  anilist: { accounts: number }
  index: { tickSec: number; recheckSec: number; servers: IndexServer[] }
  watch: { intervalMin: number; count: number }
  matches: MatchStat[]
  logLevel: LogLevel
  ttl?: TtlConfig // arriving with the config workstream; fall back to defaults
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

interface LogLine {
  ts: string
  level: LogLevel
  msg: string
  attrs?: Record<string, unknown>
}

const LOG_COLOR: Record<LogLevel, string> = {
  trace: 'text-t-muted',
  debug: 'text-t-secondary',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-err',
}

// LogPanel is the admin live log: an SSE stream of backend records (backlog
// first, then live) with a runtime level switch, a client-side level filter,
// pause and clear. Modelled on useEvents (hooks.ts) but keeps its own capped
// buffer instead of a react-query cache.
function LogPanel({ level }: { level: LogLevel }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const endRef = useRef<HTMLDivElement>(null)

  const setLevel = useMutation({
    mutationFn: (lvl: LogLevel) => api.put('/api/admin/loglevel', { level: lvl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['adminJobs'] }),
  })

  useEffect(() => {
    const es = new EventSource('/api/admin/logs/stream')
    es.onmessage = (ev) => {
      if (pausedRef.current) return
      let line: LogLine
      try {
        line = JSON.parse(ev.data)
      } catch {
        return // ignore keepalive/malformed frames
      }
      // cap at 500 so a chatty trace level can't grow the DOM unbounded
      setLines((old) => (old.length >= 500 ? [...old.slice(old.length - 499), line] : [...old, line]))
    }
    // a 401 (expired session) otherwise reconnect-loops forever; re-check auth
    es.onerror = () => qc.invalidateQueries({ queryKey: ['me'] })
    return () => es.close()
  }, [qc])

  const shown = filter === 'all' ? lines : lines.filter((l) => l.level === filter)

  useEffect(() => {
    if (!paused) endRef.current?.scrollIntoView({ block: 'end' })
  }, [shown.length, paused])

  const fmtAttrs = (a?: Record<string, unknown>) =>
    a
      ? Object.entries(a)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : ''

  return (
    <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.logs.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="accent">{t('settings.jobs.logs.title')}</Badge>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-t-muted" htmlFor="log-level">
            {t('settings.jobs.logs.level')}
          </label>
          <Select
            id="log-level"
            size="sm"
            value={level}
            disabled={setLevel.isPending}
            onChange={(e) => setLevel.mutate(e.target.value as LogLevel)}
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <label className="text-xs text-t-muted" htmlFor="log-filter">
            {t('settings.jobs.logs.filter')}
          </label>
          <Select
            id="log-filter"
            size="sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value as LogLevel | 'all')}
          >
            <option value="all">{t('settings.jobs.logs.all')}</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            ) : (
              <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            )}
            {paused ? t('settings.jobs.logs.resume') : t('settings.jobs.logs.pause')}
          </Button>
          <Button size="sm" onClick={() => setLines([])}>
            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('settings.jobs.logs.clear')}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.logs.hint')}</p>
      <div className="mt-3 max-h-96 overflow-y-auto border border-border-subtle bg-bg-secondary/40 p-2 font-mono text-xs leading-relaxed">
        {shown.length === 0 ? (
          <p className="text-t-secondary">{t('settings.jobs.logs.empty')}</p>
        ) : (
          shown.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap wrap-break-word">
              <span className="text-t-muted">{fmtLogTime(l.ts)}</span>{' '}
              <span className={`${LOG_COLOR[l.level] ?? ''} font-semibold uppercase`}>{l.level}</span>{' '}
              <span>{l.msg}</span>
              {l.attrs && Object.keys(l.attrs).length > 0 && <span className="text-t-muted"> {fmtAttrs(l.attrs)}</span>}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </Panel>
  )
}

interface CacheEntry {
  key: string
  fetchedAt: string
  stale: boolean
  bytes: number
}

interface CacheEntriesResp {
  total: number
  entries: CacheEntry[]
}

interface MatchEntry {
  folder: string
  mediaId: number
  manual: boolean | number
  source: string // "anilist" | "tmdb:tv" | "tmdb:movie"
  title: string
}

interface MatchesResp {
  total: number
  entries: MatchEntry[]
}

const PAGE = 50
const TTL_DEFAULTS: TtlConfig = { anilistH: 24, tmdbH: 24, plexH: 6 }
const INDEX_DEFAULTS = { intervalMin: 5, batch: 20 }

const KIND_TONE: Record<StoreKind, 'neutral' | 'accent' | 'warn'> = {
  cache: 'neutral',
  derived: 'accent',
  decision: 'warn', // the one kind nothing rebuilds - the badge says so
}

// Store slugs carry a colon ("cache:plex"), which i18next reads as a namespace
// separator. Swapping it for a dot nests the texts instead, so the locale files
// group the cache scopes under one object.
const storeKey = (name: string) => name.replace(':', '.')

type TFunc = (key: string, opts?: Record<string, unknown>) => string

const storeLabel = (t: TFunc, name: string) =>
  t(`settings.jobs.data.stores.${storeKey(name)}.name`, { defaultValue: name })
const storeDesc = (t: TFunc, name: string) =>
  t(`settings.jobs.data.stores.${storeKey(name)}.desc`, { defaultValue: '' })
// "" from the backend means nothing schedules this - it refills when something
// needs it, which is worth saying out loud rather than leaving blank.
const rebuildLabel = (t: TFunc, slug: string) =>
  slug ? t(`settings.jobs.data.rebuild.${slug}`, { defaultValue: slug }) : t('settings.jobs.data.rebuild.onDemand')

// SQLite stores UTC without a timezone marker - tack on Z for local display.
// Dates and numbers follow the app language, not the browser locale, so the
// page stays consistent when UI language and OS locale differ.
function fmtTs(s: string): string {
  if (!s) return '-'
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(i18n.language)
}

// The log bus stamps RFC3339 in UTC, so cutting the time out of the string
// showed UTC rather than the viewer's clock - two hours off in CEST. Same rule
// as fmtTs: parse, then render in the app language.
function fmtLogTime(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s.slice(11, 19) : d.toLocaleTimeString(i18n.language, { hour12: false })
}

function fmtNum(n: number): string {
  return n.toLocaleString(i18n.language)
}

function fmtTtl(sec: number): string {
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`
  if (sec >= 60) return `${Math.round(sec / 60)}min`
  return `${sec}s`
}

// CSS can only truncate at the end; cache keys carry their signal at both ends.
function truncMiddle(s: string, max = 48): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2) - 1
  return `${s.slice(0, half)}…${s.slice(-half)}`
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// Release-style folder names carry bracket/paren tags ("Title S1 [JapDub,CR]")
// that make metadata searches miss - strip them for the search prefill.
function cleanTitle(name: string): string {
  const cleaned = name
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || name
}

// Debounced copy of a string; onSettle fires alongside (used to reset paging).
function useDebounced(value: string, onSettle: () => void): string {
  const [settled, setSettled] = useState(value)
  const settle = useRef(onSettle)
  settle.current = onSettle
  useEffect(() => {
    const id = setTimeout(() => {
      setSettled(value)
      settle.current()
    }, 300)
    return () => clearTimeout(id)
  }, [value])
  return settled
}

// Small inline number editor: uncontrolled (the 5s poll must not clobber
// typing), remounts via key when the server value changes, commits on
// blur/Enter. 0 resets to the server-side default.
// Renders label and input as sibling cells (fragment) so a NUMEDIT_GRID
// container aligns the inputs of stacked editors in one column.
function NumEdit({
  id,
  label,
  value,
  hint,
  onCommit,
}: {
  id: string
  label: string
  value: number
  hint?: string
  onCommit: (n: number) => void
}) {
  const { t } = useTranslation()
  const title = hint ? `${hint} · ${t('settings.jobs.zeroDefault')}` : t('settings.jobs.zeroDefault')
  return (
    <>
      <label className="text-xs text-t-muted" htmlFor={id} title={title}>
        {label}
      </label>
      {/* text + numeric inputmode instead of type="number": Chrome reports a
          bogus aria-valuemax of 0 for max-less number inputs, which screen
          readers announce as out-of-range */}
      <Input
        id={id}
        key={value}
        className="h-6 w-20 px-2 py-1 text-right font-mono text-xs tabular-nums"
        type="text"
        inputMode="numeric"
        title={title}
        defaultValue={value}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onBlur={(e) => {
          if (e.target.value.trim() === '') return // cleared field ≠ explicit 0/reset
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= 0 && n !== value) onCommit(n)
        }}
      />
    </>
  )
}

export default function Jobs() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [cacheModal, setCacheModal] = useState<DataStore | null>(null)
  const [matchModal, setMatchModal] = useState<MatchStat | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const { data } = useQuery<AdminJobs>({
    queryKey: ['adminJobs'],
    queryFn: () => api.get('/api/admin/jobs'),
    refetchInterval: 5000,
  })
  // the paused set lives on the small status endpoint, which the dashboard
  // reads too - one source, so the two views cannot disagree
  const { data: jobsStatus } = useQuery<JobsStatus>({
    queryKey: ['jobs', 'status'],
    queryFn: () => api.get('/api/jobs'),
    refetchInterval: 5000,
  })
  // same 5s beat as the job status, so a running rebuild is watchable
  const { data: inventory } = useQuery<AdminData>({
    queryKey: ['adminData'],
    queryFn: () => api.get('/api/admin/data'),
    refetchInterval: 5000,
  })

  const opts = {
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
      qc.invalidateQueries({ queryKey: ['adminData'] })
    },
    onError: (e: Error) => setError(e.message),
  }
  const run = useMutation({
    mutationFn: ({ name, body }: { name: string; body?: unknown }) => api.post(`/api/admin/jobs/${name}/run`, body),
    ...opts,
  })
  // Holding a task is two things at once, because that is what "make it stop"
  // means: the family stops starting, and the pass that is running right now is
  // cancelled. Resuming only lifts the first - the next sweep starts it again.
  const hold = useMutation({
    mutationFn: async ({ family, paused }: { family: string; paused: boolean }) => {
      await api.post('/api/admin/jobs/pause', { family, paused })
      if (paused) await api.post(`/api/admin/jobs/${family}/stop`)
    },
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
      qc.invalidateQueries({ queryKey: ['jobs', 'status'] })
    },
    onError: (e: Error) => setError(e.message),
  })
  const flush = useMutation({
    mutationFn: (name: string) => api.del(`/api/admin/data/${encodeURIComponent(name)}`),
    ...opts,
  })
  const flushIndex = useMutation({
    mutationFn: (id: number) => api.del(`/api/admin/index/${id}`),
    ...opts,
  })
  const setTtl = useMutation({
    mutationFn: (body: TtlConfig) => api.put('/api/admin/ttl', body),
    ...opts,
  })
  const setIndexCfg = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { intervalMin: number; batch: number } }) =>
      api.put(`/api/admin/index/${id}/config`, body),
    ...opts,
  })

  if (!data) return null

  const ttl = data.ttl ?? TTL_DEFAULTS
  const commitTtl = (patch: Partial<TtlConfig>) => setTtl.mutate({ ...ttl, ...patch })
  const storeRow = (s: DataStore) => (
    <li key={s.name} className={`${ROW_GRID} gap-y-2 py-3`}>
      {/* stale badge lives in the label cell so rows with and without it
          keep identical stat/button geometry */}
      <span className={CELL_LEFT}>
        <span className="min-w-0 truncate font-semibold text-t-primary">{storeLabel(t, s.name)}</span>
        <Badge tone={KIND_TONE[s.kind]} className="shrink-0">
          {t(`settings.jobs.data.kind.${s.kind}`)}
        </Badge>
        {s.stale > 0 && (
          <Badge tone="warn" className="shrink-0 tabular-nums">
            {t('settings.jobs.stale', { count: s.stale })}
          </Badge>
        )}
      </span>
      <span className={CELL_RIGHT}>
        <span className={`w-20 ${NUM}`}>{t('settings.jobs.data.rowCount', { n: fmtNum(s.rows) })}</span>
        {/* size and TTL are cache-only facts, but the columns render either way
            so the numbers stay in one line down the list */}
        <span className={`w-16 ${NUM}`}>{s.kind === 'cache' ? fmtBytes(s.bytes) : ''}</span>
        <span className={`w-12 ${NUM}`}>{s.kind === 'cache' ? fmtTtl(s.ttlSec) : ''}</span>
        {s.kind === 'cache' && (
          <Button size="sm" onClick={() => setCacheModal(s)}>
            {t('settings.jobs.view')}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabled={flush.isPending}
          onClick={async () => {
            if (
              await confirm({
                message: t('settings.jobs.data.confirmDelete', { store: storeLabel(t, s.name) }),
                destructive: true,
              })
            )
              flush.mutate(s.name)
          }}
        >
          {t('settings.jobs.flush')}
        </Button>
      </span>
      <p className="col-span-full text-xs text-t-muted">
        {storeDesc(t, s.name)}{' '}
        <span className="text-t-secondary">
          {t('settings.jobs.data.rebuiltBy')}: {rebuildLabel(t, s.rebuild)}
          {s.needs.length > 0 &&
            ` · ${t('settings.jobs.data.needs')}: ${s.needs.map((n) => storeLabel(t, n)).join(', ')}`}
        </span>
      </p>
    </li>
  )
  // ml-auto is the single mechanism keeping every TTL group right-anchored,
  // including when a narrow control row wraps it onto its own line
  const ttlEdit = (key: keyof TtlConfig, id: string) => (
    <span className={`${NUMEDIT_GRID} ml-auto`}>
      <NumEdit
        id={id}
        label={t('settings.jobs.ttlH')}
        value={ttl[key]}
        onCommit={(n) => commitTtl({ [key]: n })}
      />
    </span>
  )

  const stores = inventory?.stores ?? []
  const idle = data.running.length === 0

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.activity')}>
        <Badge tone="accent">{t('settings.jobs.activity')}</Badge>
        <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.hint')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {idle && <Badge tone="ok">{t('settings.jobs.idle')}</Badge>}
          {data.running.map((job) => (
            <span key={job} className="flex items-center gap-1">
              <Badge className="font-mono">{job}</Badge>
              <Button
                size="sm"
                title={t('jobs.holdHint')}
                aria-label={`${t('jobs.hold')}: ${jobLabel(t, jobFamily(job))}`}
                disabled={hold.isPending}
                onClick={() => hold.mutate({ family: jobFamily(job), paused: true })}
              >
                <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('jobs.hold')}
              </Button>
            </span>
          ))}
          {(jobsStatus?.paused ?? []).map((family) => (
            <span key={family} className="flex items-center gap-1">
              <Badge tone="warn">
                {jobLabel(t, family)} · {t('jobs.paused')}
              </Badge>
              <Button
                size="sm"
                aria-label={`${t('jobs.resume')}: ${jobLabel(t, family)}`}
                disabled={hold.isPending}
                onClick={() => hold.mutate({ family, paused: false })}
              >
                <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('jobs.resume')}
              </Button>
            </span>
          ))}
          {data.matchQueue > 0 && (
            <Badge tone="warn" className="tabular-nums">
              {t('settings.jobs.queue', { count: data.matchQueue })}
            </Badge>
          )}
        </div>
        {(jobsStatus?.paused ?? []).length > 0 && (
          <p className="mt-2 text-xs text-warn">{t('jobs.pausedNote')}</p>
        )}
        <p className="mt-2 text-xs text-t-muted">
          {t('settings.jobs.watchSummary', { count: data.watch.count, min: data.watch.intervalMin })}
        </p>
      </Panel>

      <LogPanel level={data.logLevel} />

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.anilistCaches')}>
        <Badge tone="accent">{t('settings.jobs.anilistCaches')}</Badge>
        {/* header rhythm shared by all cache panels: info line, then one
            control row with buttons left and the TTL group right */}
        <p className="mt-3 text-xs text-t-muted">{t('settings.jobs.accounts', { count: data.anilist.accounts })}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={data.anilist.accounts === 0 || run.isPending}
            onClick={() => run.mutate({ name: 'anilist-suggestions' })}
          >
            {t('settings.jobs.rebuildSuggestions')}
          </Button>
          {ttlEdit('anilistH', 'ttl-anilist')}
        </div>
      </Panel>

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.tmdbCaches')}>
        <Badge tone="accent">{t('settings.jobs.tmdbCaches')}</Badge>
        <div className="mt-3 flex flex-wrap items-center gap-2">{ttlEdit('tmdbH', 'ttl-tmdb')}</div>
      </Panel>

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.plex')}>
        <Badge tone="accent">{t('settings.plex')}</Badge>
        {/* info line: status + last build; control row: button left, TTL right */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={data.plex.configured ? 'ok' : 'neutral'}>
            {data.plex.configured ? t('settings.jobs.configured') : t('settings.jobs.notConfigured')}
          </Badge>
          <span className="font-mono text-xs tabular-nums text-t-muted">
            {t('settings.jobs.suggestionsBuilt')}: {fmtTs(data.plex.suggestionsAt)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!data.plex.configured || run.isPending}
            onClick={() => run.mutate({ name: 'plex-suggestions' })}
          >
            {t('settings.jobs.rebuild')}
          </Button>
          {ttlEdit('plexH', 'ttl-plex')}
        </div>
      </Panel>

      {/* The inventory: everything the app can rebuild, in one list. Before it
          existed only the AniList cache was reachable from here, so a wrongly
          folded series identity survived every reset the page offered. */}
      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.data.title')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="accent">{t('settings.jobs.data.title')}</Badge>
          <Button size="sm" variant="danger" disabled={stores.length === 0} onClick={() => setResetOpen(true)}>
            <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('settings.jobs.data.reset.button')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.data.hint')}</p>
        {stores.length === 0 ? (
          <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
        ) : (
          <ul className="mt-2">{stores.map(storeRow)}</ul>
        )}
      </Panel>

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.remoteIndex')}>
        <Badge tone="accent">{t('settings.jobs.remoteIndex')}</Badge>
        {data.index.servers.length === 0 ? (
          <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
        ) : (
          <ul className="mt-2">
            {/* one delimited block per server: name/stats line, config/actions
                line - same grid geometry as every other row on the page */}
            {data.index.servers.map((s) => (
              <li key={s.id} className={`${ROW_GRID} gap-y-2 py-3`}>
                <span className={CELL_LEFT}>
                  <span
                    className="min-w-0 truncate font-semibold text-t-primary"
                    title={`${s.name} · ${t('settings.jobs.oldestListing')}: ${fmtTs(s.stalestListedAt)}`}
                  >
                    {s.name}
                  </span>
                  {s.pendingDirs > 0 && (
                    <Badge tone="warn" className="shrink-0 tabular-nums">
                      {t('settings.jobs.pending', { count: s.pendingDirs })}
                    </Badge>
                  )}
                </span>
                <span className={CELL_RIGHT}>
                  <span className={NUM}>
                    {t('settings.jobs.entries', { n: fmtNum(s.rows) })} ·{' '}
                    {t('settings.jobs.dirs', { n: fmtNum(s.dirs) })}
                  </span>
                </span>
                <span className={`${NUMEDIT_GRID} col-span-full self-start md:col-span-1`}>
                  <NumEdit
                    id={`idx-interval-${s.id}`}
                    label={t('settings.jobs.interval')}
                    value={s.intervalMin ?? INDEX_DEFAULTS.intervalMin}
                    onCommit={(n) =>
                      setIndexCfg.mutate({
                        id: s.id,
                        body: { intervalMin: n, batch: s.batch ?? INDEX_DEFAULTS.batch },
                      })
                    }
                  />
                  <NumEdit
                    id={`idx-batch-${s.id}`}
                    label={t('settings.jobs.batch')}
                    value={s.batch ?? INDEX_DEFAULTS.batch}
                    hint={t('settings.jobs.batchHint')}
                    onCommit={(n) =>
                      setIndexCfg.mutate({
                        id: s.id,
                        body: { intervalMin: s.intervalMin ?? INDEX_DEFAULTS.intervalMin, batch: n },
                      })
                    }
                  />
                </span>
                {/* buttons top-align with the first input row (self-start) and
                    share its 24px control height - anchored to the input grid,
                    not floating vertically centered beside it */}
                <span className={`${CELL_RIGHT} md:self-start`}>
                  <Button
                    size="sm"
                    className="flex-1 md:flex-none"
                    disabled={run.isPending}
                    onClick={() => run.mutate({ name: 'index-crawl', body: { serverId: s.id } })}
                  >
                    {t('settings.jobs.crawlNow')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="flex-1 md:flex-none"
                    disabled={flushIndex.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmFlushIndex', { name: s.name }), destructive: true }))
                        flushIndex.mutate(s.id)
                    }}
                  >
                    {t('settings.jobs.flushIndex')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-t-muted">
          {t('settings.jobs.indexHint')}
        </p>
      </Panel>

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.jobs.matchQuality')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="accent">{t('settings.jobs.matchQuality')}</Badge>
          <Button
            size="sm"
            variant="danger"
            disabled={run.isPending}
            onClick={async () => {
              if (await confirm({ message: t('settings.jobs.confirmRematchAllServers'), destructive: true }))
                run.mutate({ name: 'rematch-all', body: { all: true } })
            }}
          >
            {t('settings.jobs.rematchAllServers')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-t-muted">{t('settings.jobs.rematchAllServersHint')}</p>
        {data.matches.length === 0 ? (
          <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
        ) : (
          <ul className="mt-2">
            {/* per-mockup block: name line, then ONE 3-column grid shared by
                the badge row and the button row. Auto tracks size to the
                widest of badge/button per column and grid items stretch to
                their cell, so badge edges sit exactly flush over the buttons
                below (col 1 stays empty above "Ansehen"). Button labels are
                constant, so the tracks are identical across server blocks.
                The name lives outside the grid so long names cannot widen
                the tracks. Below md the grid collapses to one column: badges
                stack directly above the buttons, all full-width. */}
            {data.matches.map((m) => (
              <li key={`${m.serverId}-${m.source}`} className="border-b border-border-subtle py-3 text-sm">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-semibold text-t-primary" title={m.name}>
                    {m.name}
                  </span>
                  <Badge className="shrink-0">{m.source}</Badge>
                </span>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[auto_auto_auto] md:justify-end">
                  <Badge tone="ok" className={`${COUNT_BADGE} md:col-start-2 md:row-start-1`}>
                    {t('settings.jobs.matched', { n: fmtNum(m.matched) })}
                  </Badge>
                  <Badge
                    tone={m.unmatched > 0 ? 'warn' : 'neutral'}
                    className={`${COUNT_BADGE} md:col-start-3 md:row-start-1`}
                  >
                    {t('settings.jobs.unmatched', { n: fmtNum(m.unmatched) })}
                  </Badge>
                  <Button size="sm" className="md:col-start-1 md:row-start-2" onClick={() => setMatchModal(m)}>
                    {t('settings.jobs.view')}
                  </Button>
                  <Button
                    size="sm"
                    className="md:col-start-2 md:row-start-2"
                    disabled={run.isPending}
                    onClick={() => run.mutate({ name: 'rematch', body: { serverId: m.serverId, all: false } })}
                  >
                    {t('settings.jobs.rematchMissing')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="md:col-start-3 md:row-start-2"
                    disabled={run.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmRematchAll', { name: m.name }), destructive: true }))
                        run.mutate({ name: 'rematch', body: { serverId: m.serverId, all: true } })
                    }}
                  >
                    {t('settings.jobs.rematchAll')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {cacheModal && <CacheEntriesModal store={cacheModal} onClose={() => setCacheModal(null)} />}
      {matchModal && <MatchesModal stat={matchModal} onClose={() => setMatchModal(null)} />}
      {resetOpen && <ResetModal stores={stores} onClose={() => setResetOpen(false)} />}
    </>
  )
}

// Modal shell of this page: the design system's Dialog (native <dialog>, so
// focus trap, Escape and the backdrop guard come for free) with the fixed
// header / scrollable body / footer anatomy. Mount-to-open - the parent renders
// it conditionally and unmounts it on close.
function Modal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog onClose={onClose} width="max-w-2xl" aria-label={title}>
      <div className="dialog-body">
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="font-display font-semibold tracking-wider">{title}</h3>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
          <span>{footer}</span>
          <Button onClick={onClose}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}

function Pager({ offset, total, onOffset }: { offset: number; total: number; onOffset: (n: number) => void }) {
  const { t } = useTranslation()
  if (total <= PAGE && offset === 0) return null
  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <Button size="sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE))}>
        <ChevronLeft aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
        {t('settings.jobs.prev')}
      </Button>
      <span className="font-mono text-xs tabular-nums text-t-muted">
        {t('settings.jobs.pageInfo', {
          from: total === 0 ? 0 : offset + 1,
          to: Math.min(offset + PAGE, total),
          total,
        })}
      </span>
      <Button size="sm" disabled={offset + PAGE >= total} onClick={() => onOffset(offset + PAGE)}>
        {t('settings.jobs.next')}
        <ChevronRight aria-hidden size="1em" className="ml-1 inline align-[-0.125em]" />
      </Button>
    </div>
  )
}

// The key-level view of one cache store. Addressed by the short scope name the
// entry endpoints still use ("plex"), which is the store slug without its
// "cache:" prefix.
function CacheEntriesModal({ store, onClose }: { store: DataStore; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const dq = useDebounced(q, () => setOffset(0))
  const [error, setError] = useState('')
  const scope = store.name.replace(/^cache:/, '')
  const label = storeLabel(t, store.name)

  const { data } = useQuery<CacheEntriesResp>({
    queryKey: ['adminCacheEntries', scope, dq, offset],
    queryFn: () =>
      api.get(`/api/admin/cache/${scope}/entries?q=${encodeURIComponent(dq)}&offset=${offset}&limit=${PAGE}`),
  })
  const del = useMutation({
    mutationFn: (key: string) => api.del(`/api/admin/cache/${scope}/entries?key=${encodeURIComponent(key)}`),
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminCacheEntries', scope] })
      qc.invalidateQueries({ queryKey: ['adminData'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Modal title={t('settings.jobs.cacheEntriesTitle', { scope: label })} onClose={onClose}>
      <p className="mb-2 font-mono text-xs tabular-nums text-t-muted">
        {t('settings.jobs.oldest')}: {fmtTs(store.oldest)} · {t('settings.jobs.newest')}: {fmtTs(store.newest)} ·{' '}
        {t('settings.jobs.ttl')} {fmtTtl(store.ttlSec)}
      </p>
      <label className="sr-only" htmlFor="cache-entries-q">
        {t('remote.search')}
      </label>
      <Input
        id="cache-entries-q"
        placeholder={t('remote.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {data && data.entries.length === 0 ? (
        <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
      ) : (
        <ul className="mt-2">
          {(data?.entries ?? []).map((e) => (
            <li key={e.key} className={`${ROW_GRID} py-1.5`}>
              <span className={CELL_LEFT}>
                <span className="min-w-0 truncate font-mono text-xs text-t-secondary" title={e.key}>
                  {truncMiddle(e.key)}
                </span>
                {e.stale && <Badge tone="warn" className="shrink-0">{t('settings.jobs.staleBadge')}</Badge>}
              </span>
              <span className={CELL_RIGHT}>
                <span className={`whitespace-nowrap ${NUM}`}>{fmtTs(e.fetchedAt)}</span>
                <span className={`w-16 ${NUM}`}>{fmtBytes(e.bytes)}</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={del.isPending}
                  onClick={async () => {
                    if (await confirm({ message: t('settings.jobs.confirmDeleteEntry', { key: truncMiddle(e.key, 80) }), destructive: true }))
                      del.mutate(e.key)
                  }}
                >
                  <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('servers.delete')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pager offset={offset} total={data?.total ?? 0} onOffset={setOffset} />
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

// The "rebuild everything" dialog. It never asks a bare "are you sure": it
// names what goes, what stays and what runs afterwards, because the operator's
// complaint was that the existing buttons never said which of those they meant.
// Built on the page's Modal (a native <dialog>: focus trap, Escape, backdrop).
function ResetModal({ stores, onClose }: { stores: DataStore[]; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [includeDecisions, setIncludeDecisions] = useState(false)
  const [result, setResult] = useState<ResetResult | null>(null)
  const [error, setError] = useState('')

  // mirrors the server's rule exactly, so the preview cannot drift from the act
  const goes = (s: DataStore) => !s.keptOnReset || (s.kind === 'decision' && includeDecisions)
  const doomed = stores.filter(goes)
  const kept = stores.filter((s) => !goes(s))
  const doomedRows = doomed.reduce((n, s) => n + s.rows, 0)

  const reset = useMutation({
    mutationFn: () => api.post<ResetResult>('/api/admin/data/reset', { includeDecisions, requeue: true }),
    onSuccess: (res) => {
      setError('')
      setResult(res)
      // the numbers must fall immediately and then grow back while watching
      qc.invalidateQueries({ queryKey: ['adminData'] })
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const list = (items: DataStore[]) => (
    <ul className="mt-1 flex flex-wrap gap-1">
      {items.map((s) => (
        <li key={s.name}>
          <Badge tone={KIND_TONE[s.kind]} className="tabular-nums">
            {storeLabel(t, s.name)} · {fmtNum(s.rows)}
          </Badge>
        </li>
      ))}
    </ul>
  )

  return (
    <Modal
      title={t('settings.jobs.data.reset.title')}
      onClose={onClose}
      footer={
        result ? null : (
          <Button variant="danger" cut disabled={reset.isPending} onClick={() => reset.mutate()}>
            <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('settings.jobs.data.reset.confirm')}
          </Button>
        )
      }
    >
      {result ? (
        <div className="text-sm text-t-secondary">
          <p>{t('settings.jobs.data.reset.done', { n: fmtNum(Object.values(result.deleted).reduce((a, b) => a + b, 0)) })}</p>
          <p className="mt-2">{t('settings.jobs.data.reset.doneQueued', { n: fmtNum(result.queued) })}</p>
          <p className="mt-2 text-xs text-t-muted">
            {t('settings.jobs.data.reset.doneKept', {
              stores: result.kept.map((n) => storeLabel(t, n)).join(', '),
            })}
          </p>
        </div>
      ) : (
        <div className="text-sm text-t-secondary">
          <p>{t('settings.jobs.data.reset.intro')}</p>

          <h4 className="mt-4 font-display text-xs font-semibold uppercase tracking-wider text-t-primary">
            {t('settings.jobs.data.reset.willDelete', { count: doomedRows })}
          </h4>
          {list(doomed)}

          <h4 className="mt-4 font-display text-xs font-semibold uppercase tracking-wider text-t-primary">
            {t('settings.jobs.data.reset.willKeep')}
          </h4>
          {list(kept)}
          <p className="mt-1 text-xs text-t-muted">{t('settings.jobs.data.reset.keepIndexWhy')}</p>

          <h4 className="mt-4 font-display text-xs font-semibold uppercase tracking-wider text-t-primary">
            {t('settings.jobs.data.reset.willRun')}
          </h4>
          <p className="mt-1 text-xs text-t-muted">{t('settings.jobs.data.reset.willRunWhat')}</p>

          <div className="mt-4 border border-border-subtle bg-bg-secondary/40 p-3">
            <Checkbox
              checked={includeDecisions}
              onChange={(e) => setIncludeDecisions(e.target.checked)}
              label={t('settings.jobs.data.reset.includeDecisions')}
              labelClassName="text-t-primary"
            />
            <p className="mt-1 text-xs text-warn">{t('settings.jobs.data.reset.includeDecisionsCost')}</p>
          </div>

          <p className="mt-4 text-xs text-t-muted">{t('settings.jobs.data.reset.noBackup')}</p>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

type MatchFilter = 'all' | 'matched' | 'unmatched' | 'manual'
const MATCH_FILTERS: MatchFilter[] = ['all', 'matched', 'unmatched', 'manual']

function MatchesModal({ stat, onClose }: { stat: MatchStat; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<MatchFilter>('all')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const dq = useDebounced(q, () => setOffset(0))
  const [error, setError] = useState('')
  // correction flow: which folder is being corrected + its media search
  const [correcting, setCorrecting] = useState<MatchEntry | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [results, setResults] = useState<Media[]>([])
  const [picking, setPicking] = useState(false)
  const seq = useRef(0) // drop out-of-order search responses

  const { data } = useQuery<MatchesResp>({
    queryKey: ['adminMatches', stat.serverId, filter, dq, offset],
    queryFn: () =>
      api.get(
        `/api/admin/matches?serverId=${stat.serverId}&filter=${filter}&q=${encodeURIComponent(dq)}&offset=${offset}&limit=${PAGE}`,
      ),
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['adminMatches', stat.serverId] })
    qc.invalidateQueries({ queryKey: ['adminJobs'] })
  }
  const del = useMutation({
    mutationFn: (folder: string) =>
      api.del(`/api/admin/matches?serverId=${stat.serverId}&folder=${encodeURIComponent(folder)}`),
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e: Error) => setError(e.message),
  })

  // search follows the entry's metadata source, like Browser's RematchDialog
  const search = async (entry: MatchEntry) => {
    const mySeq = ++seq.current
    const kind = entry.source.startsWith('tmdb:') ? entry.source.slice(5) : ''
    try {
      const next = await api.get<Media[]>(
        kind
          ? `/api/tmdb/search?kind=${kind}&q=${encodeURIComponent(searchQ)}`
          : `/api/anilist/search?q=${encodeURIComponent(searchQ)}`,
      )
      if (mySeq === seq.current) setResults(next)
    } catch {
      if (mySeq === seq.current) setResults([])
    }
  }
  // live search: results update as you type (debounced) while correcting a match
  useEffect(() => {
    if (!correcting) return
    const id = setTimeout(() => void search(correcting), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, correcting])
  // sets manual=1 server-side; mediaId 0 = manual unmatch ("Kein Match")
  const pick = async (entry: MatchEntry, mediaId: number) => {
    setPicking(true)
    setError('')
    try {
      await api.put(`/api/servers/${stat.serverId}/catalog/match`, { folder: entry.folder, mediaId })
      setCorrecting(null)
      setResults([])
      invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setPicking(false)
    }
  }
  const startCorrect = (entry: MatchEntry) => {
    setCorrecting(entry)
    setSearchQ(cleanTitle(basename(entry.folder)))
    setResults([])
  }

  return (
    <Modal
      title={t('settings.jobs.matchesTitle', { name: stat.name })}
      onClose={onClose}
      footer={
        <Link className="text-xs text-accent underline-offset-2 hover:underline" to="/remote">
          {t('settings.jobs.openBrowser')}
        </Link>
      }
    >
      <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label={t('dash.filterStatus')}>
        {MATCH_FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'primary' : 'default'}
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f)
              setOffset(0)
            }}
          >
            {t(`settings.jobs.filter.${f}`)}
          </Button>
        ))}
      </div>
      <label className="sr-only" htmlFor="matches-q">
        {t('remote.search')}
      </label>
      <Input
        id="matches-q"
        placeholder={t('remote.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {data && data.entries.length === 0 ? (
        <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
      ) : (
        <ul className="mt-2">
          {(data?.entries ?? []).map((m) => (
            <li key={m.folder} className="border-b border-border-subtle py-1.5 text-sm">
              <div className={`${ROW_GRID} border-b-0`}>
                <span className={CELL_LEFT}>
                  <span className="min-w-0 truncate font-mono text-xs text-t-secondary" title={m.folder}>
                    {basename(m.folder)}
                  </span>
                  {!!m.manual && <Badge className="shrink-0">{t('settings.jobs.manualBadge')}</Badge>}
                </span>
                <span className={CELL_RIGHT}>
                  {m.mediaId ? (
                    <span className="min-w-0 max-w-56 truncate text-xs text-t-muted" title={m.title}>
                      {m.title}
                    </span>
                  ) : (
                    <Badge tone="warn" className="shrink-0">-</Badge>
                  )}
                  <Button
                    size="sm"
                    variant={correcting?.folder === m.folder ? 'primary' : 'default'}
                    aria-expanded={correcting?.folder === m.folder}
                    onClick={() => (correcting?.folder === m.folder ? setCorrecting(null) : startCorrect(m))}
                  >
                    <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('settings.jobs.correct')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={del.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmDeleteMatch', { name: basename(m.folder) }), destructive: true }))
                        del.mutate(m.folder)
                    }}
                  >
                    <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('servers.delete')}
                  </Button>
                </span>
              </div>
              {correcting?.folder === m.folder && (
                <div className="mt-2 border border-border-subtle bg-bg-secondary/40 p-2">
                  <div className="flex gap-2">
                    <label className="sr-only" htmlFor="correct-q">
                      {t('remote.search')}
                    </label>
                    <Input
                      id="correct-q"
                      value={searchQ}
                      placeholder={t('remote.search')}
                      onChange={(e) => setSearchQ(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && search(m)}
                    />
                    <Button size="sm" className="shrink-0" onClick={() => search(m)}>
                      <Search aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('remote.search')}
                    </Button>
                  </div>
                  {results.length > 0 && (
                    <ul className="mt-1 max-h-48 overflow-y-auto">
                      {results.map((r) => (
                        <li key={r.id}>
                          <button
                            className="flex w-full items-baseline gap-2 border-b border-border-subtle/50 px-2 py-1.5 text-left hover:bg-bg-hover"
                            disabled={picking}
                            onClick={() => pick(m, r.id)}
                          >
                            <span className="min-w-0 truncate text-sm">{r.title.romaji}</span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-t-muted">
                              {r.seasonYear} · {r.format}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex justify-between">
                    <Button size="sm" variant="danger" disabled={picking} onClick={() => pick(m, 0)}>
                      <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('settings.jobs.noMatch')}
                    </Button>
                    <Button size="sm" onClick={() => setCorrecting(null)}>
                      <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('servers.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager offset={offset} total={data?.total ?? 0} onOffset={setOffset} />
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
