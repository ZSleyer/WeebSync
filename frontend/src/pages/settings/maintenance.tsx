import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Input } from '@weebsync/design-system'
import { api } from '../../api'
import i18n from '../../locales'

// What the three maintenance sections share: the admin endpoints' contract,
// the row geometry, the number editor, the paged modal shell.

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
export const ROW_GRID =
  'grid grid-cols-[minmax(10rem,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border-subtle text-sm'
export const CELL_LEFT = 'col-span-full flex min-w-0 flex-wrap items-center gap-2 md:col-span-1'
export const CELL_RIGHT = 'col-span-full flex flex-wrap items-center justify-end gap-2 md:col-span-1 md:justify-self-end'
export const NUM = 'text-right font-mono text-xs tabular-nums text-t-muted'
export const NUMEDIT_GRID = 'grid grid-cols-[auto_5rem] items-center gap-x-2 gap-y-1'
// extra utilities handed to <Badge>, which supplies the chip base itself
export const COUNT_BADGE = 'min-h-6 min-w-28 shrink-0 justify-center px-2.5 tabular-nums [@media(pointer:coarse)]:min-h-8'

// Pinned contract with the admin endpoints (Workstream A) - keep in sync.

// One rebuildable body of data, as /api/admin/data reports it. The backend
// sends slugs only; every word on screen comes from settings.jobs.data.* here,
// so the page stays bilingual.
export type StoreKind = 'cache' | 'derived' | 'decision'

export interface DataStore {
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

export interface AdminData {
  stores: DataStore[]
}

export interface ResetResult {
  deleted: Record<string, number>
  kept: string[]
  queued: number
}

export interface IndexServer {
  id: number
  name: string
  rows: number
  dirs: number
  pendingDirs: number
  stalestListedAt: string
  intervalMin?: number // crawler tick, 0/absent = default
  batch?: number // dirs per tick, 0/absent = default
}

export interface MatchStat {
  serverId: number
  name: string
  source: string
  total: number
  matched: number
  unmatched: number
  manual: number
}

export interface TtlConfig {
  anilistH: number
  tmdbH: number
  plexH: number
}

export interface AdminJobs {
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

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

export interface LogLine {
  ts: string
  level: LogLevel
  msg: string
  attrs?: Record<string, unknown>
}

export const LOG_COLOR: Record<LogLevel, string> = {
  trace: 'text-t-muted',
  debug: 'text-t-secondary',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-err',
}

export interface CacheEntry {
  key: string
  fetchedAt: string
  stale: boolean
  bytes: number
}

export interface CacheEntriesResp {
  total: number
  entries: CacheEntry[]
}

export interface MatchEntry {
  folder: string
  mediaId: number
  manual: boolean | number
  source: string // "anilist" | "tmdb:tv" | "tmdb:movie"
  title: string
}

export interface MatchesResp {
  total: number
  entries: MatchEntry[]
}

export const PAGE = 50
export const TTL_DEFAULTS: TtlConfig = { anilistH: 24, tmdbH: 24, plexH: 6 }
export const INDEX_DEFAULTS = { intervalMin: 5, batch: 20 }

export const KIND_TONE: Record<StoreKind, 'neutral' | 'accent' | 'warn'> = {
  cache: 'neutral',
  derived: 'accent',
  decision: 'warn', // the one kind nothing rebuilds - the badge says so
}

// Store slugs carry a colon ("cache:plex"), which i18next reads as a namespace
// separator. Swapping it for a dot nests the texts instead, so the locale files
// group the cache scopes under one object.
export const storeKey = (name: string) => name.replace(':', '.')

export type TFunc = (key: string, opts?: Record<string, unknown>) => string

export const storeLabel = (t: TFunc, name: string) =>
  t(`settings.jobs.data.stores.${storeKey(name)}.name`, { defaultValue: name })
export const storeDesc = (t: TFunc, name: string) =>
  t(`settings.jobs.data.stores.${storeKey(name)}.desc`, { defaultValue: '' })
// "" from the backend means nothing schedules this - it refills when something
// needs it, which is worth saying out loud rather than leaving blank.
export const rebuildLabel = (t: TFunc, slug: string) =>
  slug ? t(`settings.jobs.data.rebuild.${slug}`, { defaultValue: slug }) : t('settings.jobs.data.rebuild.onDemand')

// SQLite stores UTC without a timezone marker - tack on Z for local display.
// Dates and numbers follow the app language, not the browser locale, so the
// page stays consistent when UI language and OS locale differ.
export function fmtTs(s: string): string {
  if (!s) return '-'
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(i18n.language)
}

// The log bus stamps RFC3339 in UTC, so cutting the time out of the string
// showed UTC rather than the viewer's clock - two hours off in CEST. Same rule
// as fmtTs: parse, then render in the app language.
export function fmtLogTime(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s.slice(11, 19) : d.toLocaleTimeString(i18n.language, { hour12: false })
}

export function fmtNum(n: number): string {
  return n.toLocaleString(i18n.language)
}

export function fmtTtl(sec: number): string {
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`
  if (sec >= 60) return `${Math.round(sec / 60)}min`
  return `${sec}s`
}

// CSS can only truncate at the end; cache keys carry their signal at both ends.
export function truncMiddle(s: string, max = 48): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2) - 1
  return `${s.slice(0, half)}…${s.slice(-half)}`
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// Release-style folder names carry bracket/paren tags ("Title S1 [JapDub,CR]")
// that make metadata searches miss - strip them for the search prefill.
export function cleanTitle(name: string): string {
  const cleaned = name
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || name
}

// Debounced copy of a string; onSettle fires alongside (used to reset paging).
export function useDebounced(value: string, onSettle: () => void): string {
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
export function NumEdit({
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

// The two admin readings every maintenance section polls: the job/index/match
// state and the data inventory. Same 5s beat, so a running rebuild is watchable.
export function useAdminJobs() {
  return useQuery<AdminJobs>({
    queryKey: ['adminJobs'],
    queryFn: () => api.get('/api/admin/jobs'),
    refetchInterval: 5000,
  })
}

export function useAdminData() {
  return useQuery<AdminData>({
    queryKey: ['adminData'],
    queryFn: () => api.get('/api/admin/data'),
    refetchInterval: 5000,
  })
}

// Modal shell of this page: the design system's Dialog (native <dialog>, so
// focus trap, Escape and the backdrop guard come for free) with the fixed
// header / scrollable body / footer anatomy. Mount-to-open - the parent renders
// it conditionally and unmounts it on close.
export function Modal({
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

export function Pager({ offset, total, onOffset }: { offset: number; total: number; onOffset: (n: number) => void }) {
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

// The inventory, grouped for reading: first by kind (what a store is and
// whether anything rebuilds it), the caches once more by the provider they
// mirror, since retention is set per provider. Sums per group so a folded
// group still tells its size and how much of it has gone stale.
export type Provider = 'anilist' | 'tmdb' | 'tvdb' | 'plex' | 'other'
const PROVIDERS: Provider[] = ['anilist', 'tmdb', 'tvdb', 'plex', 'other']
const KINDS: StoreKind[] = ['cache', 'derived', 'decision']

export interface StoreSum {
  stores: DataStore[]
  rows: number
  bytes: number
  stale: number
}
export interface ProviderGroup extends StoreSum {
  provider: Provider
}
export interface KindGroup extends StoreSum {
  kind: StoreKind
  providers?: ProviderGroup[]
}

export function providerOf(name: string): Provider {
  const head = name.replace(/^cache:/, '').split('-')[0]
  return (PROVIDERS as string[]).includes(head) && head !== 'other' ? (head as Provider) : 'other'
}

const sumOf = (stores: DataStore[]): StoreSum => ({
  stores,
  rows: stores.reduce((n, s) => n + s.rows, 0),
  bytes: stores.reduce((n, s) => n + s.bytes, 0),
  stale: stores.reduce((n, s) => n + s.stale, 0),
})

export function groupStores(stores: DataStore[]): KindGroup[] {
  return KINDS.flatMap((kind) => {
    const own = stores.filter((s) => s.kind === kind)
    if (own.length === 0) return []
    const group: KindGroup = { kind, ...sumOf(own) }
    if (kind === 'cache') {
      group.providers = PROVIDERS.flatMap((provider) => {
        const theirs = own.filter((s) => providerOf(s.name) === provider)
        return theirs.length ? [{ provider, ...sumOf(theirs) }] : []
      })
    }
    return [group]
  })
}
