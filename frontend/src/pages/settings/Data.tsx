import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Checkbox, Count, Disclosure, Divider, Input, Panel } from '@weebsync/design-system'
import { api, fmtBytes } from '../../api'
import { useConfirm } from '../../components/confirm'
import LegacyImport from '../../components/LegacyImport'
import {
  CELL_LEFT,
  CELL_RIGHT,
  fmtNum,
  fmtTs,
  fmtTtl,
  groupStores,
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
  type Provider,
  type ResetResult,
  type StoreSum,
  type TtlConfig,
} from './maintenance'

// Caches and data: everything the app computes and can compute again. Three
// groups by kind, the caches once more by provider with that provider's
// retention. A row is one line and opens the store's dialog, which holds
// the description, the numbers, the entries and the one destructive action.
// The rebuild of everything sits apart at the bottom, then the import.
export default function Data() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [storeModal, setStoreModal] = useState<DataStore | null>(null)
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
  const setTtl = useMutation({
    mutationFn: (body: TtlConfig) => api.put('/api/admin/ttl', body),
    ...opts,
  })

  if (!data) return null

  const ttl = data.ttl ?? TTL_DEFAULTS
  const commitTtl = (patch: Partial<TtlConfig>) => setTtl.mutate({ ...ttl, ...patch })
  const ttlEdit = (key: keyof TtlConfig, id: string) => (
    <span className={NUMEDIT_GRID}>
      <NumEdit id={id} label={t('settings.jobs.ttlH')} value={ttl[key]} onCommit={(n) => commitTtl({ [key]: n })} />
    </span>
  )
  // what a provider brings besides its stores: the retention of its cache,
  // and the rebuild where one exists
  const providerTools = (p: Provider) => {
    switch (p) {
      case 'anilist':
        return (
          <>
            <span className="text-xs text-t-muted">{t('settings.jobs.accounts', { count: data.anilist.accounts })}</span>
            <Button
              size="sm"
              disabled={data.anilist.accounts === 0 || run.isPending}
              onClick={() => run.mutate({ name: 'anilist-suggestions' })}
            >
              {t('settings.jobs.rebuildSuggestions')}
            </Button>
            {ttlEdit('anilistH', 'ttl-anilist')}
          </>
        )
      case 'tmdb':
        return ttlEdit('tmdbH', 'ttl-tmdb')
      case 'plex':
        return (
          <>
            <Badge tone={data.plex.configured ? 'ok' : 'neutral'} className="shrink-0">
              {data.plex.configured ? t('settings.jobs.configured') : t('settings.jobs.notConfigured')}
            </Badge>
            <span className="font-mono text-xs tabular-nums text-t-muted">
              {t('settings.jobs.suggestionsBuilt')}: {fmtTs(data.plex.suggestionsAt)}
            </span>
            <Button
              size="sm"
              disabled={!data.plex.configured || run.isPending}
              onClick={() => run.mutate({ name: 'plex-suggestions' })}
            >
              {t('settings.jobs.rebuild')}
            </Button>
            {ttlEdit('plexH', 'ttl-plex')}
          </>
        )
      default:
        return null
    }
  }

  const stores = inventory?.stores ?? []
  const groups = groupStores(stores)

  const sums = (g: StoreSum, cache: boolean) => (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-t-muted">
      <span>{t('settings.jobs.data.rowCount', { n: fmtNum(g.rows) })}</span>
      {cache && g.bytes > 0 && <span>{fmtBytes(g.bytes)}</span>}
    </span>
  )
  // two numbers: stale rows are still served while their refetch runs,
  // prunable ones are dead weight the sweep will drop
  const staleBadge = (n: number, prunable = 0) =>
    n > 0 || prunable > 0 ? (
      <>
        {n > 0 && (
          <Badge tone="warn" className="shrink-0 tabular-nums">
            {t('settings.jobs.stale', { count: n })}
          </Badge>
        )}
        {prunable > 0 && (
          <Badge tone="neutral" className="shrink-0 tabular-nums">
            {t('settings.jobs.prunable', { count: prunable })}
          </Badge>
        )}
      </>
    ) : null

  // one line per store, a button: the numbers that matter at a glance, the
  // rest behind it. Tall enough for a thumb.
  const storeRow = (s: DataStore) => (
    <li key={s.name}>
      <button
        type="button"
        onClick={() => setStoreModal(s)}
        className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-b border-border-subtle px-1 text-left text-sm transition-colors hover:bg-bg-hover"
      >
        <span className="min-w-0 flex-1 break-words font-semibold text-t-primary">{storeLabel(t, s.name)}</span>
        {staleBadge(s.stale, s.prunable)}
        <Count className="shrink-0">{fmtNum(s.rows)}</Count>
        <ChevronRight aria-hidden size="1em" className="shrink-0 text-t-faint" />
      </button>
    </li>
  )

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}
      <p className="mb-4 text-xs text-t-muted">{t('settings.jobs.data.hint')}</p>

      {stores.length === 0 ? (
        <Panel className="mb-4 p-5 text-sm text-t-secondary">{t('settings.jobs.empty')}</Panel>
      ) : (
        groups.map((g) => (
          <Panel as="section" key={g.kind} className="mb-4 p-5" aria-label={t(`settings.jobs.data.kindTitle.${g.kind}`)}>
            <Disclosure
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{t(`settings.jobs.data.kindTitle.${g.kind}`)}</span>
                  {staleBadge(g.stale, g.prunable)}
                </span>
              }
              count={g.stores.length}
              defaultOpen={g.kind === 'cache'}
            >
              <p className="text-xs text-t-muted">{t(`settings.jobs.data.kindHint.${g.kind}`)}</p>
              {g.providers ? (
                g.providers.map((p) => (
                  <div key={p.provider} className="mt-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle pb-2">
                      <span className="font-semibold text-t-primary">{t(`settings.jobs.data.providers.${p.provider}`)}</span>
                      {sums(p, true)}
                      <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:justify-end">{providerTools(p.provider)}</span>
                    </div>
                    <ul>{p.stores.map(storeRow)}</ul>
                  </div>
                ))
              ) : (
                <>
                  <div className="mt-2">{sums(g, false)}</div>
                  <ul className="mt-2 border-t border-border-subtle">{g.stores.map(storeRow)}</ul>
                </>
              )}
            </Disclosure>
          </Panel>
        ))
      )}

      <Panel danger as="section" className="mb-4 p-5" aria-label={t('settings.jobs.data.reset.title')}>
        <Badge tone="err">{t('settings.jobs.data.reset.title')}</Badge>
        <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.data.dangerHint')}</p>
        <Button size="sm" variant="danger" className="mt-3" disabled={stores.length === 0} onClick={() => setResetOpen(true)}>
          <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('settings.jobs.data.reset.button')}
        </Button>
      </Panel>

      {storeModal && <StoreModal store={storeModal} onClose={() => setStoreModal(null)} />}
      {resetOpen && <ResetModal stores={stores} onClose={() => setResetOpen(false)} />}
      <section id="import" className="space-y-4" aria-label={t('legacy.title')}>
        <Divider label={t('legacy.title')} />
        <p className="text-xs text-t-muted">{t('legacy.sub')}</p>
        <LegacyImport />
      </section>
    </>
  )
}

// One store in full: what it holds, its numbers, what rebuilds it, and for a
// cache the key-level view (addressed by the short scope name the entry
// endpoints use, the slug without its "cache:" prefix). Flushing the store
// is the dialog's one destructive action and closes it.
function StoreModal({ store, onClose }: { store: DataStore; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const dq = useDebounced(q, () => setOffset(0))
  const [error, setError] = useState('')
  const cache = store.kind === 'cache'
  const scope = store.name.replace(/^cache:/, '')
  const label = storeLabel(t, store.name)

  const { data } = useQuery<CacheEntriesResp>({
    queryKey: ['adminCacheEntries', scope, dq, offset],
    queryFn: () =>
      api.get(`/api/admin/cache/${scope}/entries?q=${encodeURIComponent(dq)}&offset=${offset}&limit=${PAGE}`),
    enabled: cache,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['adminCacheEntries', scope] })
    qc.invalidateQueries({ queryKey: ['adminData'] })
    qc.invalidateQueries({ queryKey: ['adminJobs'] })
  }
  const del = useMutation({
    mutationFn: (key: string) => api.del(`/api/admin/cache/${scope}/entries?key=${encodeURIComponent(key)}`),
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e: Error) => setError(e.message),
  })
  const flush = useMutation({
    mutationFn: () => api.del(`/api/admin/data/${encodeURIComponent(store.name)}`),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const facts: [string, string][] = [
    [t('settings.jobs.data.rows'), fmtNum(store.rows)],
    ...(cache
      ? ([
          [t('settings.jobs.data.size'), fmtBytes(store.bytes)],
          [t('settings.jobs.ttl'), fmtTtl(store.ttlSec)],
          [t('settings.jobs.data.pruneAfter'), store.pruneSec > 0 ? fmtTtl(store.pruneSec) : t('settings.jobs.data.pruneNever')],
        ] as [string, string][])
      : []),
    [t('settings.jobs.oldest'), fmtTs(store.oldest)],
    [t('settings.jobs.newest'), fmtTs(store.newest)],
    [t('settings.jobs.data.rebuiltBy'), rebuildLabel(t, store.rebuild)],
    ...(store.needs.length > 0
      ? ([[t('settings.jobs.data.needs'), store.needs.map((n) => storeLabel(t, n)).join(', ')]] as [string, string][])
      : []),
  ]

  return (
    <Modal
      title={label}
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          disabled={flush.isPending}
          onClick={async () => {
            if (await confirm({ message: t('settings.jobs.data.confirmDelete', { store: label }), destructive: true }))
              flush.mutate()
          }}
        >
          <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('settings.jobs.flush')}
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONE[store.kind]}>{t(`settings.jobs.data.kind.${store.kind}`)}</Badge>
        {store.stale > 0 && (
          <Badge tone="warn" className="tabular-nums">
            {t('settings.jobs.stale', { count: store.stale })}
          </Badge>
        )}
        {store.prunable > 0 && (
          <Badge tone="neutral" className="tabular-nums">
            {t('settings.jobs.prunable', { count: store.prunable })}
          </Badge>
        )}
      </div>
      <p className="mt-2 text-sm text-t-secondary">{storeDesc(t, store.name)}</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-t-muted">{k}</dt>
            <dd className="font-mono tabular-nums text-t-secondary">{v}</dd>
          </div>
        ))}
      </dl>

      {cache && (
        <>
          <Divider label={t('settings.jobs.data.entriesTitle')} count={data?.total} className="mt-4" />
          <label className="sr-only" htmlFor="cache-entries-q">
            {t('remote.search')}
          </label>
          <Input
            id="cache-entries-q"
            className="mt-2"
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
        </>
      )}
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
