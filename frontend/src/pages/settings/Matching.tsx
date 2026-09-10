import { Check, Search, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Panel } from '@weebsync/design-system'
import { api, type Media } from '../../api'
import { useConfirm } from '../../components/confirm'
import {
  basename,
  CELL_LEFT,
  CELL_RIGHT,
  cleanTitle,
  COUNT_BADGE,
  fmtNum,
  fmtTs,
  INDEX_DEFAULTS,
  Modal,
  NUM,
  NUMEDIT_GRID,
  NumEdit,
  PAGE,
  Pager,
  ROW_GRID,
  useAdminJobs,
  useDebounced,
  type MatchEntry,
  type MatchesResp,
  type MatchStat,
} from './maintenance'

// The file index of every server and how well its folders are matched to
// a title: crawl, rematch, and the per-folder correction dialog.
export default function Matching() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [matchModal, setMatchModal] = useState<MatchStat | null>(null)
  const { data } = useAdminJobs()

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
  const flushIndex = useMutation({
    mutationFn: (id: number) => api.del(`/api/admin/index/${id}`),
    ...opts,
  })
  const setIndexCfg = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { intervalMin: number; batch: number } }) =>
      api.put(`/api/admin/index/${id}/config`, body),
    ...opts,
  })

  if (!data) return null

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}
      <Panel as="section" id="index" className="mb-4 p-5" aria-label={t('settings.jobs.remoteIndex')}>
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
      <Panel as="section" id="matches" className="mb-4 p-5" aria-label={t('settings.jobs.matchQuality')}>
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

      {matchModal && <MatchesModal stat={matchModal} onClose={() => setMatchModal(null)} />}
    </>
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
        <Link className="text-xs text-accent underline-offset-2 hover:underline" to="/files">
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
                <div className="mt-2 rounded-lg border border-border-subtle bg-bg-secondary/40 p-2">
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
