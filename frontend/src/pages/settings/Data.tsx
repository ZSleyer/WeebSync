import { Search } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Badge, Button, Dialog, Modal, Row, RowAction, Rows, Switch } from 'fluid-lycoris'
import { api, fmtBytes } from '../../api'
import { useConfirm } from '../../components/confirm'
import { useUrlState } from '../../hooks/useUrlState'
import { useToast } from '../../components/toast'
import LegacyImport from '../../components/LegacyImport'
import Loading from '../../components/Loading'
import {
  fmtNum,
  fmtTs,
  fmtTtl,
  groupStores,
  KIND_TONE,
  NUMEDIT_GRID,
  NumEdit,
  type AdminJobs,
  PAGE,
  Pager,
  rebuildLabel,
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
  type TtlConfig,
} from './maintenance'
import { SettingsPanel } from './ui'
import './maintenance.css'

// Caches and data: everything the app computes and can compute again. One
// panel per kind, the caches once more by provider with that provider's
// retention and rebuild. A row is one store and links to its own page,
// which holds the description, the numbers, the entries and the flush. The
// rebuild of everything is the danger below, then the import.
export default function Data() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  // bumped when a TTL is refused: remounts the editors, which drops the text typed
  const [refused, setRefused] = useState(0)
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
  // the sent hours show at once, so a second edit before the refetch builds on
  // them; a refusal refetches and remounts the editors, which puts the typed
  // text back to the stored value
  const setTtl = useMutation({
    mutationFn: (body: TtlConfig) => api.put('/api/admin/ttl', body),
    onMutate: (body) => {
      qc.setQueryData<AdminJobs>(['adminJobs'], (d) => d && { ...d, ttl: body })
    },
    ...opts,
    onError: (e: Error) => {
      setError(e.message)
      setRefused((n) => n + 1)
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
    },
  })

  if (!data) return null

  const ttl = data.ttl ?? TTL_DEFAULTS
  const commitTtl = (patch: Partial<TtlConfig>) => setTtl.mutate({ ...ttl, ...patch })
  const ttlEdit = (key: keyof TtlConfig, id: string) => (
    <span className={NUMEDIT_GRID}>
      <NumEdit
        key={refused}
        id={id}
        label={t('settings.jobs.ttlH')}
        value={ttl[key]}
        onCommit={(n) => commitTtl({ [key]: n })}
      />
    </span>
  )
  // what a provider brings besides its stores: the retention of its cache,
  // and the rebuild where one exists
  const providerTools = (p: Provider) => {
    switch (p) {
      case 'anilist':
        return (
          <>
            <span className="text-[length:var(--fs-meta)] text-t-muted">
              {t('settings.jobs.accounts', { count: data.anilist.accounts })}
            </span>
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
            <Badge tone={data.plex.configured ? 'ok' : 'neutral'}>
              {data.plex.configured ? t('settings.jobs.configured') : t('settings.jobs.notConfigured')}
            </Badge>
            <span className="text-[length:var(--fs-meta)] tabular-nums text-t-muted">
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

  // two numbers: stale rows are still served while their refetch runs,
  // prunable ones are dead weight the sweep will drop
  const staleBadge = (n: number, prunable = 0) => (
    <>
      {n > 0 && (
        <Badge tone="warn" className="tabular-nums">
          {t('settings.jobs.stale', { count: n })}
        </Badge>
      )}
      {prunable > 0 && <Badge className="tabular-nums">{t('settings.jobs.prunable', { count: prunable })}</Badge>}
    </>
  )

  // one row per store: what it is, how big, how long it holds, and a link to
  // its own page (so it opens in a new tab and reads as navigation)
  const storeRow = (s: DataStore) => {
    const label = storeLabel(t, s.name)
    const facts = [
      t(`settings.jobs.data.kind.${s.kind}`),
      t('settings.jobs.data.rowCount', { n: fmtNum(s.rows) }),
      ...(s.kind === 'cache' && s.bytes > 0 ? [fmtBytes(s.bytes)] : []),
      ...(s.kind === 'cache' && s.ttlSec > 0 ? [t('settings.jobs.data.validFor', { ttl: fmtTtl(s.ttlSec) })] : []),
    ]
    return (
      <Row
        key={s.name}
        title={label}
        sub={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tabular-nums">{facts.join(' · ')}</span>
            {staleBadge(s.stale, s.prunable)}
          </span>
        }
        trailing={
          <Link
            to={encodeURIComponent(s.name)}
            className="t-row-act"
            aria-label={`${t('settings.jobs.view')}: ${label}`}
          >
            {t('settings.jobs.view')}
          </Link>
        }
      />
    )
  }

  return (
    <>
      {error && (
        <p className="sf-issue mb-3" role="alert">
          {error}
        </p>
      )}

      {stores.length === 0 ? (
        <SettingsPanel title={t('settings.jobs.data.storesTitle')} desc={t('settings.jobs.data.hint')}>
          <p className="sf-note">{t('settings.jobs.empty')}</p>
        </SettingsPanel>
      ) : (
        groups.map((g, i) => (
          <SettingsPanel
            key={g.kind}
            title={t(`settings.jobs.data.kindTitle.${g.kind}`)}
            desc={
              <>
                {i === 0 && <>{t('settings.jobs.data.hint')} </>}
                {t(`settings.jobs.data.kindHint.${g.kind}`)}
              </>
            }
          >
            {g.providers ? (
              g.providers.map((p) => (
                <div key={p.provider}>
                  <div className="set-prov">
                    <h4 className="m-0 font-semibold">{t(`settings.jobs.data.providers.${p.provider}`)}</h4>
                    <span className="text-[length:var(--fs-meta)] tabular-nums text-t-muted">
                      {t('settings.jobs.data.rowCount', { n: fmtNum(p.rows) })}
                      {p.bytes > 0 && <> · {fmtBytes(p.bytes)}</>}
                    </span>
                    <span className="tools">{providerTools(p.provider)}</span>
                  </div>
                  <Rows>{p.stores.map(storeRow)}</Rows>
                </div>
              ))
            ) : (
              <Rows>{g.stores.map(storeRow)}</Rows>
            )}
          </SettingsPanel>
        ))
      )}

      <SettingsPanel id="import" title={t('legacy.title')} desc={t('legacy.sub')}>
        <LegacyImport headingLevel={4} />
      </SettingsPanel>

      <SettingsPanel danger title={t('settings.jobs.data.reset.title')}>
        <p className="sf-note">{t('settings.jobs.data.dangerHint')}</p>
        <div className="sf-acts">
          <Button variant="danger" disabled={stores.length === 0} onClick={() => setResetOpen(true)}>
            {t('settings.jobs.data.reset.button')}
          </Button>
        </div>
      </SettingsPanel>

      {resetOpen && <ResetModal stores={stores} onClose={() => setResetOpen(false)} />}
    </>
  )
}

/**
 * One store on a page of its own, stacked on Data: what it holds, its
 * entries to page through and delete, and the flush. A list to work through
 * reads better as a screen with an address than as a dialog over the
 * inventory it came from.
 */
export function StorePage() {
  const { store: name = '' } = useParams()
  const navigate = useNavigate()
  const { data: inventory } = useAdminData()
  const store = inventory?.stores.find((s) => s.name === name)
  if (!inventory) return <Loading page />
  if (!store) return <Navigate to="/settings/data" replace />
  return <StoreView store={store} onGone={() => navigate('/settings/data')} />
}

function StoreView({ store, onGone }: { store: DataStore; onGone: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [q, setQ] = useUrlState('q')
  const [offset, setOffset] = useState(0)
  const dq = useDebounced(q, () => setOffset(0))
  const [error, setError] = useState('')
  const cache = store.kind === 'cache'
  const scope = store.name.replace(/^cache:/, '')
  const label = storeLabel(t, store.name)
  const desc = storeDesc(t, store.name)

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
  // a row leaves at once with an undo line; the request goes when the line
  // runs out, and the row stays hidden until the refreshed list drops it
  const toast = useToast()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const unhide = (k: string) =>
    setHidden((h) => {
      const n = new Set(h)
      n.delete(k)
      return n
    })
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
      onGone()
    },
    onError: (e: Error) => setError(e.message),
  })

  const facts: [string, string][] = [
    [t('settings.jobs.data.rows'), fmtNum(store.rows)],
    ...(cache
      ? ([
          [t('settings.jobs.data.size'), fmtBytes(store.bytes)],
          [t('settings.jobs.ttl'), fmtTtl(store.ttlSec)],
          [
            t('settings.jobs.data.pruneAfter'),
            store.pruneSec > 0 ? fmtTtl(store.pruneSec) : t('settings.jobs.data.pruneNever'),
          ],
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
    <div>
      <header className="set-sub">
        <h2>{label}</h2>
        {desc && <p>{desc}</p>}
      </header>
      <section className="set-p" aria-label={label}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={KIND_TONE[store.kind]}>{t(`settings.jobs.data.kind.${store.kind}`)}</Badge>
          {store.stale > 0 && (
            <Badge tone="warn" className="tabular-nums">
              {t('settings.jobs.stale', { count: store.stale })}
            </Badge>
          )}
          {store.prunable > 0 && (
            <Badge className="tabular-nums">{t('settings.jobs.prunable', { count: store.prunable })}</Badge>
          )}
        </div>
        <dl className="set-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="sf-acts">
          <Button
            variant="danger"
            disabled={flush.isPending}
            onClick={async () => {
              if (
                await confirm({ message: t('settings.jobs.data.confirmDelete', { store: label }), destructive: true })
              )
                flush.mutate()
            }}
          >
            {t('settings.jobs.flush')}
          </Button>
        </div>
      </section>

      {cache && (
        <SettingsPanel
          title={
            <>
              {t('settings.jobs.data.entriesTitle')}
              {data && <span className="font-normal text-t-muted tabular-nums">{fmtNum(data.total)}</span>}
            </>
          }
        >
          <div className="set-tools">
            <label className="set-search">
              <Search aria-hidden size="1.125rem" />
              <span className="sr-only">{t('remote.search')}</span>
              <input
                type="search"
                className="t-input"
                enterKeyHint="search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('remote.search')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          </div>
          {data && data.entries.length === 0 ? (
            <p className="t-empty t-empty--inline">{t('settings.jobs.empty')}</p>
          ) : (
            <Rows dense>
              {(data?.entries ?? [])
                .filter((e) => !hidden.has(e.key))
                .map((e) => (
                  <Row
                    key={e.key}
                    title={
                      <span className="font-mono" title={e.key}>
                        {truncMiddle(e.key)}
                      </span>
                    }
                    sub={
                      <span className="flex flex-wrap items-center gap-x-2 tabular-nums">
                        {fmtTs(e.fetchedAt)} · {fmtBytes(e.bytes)}
                        {e.stale && <Badge tone="warn">{t('settings.jobs.staleBadge')}</Badge>}
                      </span>
                    }
                    trailing={
                      <RowAction
                        className="set-act-err"
                        aria-label={`${t('servers.delete')}: ${truncMiddle(e.key, 60)}`}
                        disabled={del.isPending}
                        onClick={() => {
                          const k = e.key
                          setHidden((h) => new Set(h).add(k))
                          toast({
                            message: t('settings.jobs.entryDeleted', { key: truncMiddle(e.key, 60) }),
                            undo: () => unhide(k),
                            commit: () => del.mutateAsync(k).catch(() => unhide(k)),
                          })
                        }}
                      >
                        {t('servers.delete')}
                      </RowAction>
                    }
                  />
                ))}
            </Rows>
          )}
          <Pager offset={offset} total={data?.total ?? 0} onOffset={setOffset} />
        </SettingsPanel>
      )}
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// The "rebuild everything" sheet. It never asks a bare "are you sure": it
// names what goes, what stays and what runs afterwards, because the operator's
// complaint was that the existing buttons never said which of those they meant.
// The shared Modal anatomy (header, scrolling body, footer under a hairline
// with Abbrechen and the answer) inside a Dialog.
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
    <ul>
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
    <Dialog width="max-w-2xl" aria-label={t('settings.jobs.data.reset.title')} onClose={onClose}>
      <Modal
        className="max-w-none"
        title={t('settings.jobs.data.reset.title')}
        onClose={onClose}
        closeLabel={t('common.close')}
        footer={
          result ? (
            <Button onClick={onClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button variant="danger-fill" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {t('settings.jobs.data.reset.confirm')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="text-sm text-t-secondary">
            <p>
              {t('settings.jobs.data.reset.done', {
                n: fmtNum(Object.values(result.deleted).reduce((a, b) => a + b, 0)),
              })}
            </p>
            <p className="mt-2">{t('settings.jobs.data.reset.doneQueued', { n: fmtNum(result.queued) })}</p>
            <p className="mt-2 text-xs text-t-muted">
              {t('settings.jobs.data.reset.doneKept', {
                stores: result.kept.map((n) => storeLabel(t, n)).join(', '),
              })}
            </p>
          </div>
        ) : (
          <div className="reset-sheet text-sm text-t-secondary">
            <p className="m-0">{t('settings.jobs.data.reset.intro')}</p>

            <h4>{t('settings.jobs.data.reset.willDelete', { count: doomedRows })}</h4>
            {list(doomed)}

            <h4>{t('settings.jobs.data.reset.willKeep')}</h4>
            {list(kept)}
            <p className="mt-1 text-xs text-t-muted">{t('settings.jobs.data.reset.keepIndexWhy')}</p>

            <h4>{t('settings.jobs.data.reset.willRun')}</h4>
            <p className="mt-1 text-xs text-t-muted">{t('settings.jobs.data.reset.willRunWhat')}</p>

            <div className="t-sf t-sf--row mt-4">
              <div className="t-sf-l">
                <label htmlFor="reset-decisions">{t('settings.jobs.data.reset.includeDecisions')}</label>
              </div>
              <Switch
                id="reset-decisions"
                aria-describedby="reset-decisions-h"
                checked={includeDecisions}
                onChange={(e) => setIncludeDecisions(e.target.checked)}
              />
              <p id="reset-decisions-h" className="t-sf-h warn">
                {t('settings.jobs.data.reset.includeDecisionsCost')}
              </p>
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
    </Dialog>
  )
}
