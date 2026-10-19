import { HardDrive, MoreHorizontal, Search, Server } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Row,
  RowAction,
  Rows,
  Segmented,
  TextLink,
  useMenu,
} from 'fluid-lycoris'
import { api, type Media, type ScopeRule } from '../../api'
import { useConfirm } from '../../components/confirm'
import { useToast } from '../../components/toast'
import Loading from '../../components/Loading'
import {
  basename,
  cleanTitle,
  fmtNum,
  fmtTs,
  INDEX_DEFAULTS,
  NumField,
  PAGE,
  Pager,
  useAdminJobs,
  useDebounced,
  type IndexServer,
  type MatchEntry,
  type MatchesResp,
  type MatchStat,
} from './maintenance'
import { DetectedMarks } from './DetectedMarks'
import { SettingsPanel } from './ui'
import MatchRouting from './MatchRouting'
import './maintenance.css'

type Run = UseMutationResult<unknown, Error, { name: string; body?: unknown }>

interface ServerCardData {
  id: number
  name: string
  index?: IndexServer
  matches: MatchStat[]
}

// The file index of every server and how well its folders are matched: one
// card per server with the crawler's numbers, a line per metadata source,
// the crawler's settings and the everyday actions; the two that throw work
// away sit behind the card's menu. Then the folder rules, and rematching
// every server as the danger at the end.
export default function Matching() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const navigate = useNavigate()
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
  const confirm = useConfirm()

  if (!data) return null

  // the index lists the servers, the match stats come per server and source;
  // a server with matches but no index (the local library) still gets a card
  const byServer = new Map<number, MatchStat[]>()
  for (const m of data.matches) byServer.set(m.serverId, [...(byServer.get(m.serverId) ?? []), m])
  const cards: ServerCardData[] = data.index.servers.map((s) => ({
    id: s.id,
    name: s.name,
    index: s,
    matches: byServer.get(s.id) ?? [],
  }))
  for (const [id, matches] of byServer) {
    if (!cards.some((c) => c.id === id)) cards.push({ id, name: matches[0].name, matches })
  }

  return (
    <>
      {error && (
        <p className="sf-issue mb-3" role="alert">
          {error}
        </p>
      )}
      <DetectedMarks />
      <MatchRouting />

      <SettingsPanel title={t('nav.servers')} desc={t('settings.jobs.indexHint')}>
        {cards.length === 0 ? (
          <p className="sf-note">{t('settings.jobs.empty')}</p>
        ) : (
          cards.map((c) => (
            <ServerCard
              key={c.id}
              card={c}
              run={run}
              onView={(m) => navigate(`${m.serverId}/${encodeURIComponent(m.source)}`)}
              onFlush={async () => {
                if (
                  await confirm({ message: t('settings.jobs.confirmFlushIndex', { name: c.name }), destructive: true })
                )
                  flushIndex.mutate(c.id)
              }}
              onRematchAll={async () => {
                if (
                  await confirm({ message: t('settings.jobs.confirmRematchAll', { name: c.name }), destructive: true })
                )
                  run.mutate({ name: 'rematch', body: { serverId: c.id, all: true } })
              }}
              onConfig={(body) => setIndexCfg.mutate({ id: c.id, body })}
            />
          ))
        )}
      </SettingsPanel>

      {/* which new folders get a catalog mark on their own: decided here, next to what they feed */}
      <ScopeRules />

      <SettingsPanel danger title={t('settings.jobs.rematchAllServers')}>
        <p className="sf-note">{t('settings.jobs.rematchAllServersHint')}</p>
        <div className="sf-acts">
          <Button
            variant="danger"
            disabled={run.isPending || cards.length === 0}
            onClick={async () => {
              if (await confirm({ message: t('settings.jobs.confirmRematchAllServers'), destructive: true }))
                run.mutate({ name: 'rematch-all', body: { all: true } })
            }}
          >
            {t('settings.jobs.rematchAllServers')}
          </Button>
        </div>
      </SettingsPanel>
    </>
  )
}

function ServerCard({
  card: c,
  run,
  onView,
  onFlush,
  onRematchAll,
  onConfig,
}: {
  card: ServerCardData
  run: Run
  onView: (m: MatchStat) => void
  onFlush: () => void
  onRematchAll: () => void
  onConfig: (body: { intervalMin: number; batch: number }) => void
}) {
  const { t } = useTranslation()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  const more = t('settings.jobs.moreActions')
  const s = c.index
  const first = c.matches[0]
  const Icon = s ? Server : HardDrive
  return (
    <section className="srv" aria-label={c.name}>
      <div className="srv-h">
        <span className="srv-ic" aria-hidden>
          <Icon size="1.25rem" />
        </span>
        <div className="t">
          <strong className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate">{c.name}</span>
            {s && s.pendingDirs > 0 && (
              <Badge tone="warn" className="tabular-nums">
                {t('settings.jobs.pending', { count: s.pendingDirs })}
              </Badge>
            )}
          </strong>
          {s && (
            <span className="tabular-nums">
              {t('settings.jobs.entries', { n: fmtNum(s.rows) })} · {t('settings.jobs.dirs', { n: fmtNum(s.dirs) })} ·{' '}
              {t('settings.jobs.oldestListing')} {fmtTs(s.stalestListedAt)}
            </span>
          )}
        </div>
        {/* the two actions that throw work away live behind the menu, so a
            thumb on a phone cannot land on them by accident */}
        {(s || first) && (
          <span ref={ref} style={anchorStyle}>
            <IconButton
              aria-label={more}
              title={more}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <MoreHorizontal aria-hidden size="1.2em" />
            </IconButton>
            {open && (
              <Menu kind="menu" anchor={anchor} placement="bottom-end" aria-label={more}>
                {s && (
                  <MenuItem
                    className="text-err"
                    onClick={() => {
                      setOpen(false)
                      onFlush()
                    }}
                  >
                    {t('settings.jobs.flushIndex')}
                  </MenuItem>
                )}
                {first && (
                  <MenuItem
                    className="text-err"
                    onClick={() => {
                      setOpen(false)
                      onRematchAll()
                    }}
                  >
                    {t('settings.jobs.rematchAll')}
                  </MenuItem>
                )}
              </Menu>
            )}
          </span>
        )}
      </div>

      {c.matches.map((m) => (
        <div key={m.source} className="idx-row">
          <span>{m.source}</span>
          <Badge tone="ok" className="tabular-nums">
            {t('settings.jobs.matched', { n: fmtNum(m.matched) })}
          </Badge>
          <Badge tone={m.unmatched > 0 ? 'warn' : 'neutral'} className="tabular-nums">
            {t('settings.jobs.unmatched', { n: fmtNum(m.unmatched) })}
          </Badge>
          <TextLink
            className="ms-1"
            aria-label={`${t('settings.jobs.view')}: ${c.name} ${m.source}`}
            onClick={() => onView(m)}
          >
            {t('settings.jobs.view')}
          </TextLink>
        </div>
      ))}

      {s && (
        <div className="sf-2">
          <NumField
            id={`idx-interval-${s.id}`}
            label={t('settings.jobs.interval')}
            value={s.intervalMin ?? INDEX_DEFAULTS.intervalMin}
            onCommit={(n) => onConfig({ intervalMin: n, batch: s.batch ?? INDEX_DEFAULTS.batch })}
          />
          <NumField
            id={`idx-batch-${s.id}`}
            label={t('settings.jobs.batch')}
            value={s.batch ?? INDEX_DEFAULTS.batch}
            onCommit={(n) => onConfig({ intervalMin: s.intervalMin ?? INDEX_DEFAULTS.intervalMin, batch: n })}
          />
        </div>
      )}

      {(s || first) && (
        <div className="sf-acts">
          {s && (
            <Button
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate({ name: 'index-crawl', body: { serverId: c.id } })}
            >
              {t('settings.jobs.crawlNow')}
            </Button>
          )}
          {first && (
            <Button
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate({ name: 'rematch', body: { serverId: c.id, all: false } })}
            >
              {t('settings.jobs.rematchMissing')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

type MatchFilter = 'all' | 'matched' | 'unmatched' | 'manual'
const MATCH_FILTERS: MatchFilter[] = ['all', 'matched', 'unmatched', 'manual']

/**
 * One server's matches for one source on a page stacked on Matching: filter,
 * search, page through, correct or delete. A long list to work through, so a
 * screen with an address rather than a dialog over the overview.
 */
export function MatchesPage() {
  const { server = '', source = '' } = useParams()
  const { data } = useAdminJobs()
  const stat = data?.matches.find((m) => String(m.serverId) === server && m.source === source)
  if (!data) return <Loading page />
  if (!stat) return <Navigate to="/settings/matching" replace />
  return <MatchesView stat={stat} />
}

function MatchesView({ stat }: { stat: MatchStat }) {
  const { t } = useTranslation()
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
    <div>
      <header className="set-sub">
        <h2>{t('settings.jobs.matchesTitle', { name: stat.name })}</h2>
        <Link className="t-link" to="/files">
          {t('settings.jobs.openBrowser')}
        </Link>
      </header>
      <div className="set-tools">
        <Segmented
          aria-label={t('dash.filterStatus')}
          value={filter}
          onChange={(f) => {
            setFilter(f)
            setOffset(0)
          }}
          options={MATCH_FILTERS.map((f) => ({ value: f, label: t(`settings.jobs.filter.${f}`) }))}
        />
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
        <Rows>
          {(data?.entries ?? [])
            .filter((m) => !hidden.has(m.folder))
            .map((m) => (
              <Row key={m.folder} className="mt-row">
                <div className="t-row-t">
                  <strong className="font-mono" title={m.folder}>
                    {basename(m.folder)}
                  </strong>
                  <span className="flex flex-wrap items-center gap-2">
                    {m.mediaId ? (
                      <span className="min-w-0 truncate" title={m.title}>
                        {m.title}
                      </span>
                    ) : (
                      <span className="text-warn">{t('settings.jobs.noMatchYet')}</span>
                    )}
                    {!!m.manual && <Badge>{t('settings.jobs.manualBadge')}</Badge>}
                  </span>
                </div>
                <RowAction
                  aria-expanded={correcting?.folder === m.folder}
                  aria-label={`${t('settings.jobs.correct')}: ${basename(m.folder)}`}
                  onClick={() => (correcting?.folder === m.folder ? setCorrecting(null) : startCorrect(m))}
                >
                  {t('settings.jobs.correct')}
                </RowAction>
                <RowAction
                  className="set-act-err"
                  aria-label={`${t('servers.delete')}: ${basename(m.folder)}`}
                  disabled={del.isPending}
                  onClick={() => {
                    const k = m.folder
                    setHidden((h) => new Set(h).add(k))
                    toast({
                      message: t('settings.jobs.matchDeleted', { name: basename(m.folder) }),
                      undo: () => unhide(k),
                      commit: () => del.mutateAsync(k).catch(() => unhide(k)),
                    })
                  }}
                >
                  {t('servers.delete')}
                </RowAction>
                {correcting?.folder === m.folder && (
                  <div className="mt-correct">
                    <div className="flex gap-2">
                      <label className="sr-only" htmlFor="correct-q">
                        {t('remote.search')}
                      </label>
                      <Input
                        id="correct-q"
                        kind="search"
                        type="text"
                        value={searchQ}
                        placeholder={t('remote.search')}
                        onChange={(e) => setSearchQ(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && search(m)}
                      />
                      <Button className="shrink-0" onClick={() => search(m)}>
                        {t('remote.search')}
                      </Button>
                    </div>
                    {results.length > 0 && (
                      <ul className="mt-results">
                        {results.map((r) => (
                          <li key={r.id}>
                            <button type="button" disabled={picking} onClick={() => pick(m, r.id)}>
                              <span className="min-w-0 truncate">{r.title.romaji}</span>
                              <span className="shrink-0 font-mono tabular-nums">
                                {r.seasonYear} · {r.format}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="sf-acts">
                      <Button size="sm" variant="danger" disabled={picking} onClick={() => pick(m, 0)}>
                        {t('settings.jobs.noMatch')}
                      </Button>
                      <Button size="sm" onClick={() => setCorrecting(null)}>
                        {t('servers.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </Row>
            ))}
        </Rows>
      )}
      <Pager offset={offset} total={data?.total ?? 0} onOffset={setOffset} />
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// The folder rules: which new folders get a catalog mark on their own. They
// are made in the catalog view of a marked folder or from a dashboard hint,
// and this is where they are seen together and ended.
export function ScopeRules() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: rules = [] } = useQuery<ScopeRule[]>({
    queryKey: ['scope-rules'],
    queryFn: () => api.get('/api/catalog/scope-rules'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/catalog/scope-rules/${id}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['scope-rules'] })
      qc.invalidateQueries({ queryKey: ['catalog-scope'] })
      qc.invalidateQueries({ queryKey: ['detected-marks'] })
    },
  })
  if (rules.length === 0) return null
  const kindLabel = (kind: string) =>
    ({
      anime: t('remote.scopeAnime'),
      manga: t('remote.scopeManga'),
      tv: t('remote.scopeTv'),
      movie: t('remote.scopeMovie'),
      tvdb: t('remote.scopeTvdb'),
    })[kind] ?? kind
  // the placeholders in words: "{n}-{n} {season}" reads as "#-# Jahreszeit"
  const shape = (s: string) => s.replaceAll('{n}', '#').replaceAll('{season}', t('servers.ruleSeason'))
  return (
    <SettingsPanel title={t('servers.rules')} desc={t('servers.rulesHint')}>
      <Rows>
        {rules.map((r) => (
          <Row
            key={r.id}
            title={<span className="font-mono">{shape(r.shape)}</span>}
            sub={t('servers.ruleWhere', {
              parent: `${r.serverName || t('servers.local')}: ${r.parent}`,
              kind: kindLabel(r.kind),
            })}
            trailing={
              <RowAction
                className="set-act-err"
                disabled={del.isPending}
                aria-label={`${t('servers.ruleDelete')}: ${r.parent}/${shape(r.shape)}`}
                onClick={async () => {
                  if (await confirm({ message: t('servers.ruleConfirmDelete'), destructive: true })) del.mutate(r.id)
                }}
              >
                {t('servers.ruleDelete')}
              </RowAction>
            }
          />
        ))}
      </Rows>
    </SettingsPanel>
  )
}
