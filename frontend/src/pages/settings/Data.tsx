import { RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Checkbox, Divider, Input, Panel } from '@weebsync/design-system'
import { api, fmtBytes } from '../../api'
import { useConfirm } from '../../components/confirm'
import LegacyImport from '../../components/LegacyImport'
import {
  CELL_LEFT,
  CELL_RIGHT,
  fmtNum,
  fmtTs,
  fmtTtl,
  KIND_TONE,
  Modal,
  NUM,
  NUMEDIT_GRID,
  NumEdit,
  PAGE,
  Pager,
  rebuildLabel,
  ROW_GRID,
  storeDesc,
  storeLabel,
  truncMiddle,
  TTL_DEFAULTS,
  useAdminData,
  useAdminJobs,
  useDebounced,
  type CacheEntriesResp,
  type DataStore,
  type ResetResult,
  type TtlConfig,
} from './maintenance'

// Caches and data: everything the app computes and can compute again, with
// the retention of the provider caches, the rebuild of everything, and the
// import of an older installation's data.
export default function Data() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [cacheModal, setCacheModal] = useState<DataStore | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const { data } = useAdminJobs()
  const { data: inventory } = useAdminData()

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
  const flush = useMutation({
    mutationFn: (name: string) => api.del(`/api/admin/data/${encodeURIComponent(name)}`),
    ...opts,
  })
  const setTtl = useMutation({
    mutationFn: (body: TtlConfig) => api.put('/api/admin/ttl', body),
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

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}
      {/* the three suggestion caches were three one-line panels; one panel,
          one row each, the same grid as every other row on the page */}
      <Panel as="section" id="caches" className="mb-4 p-5" aria-label={t('settings.jobs.caches')}>
        <Badge tone="accent">{t('settings.jobs.caches')}</Badge>
        <ul className="mt-2">
          <li className={`${ROW_GRID} gap-y-2 py-3`}>
            <span className={CELL_LEFT}>
              <span className="font-semibold text-t-primary">AniList</span>
              <span className="text-xs text-t-muted">{t('settings.jobs.accounts', { count: data.anilist.accounts })}</span>
            </span>
            <span className={CELL_RIGHT}>
              <Button
                size="sm"
                disabled={data.anilist.accounts === 0 || run.isPending}
                onClick={() => run.mutate({ name: 'anilist-suggestions' })}
              >
                {t('settings.jobs.rebuildSuggestions')}
              </Button>
              {ttlEdit('anilistH', 'ttl-anilist')}
            </span>
          </li>
          <li className={`${ROW_GRID} gap-y-2 py-3`}>
            <span className={CELL_LEFT}>
              <span className="font-semibold text-t-primary">TMDB</span>
            </span>
            <span className={CELL_RIGHT}>{ttlEdit('tmdbH', 'ttl-tmdb')}</span>
          </li>
          <li className={`${ROW_GRID} gap-y-2 py-3`}>
            <span className={CELL_LEFT}>
              <span className="font-semibold text-t-primary">{t('settings.plex')}</span>
              <Badge tone={data.plex.configured ? 'ok' : 'neutral'} className="shrink-0">
                {data.plex.configured ? t('settings.jobs.configured') : t('settings.jobs.notConfigured')}
              </Badge>
              <span className="font-mono text-xs tabular-nums text-t-muted">
                {t('settings.jobs.suggestionsBuilt')}: {fmtTs(data.plex.suggestionsAt)}
              </span>
            </span>
            <span className={CELL_RIGHT}>
              <Button
                size="sm"
                disabled={!data.plex.configured || run.isPending}
                onClick={() => run.mutate({ name: 'plex-suggestions' })}
              >
                {t('settings.jobs.rebuild')}
              </Button>
              {ttlEdit('plexH', 'ttl-plex')}
            </span>
          </li>
        </ul>
      </Panel>

      {/* The inventory: everything the app can rebuild, in one list. Before it
          existed only the AniList cache was reachable from here, so a wrongly
          folded series identity survived every reset the page offered. */}
      <Panel as="section" id="data" className="mb-4 p-5" aria-label={t('settings.jobs.data.title')}>
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

      {cacheModal && <CacheEntriesModal store={cacheModal} onClose={() => setCacheModal(null)} />}
      {resetOpen && <ResetModal stores={stores} onClose={() => setResetOpen(false)} />}
      <section id="import" className="space-y-4" aria-label={t('legacy.title')}>
        <Divider label={t('legacy.title')} />
        <p className="text-xs text-t-muted">{t('legacy.sub')}</p>
        <LegacyImport />
      </section>
    </>
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
          <Button variant="danger" disabled={reset.isPending} onClick={() => reset.mutate()}>
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

          <div className="mt-4 rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
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
