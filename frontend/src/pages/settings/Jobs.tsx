import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, fmtBytes, type Media } from '../../api'
import { useConfirm } from '../../components/confirm'
import i18n from '../../locales'

/* Uniformity rules for this page (user requirement: identical elements must
   always align vertically across rows/panels):
   - every row is a two-cell grid `ROW_GRID`: name cell left, one right-anchored
     cell (justify-self-end) that owns the row's right edge — no ad-hoc margins.
     Below md both cells span the full width and stack; the right cell stays
     right-anchored, so stats/buttons keep identical x positions across rows.
     The label track has a hard 10rem minimum and side-by-side layout only
     starts at md — a label must never render narrower than readable; when
     space runs out the row stacks instead.
   - all numbers render font-mono tabular-nums; stat columns have fixed widths.
   - count badges (matched/unmatched) share a fixed min-width so the pair
     columnizes across rows, and match t-btn--sm height (24px, 32px on touch)
     so badge rows and button rows read as one system.
   - every NumEdit input is w-20 h-6 (t-btn--sm height) with the unit folded
     into the label ("TTL (h)") — nothing ever renders to the right of an
     input, keeping edges flush. */
const ROW_GRID =
  'grid grid-cols-[minmax(10rem,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border-subtle text-sm'
const CELL_LEFT = 'col-span-full flex min-w-0 flex-wrap items-center gap-2 md:col-span-1'
const CELL_RIGHT = 'col-span-full flex flex-wrap items-center justify-end gap-2 md:col-span-1 md:justify-self-end'
const NUM = 'text-right font-mono text-xs tabular-nums text-t-muted'
const NUMEDIT_GRID = 'grid grid-cols-[auto_5rem] items-center gap-x-2 gap-y-1'
const COUNT_BADGE =
  't-label min-h-6 min-w-28 shrink-0 justify-center px-2.5 tabular-nums [@media(pointer:coarse)]:min-h-8'

// Pinned contract with the admin endpoints (Workstream A) — keep in sync.
interface CacheInfo {
  scope: string
  count: number
  oldest: string // SQLite UTC "2026-07-15 20:32:40", may be ""
  newest: string
  ttlSec: number
  stale: number
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
  caches: CacheInfo[]
  plex: { configured: boolean; suggestionsAt: string; ttlSec: number }
  anilist: { accounts: number }
  index: { tickSec: number; recheckSec: number; servers: IndexServer[] }
  watch: { intervalMin: number; count: number }
  matches: MatchStat[]
  ttl?: TtlConfig // arriving with the config workstream; fall back to defaults
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

// SQLite stores UTC without a timezone marker — tack on Z for local display.
// Dates and numbers follow the app language, not the browser locale, so the
// page stays consistent when UI language and OS locale differ.
function fmtTs(s: string): string {
  if (!s) return '—'
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(i18n.language)
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
// that make metadata searches miss — strip them for the search prefill.
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
      <input
        id={id}
        key={value}
        className="t-input h-6 w-20 px-2 py-1 text-right font-mono text-xs tabular-nums"
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
  const [cacheModal, setCacheModal] = useState<CacheInfo | null>(null)
  const [matchModal, setMatchModal] = useState<MatchStat | null>(null)
  const { data } = useQuery<AdminJobs>({
    queryKey: ['adminJobs'],
    queryFn: () => api.get('/api/admin/jobs'),
    refetchInterval: 5000,
  })

  const opts = {
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
    },
    onError: (e: Error) => setError(e.message),
  }
  const run = useMutation({
    mutationFn: ({ name, body }: { name: string; body?: unknown }) => api.post(`/api/admin/jobs/${name}/run`, body),
    ...opts,
  })
  const flush = useMutation({
    mutationFn: (scope: string) => api.del(`/api/admin/cache/${scope}`),
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
  const scopeLabel = (scope: string) => t(`settings.jobs.scopes.${scope}`, { defaultValue: scope })
  const cacheRow = (c: CacheInfo) => (
    <li key={c.scope} className={`${ROW_GRID} py-1.5`}>
      {/* stale badge lives in the label cell so rows with and without it
          keep identical stat/button geometry */}
      <span className={CELL_LEFT}>
        <span className="min-w-0 truncate text-t-secondary">{scopeLabel(c.scope)}</span>
        {c.stale > 0 && (
          <span className="t-label t-label--warn shrink-0 tabular-nums">
            {t('settings.jobs.stale', { count: c.stale })}
          </span>
        )}
      </span>
      <span className={CELL_RIGHT}>
        <span className={`w-16 ${NUM}`}>{fmtNum(c.count)}</span>
        <span className={`w-12 ${NUM}`}>{fmtTtl(c.ttlSec)}</span>
        <button className="t-btn t-btn--sm" onClick={() => setCacheModal(c)}>
          {t('settings.jobs.view')}
        </button>
        <button
          className="t-btn t-btn--sm t-btn--danger"
          disabled={flush.isPending}
          onClick={async () => {
            if (await confirm({ message: t('settings.jobs.confirmFlush', { scope: scopeLabel(c.scope) }), destructive: true }))
              flush.mutate(c.scope)
          }}
        >
          {t('settings.jobs.flush')}
        </button>
      </span>
    </li>
  )
  const cacheList = (caches: CacheInfo[]) =>
    caches.length === 0 ? (
      <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
    ) : (
      <ul className="mt-2">{caches.map(cacheRow)}</ul>
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

  const anilistCaches = data.caches.filter((c) => c.scope.startsWith('anilist-'))
  const tmdbCaches = data.caches.filter((c) => c.scope.startsWith('tmdb-'))
  const plexCaches = data.caches.filter((c) => c.scope === 'plex')
  const idle = data.running.length === 0

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}

      <section className="t-panel mb-4 p-5" aria-label={t('settings.jobs.activity')}>
        <span className="t-label t-label--accent">{t('settings.jobs.activity')}</span>
        <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.hint')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {idle && <span className="t-label t-label--ok">{t('settings.jobs.idle')}</span>}
          {data.running.map((job) => (
            <span key={job} className="t-label font-mono">
              {job}
            </span>
          ))}
          {data.matchQueue > 0 && (
            <span className="t-label t-label--warn tabular-nums">
              {t('settings.jobs.queue', { count: data.matchQueue })}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-t-muted">
          {t('settings.jobs.watchSummary', { count: data.watch.count, min: data.watch.intervalMin })}
        </p>
      </section>

      <section className="t-panel mb-4 p-5" aria-label={t('settings.jobs.anilistCaches')}>
        <span className="t-label t-label--accent">{t('settings.jobs.anilistCaches')}</span>
        {/* header rhythm shared by all cache panels: info line, then one
            control row with buttons left and the TTL group right */}
        <p className="mt-3 text-xs text-t-muted">{t('settings.jobs.accounts', { count: data.anilist.accounts })}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            className="t-btn t-btn--sm"
            disabled={data.anilist.accounts === 0 || run.isPending}
            onClick={() => run.mutate({ name: 'anilist-suggestions' })}
          >
            {t('settings.jobs.rebuildSuggestions')}
          </button>
          {ttlEdit('anilistH', 'ttl-anilist')}
        </div>
        {cacheList(anilistCaches)}
      </section>

      <section className="t-panel mb-4 p-5" aria-label={t('settings.jobs.tmdbCaches')}>
        <span className="t-label t-label--accent">{t('settings.jobs.tmdbCaches')}</span>
        <div className="mt-3 flex flex-wrap items-center gap-2">{ttlEdit('tmdbH', 'ttl-tmdb')}</div>
        {cacheList(tmdbCaches)}
      </section>

      <section className="t-panel mb-4 p-5" aria-label={t('settings.plex')}>
        <span className="t-label t-label--accent">{t('settings.plex')}</span>
        {/* info line: status + last build; control row: button left, TTL right */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`t-label ${data.plex.configured ? 't-label--ok' : ''}`}>
            {data.plex.configured ? t('settings.jobs.configured') : t('settings.jobs.notConfigured')}
          </span>
          <span className="font-mono text-xs tabular-nums text-t-muted">
            {t('settings.jobs.suggestionsBuilt')}: {fmtTs(data.plex.suggestionsAt)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            className="t-btn t-btn--sm"
            disabled={!data.plex.configured || run.isPending}
            onClick={() => run.mutate({ name: 'plex-suggestions' })}
          >
            {t('settings.jobs.rebuild')}
          </button>
          {ttlEdit('plexH', 'ttl-plex')}
        </div>
        {cacheList(plexCaches)}
      </section>

      <section className="t-panel mb-4 p-5" aria-label={t('settings.jobs.remoteIndex')}>
        <span className="t-label t-label--accent">{t('settings.jobs.remoteIndex')}</span>
        {data.index.servers.length === 0 ? (
          <p className="mt-3 text-sm text-t-secondary">{t('settings.jobs.empty')}</p>
        ) : (
          <ul className="mt-2">
            {/* one delimited block per server: name/stats line, config/actions
                line — same grid geometry as every other row on the page */}
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
                    <span className="t-label t-label--warn shrink-0 tabular-nums">
                      {t('settings.jobs.pending', { count: s.pendingDirs })}
                    </span>
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
                    share its 24px control height — anchored to the input grid,
                    not floating vertically centered beside it */}
                <span className={`${CELL_RIGHT} md:self-start`}>
                  <button
                    className="t-btn t-btn--sm flex-1 md:flex-none"
                    disabled={run.isPending}
                    onClick={() => run.mutate({ name: 'index-crawl', body: { serverId: s.id } })}
                  >
                    {t('settings.jobs.crawlNow')}
                  </button>
                  <button
                    className="t-btn t-btn--sm t-btn--danger flex-1 md:flex-none"
                    disabled={flushIndex.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmFlushIndex', { name: s.name }), destructive: true }))
                        flushIndex.mutate(s.id)
                    }}
                  >
                    {t('settings.jobs.flushIndex')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-t-muted">
          {t('settings.jobs.indexHint', { min: Math.max(1, Math.round(data.index.tickSec / 60)) })}
        </p>
      </section>

      <section className="t-panel mb-4 p-5" aria-label={t('settings.jobs.matchQuality')}>
        <span className="t-label t-label--accent">{t('settings.jobs.matchQuality')}</span>
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
                  <span className="t-label shrink-0">{m.source}</span>
                </span>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[auto_auto_auto] md:justify-end">
                  <span className={`${COUNT_BADGE} t-label--ok md:col-start-2 md:row-start-1`}>
                    {t('settings.jobs.matched', { n: fmtNum(m.matched) })}
                  </span>
                  <span
                    className={`${COUNT_BADGE} ${m.unmatched > 0 ? 't-label--warn' : ''} md:col-start-3 md:row-start-1`}
                  >
                    {t('settings.jobs.unmatched', { n: fmtNum(m.unmatched) })}
                  </span>
                  <button
                    className="t-btn t-btn--sm md:col-start-1 md:row-start-2"
                    onClick={() => setMatchModal(m)}
                  >
                    {t('settings.jobs.view')}
                  </button>
                  <button
                    className="t-btn t-btn--sm md:col-start-2 md:row-start-2"
                    disabled={run.isPending}
                    onClick={() => run.mutate({ name: 'rematch', body: { serverId: m.serverId, all: false } })}
                  >
                    {t('settings.jobs.rematchMissing')}
                  </button>
                  <button
                    className="t-btn t-btn--sm t-btn--danger md:col-start-3 md:row-start-2"
                    disabled={run.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmRematchAll', { name: m.name }), destructive: true }))
                        run.mutate({ name: 'rematch', body: { serverId: m.serverId, all: true } })
                    }}
                  >
                    {t('settings.jobs.rematchAll')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {cacheModal && <CacheEntriesModal cache={cacheModal} onClose={() => setCacheModal(null)} />}
      {matchModal && <MatchesModal stat={matchModal} onClose={() => setMatchModal(null)} />}
    </>
  )
}

// Lightweight modal shell in the WatchDialog anatomy: native <dialog>
// (focus trap + Escape for free, global CSS handles mobile sizing),
// fixed header, scrollable body, footer.
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
  const ref = useRef<HTMLDialogElement>(null)
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="w-full max-w-2xl p-0"
      aria-label={title}
      onClose={onClose}
      onPointerDown={(e) => (backdropDown.current = e.target === ref.current)}
      onClick={(e) => e.target === ref.current && backdropDown.current && ref.current?.close()}
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="font-display font-semibold tracking-wider">{title}</h3>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
          <span>{footer}</span>
          <button className="t-btn" onClick={() => ref.current?.close()}>
            {t('browser.close')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

function Pager({ offset, total, onOffset }: { offset: number; total: number; onOffset: (n: number) => void }) {
  const { t } = useTranslation()
  if (total <= PAGE && offset === 0) return null
  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <button className="t-btn t-btn--sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE))}>
        {t('settings.jobs.prev')}
      </button>
      <span className="font-mono text-xs tabular-nums text-t-muted">
        {t('settings.jobs.pageInfo', {
          from: total === 0 ? 0 : offset + 1,
          to: Math.min(offset + PAGE, total),
          total,
        })}
      </span>
      <button className="t-btn t-btn--sm" disabled={offset + PAGE >= total} onClick={() => onOffset(offset + PAGE)}>
        {t('settings.jobs.next')}
      </button>
    </div>
  )
}

function CacheEntriesModal({ cache, onClose }: { cache: CacheInfo; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const dq = useDebounced(q, () => setOffset(0))
  const [error, setError] = useState('')
  const scopeLabel = t(`settings.jobs.scopes.${cache.scope}`, { defaultValue: cache.scope })

  const { data } = useQuery<CacheEntriesResp>({
    queryKey: ['adminCacheEntries', cache.scope, dq, offset],
    queryFn: () =>
      api.get(`/api/admin/cache/${cache.scope}/entries?q=${encodeURIComponent(dq)}&offset=${offset}&limit=${PAGE}`),
  })
  const del = useMutation({
    mutationFn: (key: string) => api.del(`/api/admin/cache/${cache.scope}/entries?key=${encodeURIComponent(key)}`),
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminCacheEntries', cache.scope] })
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Modal title={t('settings.jobs.cacheEntriesTitle', { scope: scopeLabel })} onClose={onClose}>
      <p className="mb-2 font-mono text-xs tabular-nums text-t-muted">
        {t('settings.jobs.oldest')}: {fmtTs(cache.oldest)} · {t('settings.jobs.newest')}: {fmtTs(cache.newest)} ·{' '}
        {t('settings.jobs.ttl')} {fmtTtl(cache.ttlSec)}
      </p>
      <label className="sr-only" htmlFor="cache-entries-q">
        {t('browser.search')}
      </label>
      <input
        id="cache-entries-q"
        className="t-input"
        placeholder={t('browser.search')}
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
                {e.stale && <span className="t-label t-label--warn shrink-0">{t('settings.jobs.staleBadge')}</span>}
              </span>
              <span className={CELL_RIGHT}>
                <span className={`whitespace-nowrap ${NUM}`}>{fmtTs(e.fetchedAt)}</span>
                <span className={`w-16 ${NUM}`}>{fmtBytes(e.bytes)}</span>
                <button
                  className="t-btn t-btn--sm t-btn--danger"
                  disabled={del.isPending}
                  onClick={async () => {
                    if (await confirm({ message: t('settings.jobs.confirmDeleteEntry', { key: truncMiddle(e.key, 80) }), destructive: true }))
                      del.mutate(e.key)
                  }}
                >
                  {t('servers.delete')}
                </button>
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
        <Link className="text-xs text-accent underline-offset-2 hover:underline" to="/browser">
          {t('settings.jobs.openBrowser')}
        </Link>
      }
    >
      <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label={t('dash.filterStatus')}>
        {MATCH_FILTERS.map((f) => (
          <button
            key={f}
            className={`t-btn t-btn--sm ${filter === f ? 't-btn--primary' : ''}`}
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f)
              setOffset(0)
            }}
          >
            {t(`settings.jobs.filter.${f}`)}
          </button>
        ))}
      </div>
      <label className="sr-only" htmlFor="matches-q">
        {t('browser.search')}
      </label>
      <input
        id="matches-q"
        className="t-input"
        placeholder={t('browser.search')}
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
                  {!!m.manual && <span className="t-label shrink-0">{t('settings.jobs.manualBadge')}</span>}
                </span>
                <span className={CELL_RIGHT}>
                  {m.mediaId ? (
                    <span className="min-w-0 max-w-56 truncate text-xs text-t-muted" title={m.title}>
                      {m.title}
                    </span>
                  ) : (
                    <span className="t-label t-label--warn shrink-0">—</span>
                  )}
                  <button
                    className={`t-btn t-btn--sm ${correcting?.folder === m.folder ? 't-btn--primary' : ''}`}
                    aria-expanded={correcting?.folder === m.folder}
                    onClick={() => (correcting?.folder === m.folder ? setCorrecting(null) : startCorrect(m))}
                  >
                    {t('settings.jobs.correct')}
                  </button>
                  <button
                    className="t-btn t-btn--sm t-btn--danger"
                    disabled={del.isPending}
                    onClick={async () => {
                      if (await confirm({ message: t('settings.jobs.confirmDeleteMatch', { name: basename(m.folder) }), destructive: true }))
                        del.mutate(m.folder)
                    }}
                  >
                    {t('servers.delete')}
                  </button>
                </span>
              </div>
              {correcting?.folder === m.folder && (
                <div className="mt-2 border border-border-subtle bg-bg-secondary/40 p-2">
                  <div className="flex gap-2">
                    <label className="sr-only" htmlFor="correct-q">
                      {t('browser.search')}
                    </label>
                    <input
                      id="correct-q"
                      className="t-input"
                      value={searchQ}
                      placeholder={t('browser.search')}
                      onChange={(e) => setSearchQ(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && search(m)}
                    />
                    <button className="t-btn t-btn--sm shrink-0" onClick={() => search(m)}>
                      {t('browser.search')}
                    </button>
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
                    <button className="t-btn t-btn--sm t-btn--danger" disabled={picking} onClick={() => pick(m, 0)}>
                      {t('settings.jobs.noMatch')}
                    </button>
                    <button className="t-btn t-btn--sm" onClick={() => setCorrecting(null)}>
                      {t('servers.cancel')}
                    </button>
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
