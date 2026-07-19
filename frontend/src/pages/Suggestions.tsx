import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AnilistSuggestions, type PlexSuggestions, type TmdbSuggestions } from '../api'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { usePersistedQuery } from '../hooks'
import { SkeletonCards } from '../components/Loading'

// Suggestions, three sections: AniList lists watchlist titles (watching /
// planning) that exist on the user's servers via the remote index, plus
// trending anime; Plex reads the configured libraries (grouped per library)
// and lists missing sequels, with the Plex storage folder for consistent
// placement; TMDB lists the linked account's watchlist plus trending titles.
export default function Suggestions() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'plex' | 'anilist' | 'tmdb'>('plex')
  const tabs = [
    ['plex', 'Plex'],
    ['anilist', 'AniList'],
    ['tmdb', 'TMDB'],
  ] as const
  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
        <span className="t-label mt-1">{t('suggestions.sub')}</span>
      </header>
      <TabBar
        label={t('suggestions.title')}
        tabs={tabs.map(([key, label]) => ({ key, label }))}
        active={tab}
        onChange={setTab}
      />
      {tab === 'plex' ? <PlexSection /> : tab === 'anilist' ? <AnilistSection /> : <TmdbSection />}
    </div>
  )
}

// proper tab navigation (ARIA tabs pattern): underline bar, roving tabindex,
// arrow-key switching - shared by the source tabs and the Plex library tabs
function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: { key: T; label: string }[]
  active: T
  onChange: (k: T) => void
  label: string
}) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const next = (idx + dir + tabs.length) % tabs.length
    onChange(tabs[next].key)
    const els = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')
    els?.[next]?.focus()
  }
  // chevron scroll hints when the bar overflows (phones)
  const listRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })
  const check = () => {
    const el = listRef.current
    if (!el) return
    const left = el.scrollLeft > 4
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }
  useEffect(() => {
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  })
  return (
    <div className="relative mb-4">
      <div role="tablist" aria-label={label} className="t-tabs" ref={listRef} onScroll={check}>
        {tabs.map((tb, i) => (
          <button
            key={tb.key}
            role="tab"
            aria-selected={active === tb.key}
            tabIndex={active === tb.key ? 0 : -1}
            className="t-tab"
            onClick={() => onChange(tb.key)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {tb.label}
          </button>
        ))}
      </div>
      {/* decorative scroll hints - swipe and arrow keys do the real work */}
      {more.left && (
        <button
          aria-hidden
          tabIndex={-1}
          className="t-tabs-more t-tabs-more--l"
          onClick={() => listRef.current?.scrollBy({ left: -160, behavior: 'smooth' })}
        >
          ‹
        </button>
      )}
      {more.right && (
        <button
          aria-hidden
          tabIndex={-1}
          className="t-tabs-more t-tabs-more--r"
          onClick={() => listRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
        >
          ›
        </button>
      )}
    </div>
  )
}

// Candidate path, focused on what matters: the last folder name plus a
// server badge. The full path expands on tap/click (it rarely fits anyway,
// especially on phones).
function CandidatePath({ serverName, path }: { serverName: string; path: string }) {
  const [open, setOpen] = useState(false)
  const name = path.replace(/\/+$/, '').split('/').pop() || path
  return (
    <div className="min-w-0 sm:flex-1">
      <button
        type="button"
        className="flex min-h-6 w-full max-w-full items-start gap-1.5 text-left"
        aria-expanded={open}
        title={path}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden className="shrink-0 pt-0.5 font-mono text-xs text-accent">
          {open ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1 text-sm text-t-secondary line-clamp-2">{name}</span>
        <span className="t-label shrink-0">{serverName}</span>
      </button>
      {open && <p className="mt-1 break-all pl-4 font-mono text-[11px] text-t-muted">{path}</p>}
    </div>
  )
}

// candidate row shared by both sections: folder-name focus + watch/sync/open
function CandidateRow({
  serverId,
  serverName,
  path,
  onWatch,
  onSync,
}: {
  serverId: number
  serverName: string
  path: string
  onWatch?: () => void
  onSync?: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <li className="flex flex-col gap-1.5 pb-1.5 sm:flex-row sm:items-center sm:gap-2">
      <CandidatePath serverName={serverName} path={path} />
      {/* one row of actions on phones instead of ragged wrapping;
          first column slightly wider for the longest label */}
      <div className={`grid gap-1.5 sm:flex ${onWatch ? 'grid-cols-[1.2fr_1fr_1fr]' : 'grid-cols-1'}`}>
        {onWatch && (
          <button className="t-btn t-btn--sm t-btn--primary" title={t('plex.watchHint')} onClick={onWatch}>
            {t('watch.add')}
          </button>
        )}
        {onSync && (
          <button className="t-btn t-btn--sm" title={t('plex.syncHint')} onClick={onSync}>
            {t('plex.syncOnce')}
          </button>
        )}
        <button
          className="t-btn t-btn--sm"
          title={t('plex.openBrowser')}
          onClick={() => navigate(`/browser?server=${serverId}&path=${encodeURIComponent(path)}`)}
        >
          <span className="sm:hidden">{t('plex.open')}</span>
          <span className="hidden sm:inline">{t('plex.openBrowser')}</span>
        </button>
      </div>
    </li>
  )
}

// A hard-separated block: server-available suggestions vs API discovery each
// get their own bordered container with a header + one-line descriptor.
function Group({ title, subtitle, count, children }: { title: string; subtitle: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="border border-border-subtle bg-bg-secondary/20">
      <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
        <div>
          <h3 className="font-display text-sm font-semibold tracking-wider text-t-primary">{title}</h3>
          <p className="mt-0.5 text-[11px] text-t-muted">{subtitle}</p>
        </div>
        {count != null && count > 0 && <span className="t-label shrink-0">{count}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

// AniList watchlist titles available on the user's servers.
function AnilistSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data, isLoading } = usePersistedQuery<AnilistSuggestions>(
    'anilist-suggestions',
    () => api.get('/api/anilist/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 5000 : false) },
  )
  const [watch, setWatch] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const [lastIds, setLastIds] = useState<number[]>([])

  type Sug = AnilistSuggestions['suggestions'][number]
  // local target: reuse the Plex folder name when the title exists there,
  // otherwise empty - the sync then creates the remote folder name, and the
  // watch dialog lets the user pick a target
  const prefill = (s: Sug, path: string): WatchFields => {
    const season = guessSeason(s.media.title.romaji)
    return {
      remotePath: path,
      localPath: s.plexFolder ?? '',
      mode: 'template',
      template: season > 0 ? `{title} - S${String(season).padStart(2, '0')}E{episode:02}` : '{title} - S{season:02}E{episode:02}',
      separator: '',
      titleOverride: s.media.title.romaji,
      pattern: '',
      replacement: '',
      subfolder: false,
      mediaId: 0,
      mediaSource: 'anilist',
      fromEpisode: 0,
      airedMapping: false,
      renameProvider: '',
      renameOrdering: '',
      renameTitleLang: '',
      renameSeriesId: 0,
      wantDub: '',
      wantSub: '',
    }
  }
  const syncOnce = async (s: Sug, serverId: number, path: string) => {
    try {
      const r = await api.post<{ queued: number; ids: number[] }>('/api/downloads', {
        serverId,
        remotePath: path,
        localPath: s.plexFolder ?? '',
      })
      setError(t('browser.queued', { count: r.queued }))
      setLastIds(r.ids ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setLastIds([])
    }
  }

  // card shared by watchlist and trending; trending entries carry no
  // watchlist status, so status label / progress / +1 render conditionally
  const card = (s: Sug) => (
    <li key={s.media.id} className="t-panel flex flex-wrap items-center gap-4 p-3">
      {s.media.coverImage?.large ? (
        <img src={s.media.coverImage.large} alt="" className="h-20 w-14 shrink-0 object-cover" />
      ) : (
        <div className="t-hatch h-20 w-14 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-t-primary">{s.media.title.romaji}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-t-muted">
          {s.status && (
            <span className={`t-label ${s.status === 'CURRENT' ? 't-label--accent' : ''}`}>
              {t(`suggestions.status${s.status}`)}
            </span>
          )}
          {s.status && s.media.episodes > 0 && (
            <span>{t('suggestions.seen', { seen: s.progress, total: s.media.episodes })}</span>
          )}
          {s.media.status && <span>{t(`browser.status.${s.media.status}`, s.media.status)}</span>}
          {s.media.averageScore > 0 && <span className="t-label t-label--accent">★ {s.media.averageScore}</span>}
          <a className="t-label hover:text-accent" href={`https://anilist.co/anime/${s.media.id}`} target="_blank" rel="noreferrer">
            AniList ↗
          </a>
          {s.status && (
            <button
              className="t-btn t-btn--sm"
              title={t('suggestions.plusOneHint')}
              onClick={async () => {
                try {
                  await api.post('/api/anilist/progress', { mediaId: s.media.id, progress: s.progress + 1 })
                  setError('')
                  qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
                } catch (err) {
                  setError(err instanceof Error ? err.message : t('app.error'))
                }
              }}
            >
              {t('suggestions.plusOne')}
            </button>
          )}
        </p>
        {s.plexFolder && (
          <p className="mt-1 truncate font-mono text-[11px] text-t-muted" title={s.plexFolder}>
            {t('suggestions.plexFolder')}: {s.plexFolder}
          </p>
        )}
        {s.candidates.length === 0 ? (
          <p className="mt-2 text-[11px] text-t-faint">{t('suggestions.notOnServer')}</p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-1">
            {s.candidates.map((c) => (
              <CandidateRow
                key={c.path}
                serverId={c.serverId}
                serverName={c.serverName}
                path={c.path}
                onWatch={() => setWatch({ serverId: c.serverId, name: s.media.title.romaji, initial: prefill(s, c.path) })}
                onSync={() => syncOnce(s, c.serverId, c.path)}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  )

  return (
    <section className="mb-8" aria-label={t('suggestions.anilist')}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="t-label t-label--accent">{t('suggestions.anilist')}</span>
        {data?.connected && (
          <button
            className="t-btn t-btn--sm"
            onClick={async () => {
              try {
                await api.get('/api/anilist/suggestions?force=1')
                setError('')
                qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
              } catch (err) {
                setError(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('plex.refresh')}
          </button>
        )}
        {data?.building && (
          <span className="text-xs text-t-muted" role="status">
            {t('plex.building')}
          </span>
        )}
        {error && (
          <span className="text-xs text-err" role="alert">
            {error}
          </span>
        )}
      </div>
      {isLoading ? (
        <SkeletonCards />
      ) : (
        <div className="space-y-4">
          <Group title={t('suggestions.onServer')} subtitle={t('suggestions.onServerSub')} count={data?.suggestions.length}>
            {!data?.connected ? (
              <div className="p-3 text-center text-sm text-t-muted">
                <Trans i18nKey="suggestions.notConnected">
                  Kein AniList-Konto verbunden. Unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> verbinden.
                </Trans>
              </div>
            ) : data.suggestions.length === 0 ? (
              <div className="p-3 text-center text-sm text-t-muted">
                {data.building ? t('plex.buildingLong') : t('suggestions.anilistEmpty')}
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3">{data.suggestions.map(card)}</ul>
            )}
          </Group>
          <Group title={t('suggestions.trendingTitle')} subtitle={t('suggestions.trendingSubAnilist')} count={data?.trending?.length}>
            {(data?.trending?.length ?? 0) === 0 ? (
              <div className="p-3 text-center text-sm text-t-muted">{t('suggestions.trendingEmpty')}</div>
            ) : (
              <ul className="grid grid-cols-1 gap-3">{data!.trending.map(card)}</ul>
            )}
          </Group>
        </div>
      )}
      {lastIds.length > 0 && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-t-secondary" role="status">
          <button
            className="t-btn t-btn--sm t-btn--danger"
            onClick={async () => {
              try {
                const out = await api.post<{ canceled: number }>('/api/downloads/cancel', { ids: lastIds })
                setError(t('browser.syncCanceled', { count: out.canceled }))
                setLastIds([])
              } catch (err) {
                setError(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('browser.undoSync')}
          </button>
        </p>
      )}
      {watch && (
        <WatchDialog
          title={t('watch.addTitle', { name: watch.name })}
          serverId={watch.serverId}
          initial={watch.initial}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: watch.serverId, ...f })
            setError(t('watch.created'))
          }}
          onClose={() => setWatch(null)}
        />
      )}
    </section>
  )
}

// guessSeason reads a season number out of a sequel title ("2nd Season",
// "Season 3", "Part 2" not counted) for the rename template prefill.
function guessSeason(title: string): number {
  const m = title.match(/(\d+)(?:nd|rd|th)\s+Season/i) ?? title.match(/Season\s+(\d+)/i) ?? title.match(/\bS(\d+)\b/)
  return m ? Number(m[1]) : 0
}

// Plex: missing sequels of shows in the configured libraries. Each remote
// candidate can be synced once or watched permanently, prefilled from the
// Plex data: local folder = the show's Plex folder name (consistent
// placement) and a Plex-style rename template with the library's title.
function PlexSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading } = usePersistedQuery<PlexSuggestions>(
    'plex-suggestions',
    () => api.get('/api/plex/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 5000 : false) },
  )
  const [watch, setWatch] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const [notice, setNotice] = useState('')
  const [lastIds, setLastIds] = useState<number[]>([])
  const [lib, setLib] = useState('') // active library sub-tab; '' = first

  const refresh = async () => {
    try {
      await api.get('/api/plex/suggestions?force=1')
      qc.invalidateQueries({ queryKey: ['plex-suggestions'] })
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.error'))
      setLastIds([])
    }
  }

  // prefill recommendations from the Plex data
  const prefill = (s: PlexSuggestions['suggestions'][number], path: string): WatchFields => {
    const season = guessSeason(s.sequel.title.romaji)
    // movies get no SxxEyy episode template - empty template = no rename
    const template =
      s.source === 'tmdb:movie'
        ? ''
        : season > 0
          ? `{title} - S${String(season).padStart(2, '0')}E{episode:02}`
          : '{title} - S{season:02}E{episode:02}'
    return {
      remotePath: path,
      localPath: s.folder ? (s.folder.split('/').pop() ?? '') : '',
      mode: 'template',
      template,
      separator: '',
      titleOverride: s.showTitle,
      pattern: '',
      replacement: '',
      subfolder: false,
      mediaId: 0,
      mediaSource: 'anilist',
      fromEpisode: 0,
      airedMapping: false,
      renameProvider: '',
      renameOrdering: '',
      renameTitleLang: '',
      renameSeriesId: 0,
      wantDub: '',
      wantSub: '',
    }
  }

  const syncOnce = async (s: PlexSuggestions['suggestions'][number], serverId: number, path: string) => {
    try {
      const r = await api.post<{ queued: number; ids: number[] }>('/api/downloads', {
        serverId,
        remotePath: path,
        localPath: s.folder ? (s.folder.split('/').pop() ?? '') : '',
      })
      setNotice(t('browser.queued', { count: r.queued }))
      setLastIds(r.ids ?? [])
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.error'))
      setLastIds([])
    }
  }

  return (
    <section aria-label={t('suggestions.plex')}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="t-label t-label--accent">{t('suggestions.plex')}</span>
        {data?.configured && (
          <button className="t-btn t-btn--sm" onClick={refresh}>
            {t('plex.refresh')}
          </button>
        )}
        {data?.building && (
          <span className="text-xs text-t-muted" role="status">
            {t('plex.building')}
          </span>
        )}
      </div>
      {isLoading ? (
        <SkeletonCards />
      ) : !data?.configured ? (
        <div className="t-panel p-6 text-center text-sm text-t-muted">
          <Trans i18nKey="plex.notConfigured">
            Plex ist nicht eingerichtet. URL und Token unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> hinterlegen.
          </Trans>
        </div>
      ) : data.suggestions.length === 0 ? (
        <div className="t-panel p-6 text-center text-sm text-t-muted">
          {data.building ? t('plex.buildingLong') : t('plex.empty')}
        </div>
      ) : (
        (() => {
          // one sub-tab per Plex library instead of one long scroll
          const groups = data.suggestions.reduce<Record<string, PlexSuggestions['suggestions']>>((acc, s) => {
            const l = s.library || t('suggestions.otherLibrary')
            ;(acc[l] ??= []).push(s)
            return acc
          }, {})
          const libs = Object.keys(groups)
          const active = libs.includes(lib) ? lib : libs[0]
          return (
            <section role="tabpanel" aria-label={active}>
              {libs.length > 1 && (
                <TabBar
                  label={t('suggestions.plexLibraries')}
                  tabs={libs.map((l) => ({ key: l, label: `${l} (${groups[l].length})` }))}
                  active={active}
                  onChange={setLib}
                />
              )}
              <ul className="grid grid-cols-1 gap-3">
                {groups[active].map((s) => (
                <li key={`${s.showTitle}-${s.sequel.id}`} className="t-panel flex flex-wrap gap-4 p-4">
              {s.sequel.coverImage?.large ? (
                <img src={s.sequel.coverImage.large} alt="" className="h-28 w-20 shrink-0 object-cover" />
              ) : (
                <div className="t-hatch h-28 w-20 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="text-sm font-medium text-t-primary">
                    {s.showTitle} {s.year > 0 && <span className="text-t-muted">({s.year})</span>}
                  </h3>
                  <span className="text-xs text-t-muted">{t('plex.have', { have: s.leafCount, need: s.chainNeed })}</span>
                </div>
                <p className="mt-1 text-sm text-accent">
                  {t('plex.missing')}: {s.sequel.title.romaji}
                </p>
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {s.sequel.seasonYear > 0 && <span className="t-label">{s.sequel.seasonYear}</span>}
                  {s.sequel.episodes > 0 && <span className="t-label">{s.sequel.episodes} EP</span>}
                  {s.sequel.status && (
                    <span className="t-label">{t('browser.status.' + s.sequel.status, s.sequel.status)}</span>
                  )}
                  {s.sequel.averageScore > 0 && (
                    <span className="t-label t-label--accent">★ {s.sequel.averageScore}</span>
                  )}
                  {s.source?.startsWith('tmdb:') ? (
                    <a
                      className="t-label hover:text-accent"
                      href={`https://www.themoviedb.org/${s.source.slice(5)}/${s.sequel.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      TMDB ↗
                    </a>
                  ) : (
                    <a
                      className="t-label hover:text-accent"
                      href={`https://anilist.co/anime/${s.sequel.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      AniList ↗
                    </a>
                  )}
                </p>
                {s.folder && (
                  <p className="mt-1 break-all font-mono text-[11px] text-t-muted" title={t('plex.folderHint')}>
                    {t('plex.folder')}: {s.folder}
                  </p>
                )}
                {s.candidates.length > 0 && (
                  <div className="mt-2 border-t border-border-subtle pt-2">
                    <span className="t-label">{t('plex.candidates')}</span>
                    <ul className="mt-1 grid grid-cols-1 gap-1">
                      {s.candidates.map((c) => (
                        <CandidateRow
                          key={c.path}
                          serverId={c.serverId}
                          serverName={c.serverName}
                          path={c.path}
                          onWatch={() =>
                            setWatch({ serverId: c.serverId, name: s.sequel.title.romaji, initial: prefill(s, c.path) })
                          }
                          onSync={() => syncOnce(s, c.serverId, c.path)}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          )
        })()
      )}
      {notice && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-t-secondary" role="status">
          {notice}
          {lastIds.length > 0 && (
            <button
              className="t-btn t-btn--sm t-btn--danger"
              onClick={async () => {
                try {
                  const out = await api.post<{ canceled: number }>('/api/downloads/cancel', { ids: lastIds })
                  setNotice(t('browser.syncCanceled', { count: out.canceled }))
                  setLastIds([])
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : t('app.error'))
                }
              }}
            >
              {t('browser.undoSync')}
            </button>
          )}
        </p>
      )}
      {watch && (
        <WatchDialog
          title={t('watch.addTitle', { name: watch.name })}
          serverId={watch.serverId}
          initial={watch.initial}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: watch.serverId, ...f })
            setNotice(t('watch.created'))
          }}
          onClose={() => setWatch(null)}
        />
      )}
    </section>
  )
}

// TMDB: the linked account's watchlist plus this week's trending titles,
// each filtered to what exists on the user's servers.
function TmdbSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [notice, setNotice] = useState('')
  const [lastIds, setLastIds] = useState<number[]>([])
  const [watch, setWatch] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const { data, isLoading } = usePersistedQuery<TmdbSuggestions>('tmdb-suggestions', () =>
    api.get('/api/tmdb/suggestions'),
  )

  type Sug = TmdbSuggestions['watchlist'][number]
  const prefill = (s: Sug, path: string): WatchFields => {
    const season = guessSeason(s.media.title.romaji)
    // movies get no SxxEyy episode template - empty template = no rename
    const template =
      s.source === 'tmdb:movie'
        ? ''
        : season > 0
          ? `{title} - S${String(season).padStart(2, '0')}E{episode:02}`
          : '{title} - S{season:02}E{episode:02}'
    return {
      remotePath: path,
      localPath: s.plexFolder ?? '',
      mode: 'template',
      template,
      separator: '',
      titleOverride: s.media.title.romaji,
      pattern: '',
      replacement: '',
      subfolder: false,
      mediaId: 0,
      mediaSource: 'anilist',
      fromEpisode: 0,
      airedMapping: false,
      renameProvider: '',
      renameOrdering: '',
      renameTitleLang: '',
      renameSeriesId: 0,
      wantDub: '',
      wantSub: '',
    }
  }
  const syncOnce = async (s: Sug, serverId: number, path: string) => {
    try {
      const r = await api.post<{ queued: number; ids: number[] }>('/api/downloads', {
        serverId,
        remotePath: path,
        localPath: s.plexFolder ?? '',
      })
      setNotice(t('browser.queued', { count: r.queued }))
      setLastIds(r.ids ?? [])
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.error'))
      setLastIds([])
    }
  }

  const card = (s: Sug) => (
    <li key={`${s.source}-${s.media.id}`} className="t-panel flex flex-wrap items-center gap-4 p-3">
      {s.media.coverImage?.large ? (
        <img src={s.media.coverImage.large} alt="" className="h-20 w-14 shrink-0 object-cover" />
      ) : (
        <div className="t-hatch h-20 w-14 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-t-primary">{s.media.title.romaji}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-t-muted">
          {s.media.seasonYear > 0 && <span className="t-label">{s.media.seasonYear}</span>}
          {s.media.format && <span className="t-label">{s.media.format}</span>}
          {s.media.status && <span>{t(`browser.status.${s.media.status}`, s.media.status)}</span>}
          {s.media.averageScore > 0 && <span className="t-label t-label--accent">★ {s.media.averageScore}</span>}
          <a
            className="t-label hover:text-accent"
            href={`https://www.themoviedb.org/${s.source.slice(5)}/${s.media.id}`}
            target="_blank"
            rel="noreferrer"
          >
            TMDB ↗
          </a>
        </p>
        {s.plexFolder && (
          <p className="mt-1 truncate font-mono text-[11px] text-t-muted" title={s.plexFolder}>
            {t('suggestions.plexFolder')}: {s.plexFolder}
          </p>
        )}
        {s.candidates.length === 0 ? (
          <p className="mt-2 text-[11px] text-t-faint">{t('suggestions.notOnServer')}</p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-1">
            {s.candidates.map((c) => (
              <CandidateRow
                key={c.path}
                serverId={c.serverId}
                serverName={c.serverName}
                path={c.path}
                onWatch={() => setWatch({ serverId: c.serverId, name: s.media.title.romaji, initial: prefill(s, c.path) })}
                onSync={() => syncOnce(s, c.serverId, c.path)}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  )

  return (
    <section className="mb-8" aria-label="TMDB">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="t-label t-label--accent">TMDB</span>
        {data?.configured && (
          <button
            className="t-btn t-btn--sm"
            onClick={async () => {
              try {
                await api.get('/api/tmdb/suggestions?force=1')
                setNotice('')
                qc.invalidateQueries({ queryKey: ['tmdb-suggestions'] })
              } catch (err) {
                setNotice(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('plex.refresh')}
          </button>
        )}
      </div>
      {isLoading ? (
        <SkeletonCards />
      ) : !data?.configured ? (
        <div className="t-panel p-6 text-center text-sm text-t-muted">
          <Trans i18nKey="suggestions.tmdbNotConfigured">
            Kein TMDB-API-Key hinterlegt. Unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> eintragen.
          </Trans>
        </div>
      ) : (
        <div className="space-y-4">
          <Group title={t('suggestions.onServer')} subtitle={t('suggestions.onServerSubTmdb')} count={data.watchlist.length}>
            {!data.connected ? (
              <div className="p-3 text-center text-sm text-t-muted">
                <Trans i18nKey="suggestions.tmdbNotConnected">
                  Kein TMDB-Konto verbunden. Unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> verbinden.
                </Trans>
              </div>
            ) : data.watchlist.length === 0 ? (
              <div className="p-3 text-center text-sm text-t-muted">{t('suggestions.tmdbEmpty')}</div>
            ) : (
              <ul className="grid grid-cols-1 gap-3">{data.watchlist.map(card)}</ul>
            )}
          </Group>
          <Group title={t('suggestions.trendingTitle')} subtitle={t('suggestions.trendingSubTmdb')} count={data.trending.length}>
            {data.trending.length === 0 ? (
              <div className="p-3 text-center text-sm text-t-muted">{t('suggestions.trendingEmpty')}</div>
            ) : (
              <ul className="grid grid-cols-1 gap-3">{data.trending.map(card)}</ul>
            )}
          </Group>
        </div>
      )}
      {notice && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-t-secondary" role="status">
          {notice}
          {lastIds.length > 0 && (
            <button
              className="t-btn t-btn--sm t-btn--danger"
              onClick={async () => {
                try {
                  const out = await api.post<{ canceled: number }>('/api/downloads/cancel', { ids: lastIds })
                  setNotice(t('browser.syncCanceled', { count: out.canceled }))
                  setLastIds([])
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : t('app.error'))
                }
              }}
            >
              {t('browser.undoSync')}
            </button>
          )}
        </p>
      )}
      {watch && (
        <WatchDialog
          title={t('watch.addTitle', { name: watch.name })}
          serverId={watch.serverId}
          initial={watch.initial}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: watch.serverId, ...f })
            setNotice(t('watch.created'))
          }}
          onClose={() => setWatch(null)}
        />
      )}
    </section>
  )
}
