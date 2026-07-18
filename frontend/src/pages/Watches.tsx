import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api, type Watch } from '../api'
import WatchDialog from '../components/WatchDialog'
import { SkeletonCards } from '../components/Loading'

// Watches: persistent auto-sync overview. Each watch re-checks its remote
// folder on an interval; the list polls so check results appear live.
export default function Watches() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: watches = [], isLoading } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    refetchInterval: 10_000,
  })
  const [edit, setEdit] = useState<Watch | null>(null)
  const [error, setError] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['watches'] })

  const check = async (id: number) => {
    setError('')
    try {
      await api.post(`/api/watches/${id}/check`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    setTimeout(refresh, 1500)
  }
  const del = async (w: Watch) => {
    if (!confirm(t('watch.confirmDelete', { name: w.remotePath }))) return
    setError('')
    try {
      await api.del(`/api/watches/${w.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    refresh()
  }

  // sqlite datetimes are UTC without zone suffix
  const ago = (dt: string) => {
    if (!dt) return t('watch.never')
    const min = Math.max(0, Math.round((Date.now() - Date.parse(dt.replace(' ', 'T') + 'Z')) / 60_000))
    return t('watch.minAgo', { count: min })
  }
  const next = (w: Watch) => {
    if (!w.lastCheck) return ''
    const min = Math.round((Date.parse(w.lastCheck.replace(' ', 'T') + 'Z') + w.intervalMin * 60_000 - Date.now()) / 60_000)
    return t('watch.nextIn', { count: Math.max(0, min) })
  }
  // AniList airingAt is an absolute unix time; render in the viewer's zone
  // (or a named zone like Asia/Tokyo for the JST hover)
  const airFmt = (ts: number, tz?: string) =>
    new Date(ts * 1000).toLocaleString([], {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(tz ? { timeZone: tz } : {}),
    })
  const countdown = (ts: number) => {
    const ms = ts * 1000 - Date.now()
    if (ms <= 0) return t('watch.airingNow')
    const d = Math.floor(ms / 86_400_000)
    const h = Math.floor((ms % 86_400_000) / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    if (d > 0) return t('watch.inDaysH', { d, h })
    if (h > 0) return t('watch.inHoursM', { h, m })
    return t('watch.inMinutes', { m })
  }
  // calendar: upcoming episodes grouped by local day
  const calDayKey = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit' })
  const upcoming = [...watches]
    .filter((w) => w.nextAiringAt && w.nextAiringAt * 1000 > Date.now())
    .sort((a, b) => a.nextAiringAt! - b.nextAiringAt!)
  const calGroups: { day: string; items: Watch[] }[] = []
  for (const w of upcoming) {
    const day = calDayKey(w.nextAiringAt!)
    const g = calGroups.find((x) => x.day === day)
    if (g) g.items.push(w)
    else calGroups.push({ day, items: [w] })
  }

  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [sort, setSort] = useState<'next' | 'last' | 'name' | 'season'>('next')
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sortOpen) return
    const onDoc = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setSortOpen(false)
      } else if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
    }
  }, [sortOpen])
  const SORT_OPTS = [
    { v: 'next', k: 'watch.sortNext' },
    { v: 'last', k: 'watch.sortLast' },
    { v: 'name', k: 'watch.sortName' },
    { v: 'season', k: 'watch.sortSeason' },
  ] as const
  const nextTs = (w: Watch) =>
    w.nextAiringAt ? w.nextAiringAt * 1000 : w.lastCheck ? Date.parse(w.lastCheck.replace(' ', 'T') + 'Z') + w.intervalMin * 60_000 : 0
  const nameOf = (w: Watch) => (w.titleOverride || w.media?.title.romaji || w.remotePath.split('/').pop() || '').toLowerCase()
  const seasonOf = (w: Watch) => Number(w.template.match(/S(\d+)E/i)?.[1] ?? 0)
  const sorted = [...watches].sort((a, b) => {
    switch (sort) {
      case 'last':
        return (Date.parse(b.lastCheck.replace(' ', 'T') + 'Z') || 0) - (Date.parse(a.lastCheck.replace(' ', 'T') + 'Z') || 0)
      case 'name':
        return nameOf(a).localeCompare(nameOf(b))
      case 'season':
        return seasonOf(a) - seasonOf(b) || nameOf(a).localeCompare(nameOf(b))
      default:
        return nextTs(a) - nextTs(b)
    }
  })
  // group by status: actively downloading on top, waiting in the middle,
  // finished at the bottom (each keeps the chosen sort order within it)
  const groupOf = (w: Watch): 'syncing' | 'waiting' | 'idle' | 'complete' =>
    w.active > 0 ? 'syncing' : w.complete ? 'complete' : w.waiting ? 'waiting' : 'idle'
  const GROUP_ORDER = ['syncing', 'idle', 'waiting', 'complete'] as const
  const grouped = GROUP_ORDER.map((g) => ({ g, items: sorted.filter((w) => groupOf(w) === g) })).filter((x) => x.items.length > 0)

  return (
    <div className="max-w-4xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('watch.title')}</h2>
          <span className="t-label mt-1">{t('watch.sub')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label={t('watch.view')} className="flex">
            <button
              className={`t-btn t-btn--sm ${view === 'list' ? 't-btn--primary' : ''}`}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              {t('watch.viewList')}
            </button>
            <button
              className={`t-btn t-btn--sm ${view === 'calendar' ? 't-btn--primary' : ''}`}
              aria-pressed={view === 'calendar'}
              onClick={() => setView('calendar')}
            >
              {t('watch.viewCalendar')}
            </button>
          </div>
          {view === 'list' && watches.length > 1 && (
            <div className="relative" ref={sortRef}>
              <button
                type="button"
                className="t-btn t-btn--sm"
                aria-haspopup="listbox"
                aria-expanded={sortOpen}
                aria-label={t('watch.sortBy')}
                title={t('watch.sortBy')}
                onClick={() => setSortOpen((o) => !o)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" />
                </svg>
              </button>
              {sortOpen && (
                <ul className="absolute right-0 z-20 mt-1 min-w-44 border border-border-subtle bg-bg-card py-1 shadow-lg" role="listbox" aria-label={t('watch.sortBy')}>
                  {SORT_OPTS.map((o) => (
                    <li key={o.v}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={sort === o.v}
                        className={`flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm hover:bg-bg-secondary ${sort === o.v ? 'text-accent' : 'text-t-secondary'}`}
                        onClick={() => {
                          setSort(o.v)
                          setSortOpen(false)
                        }}
                      >
                        {t(o.k)}
                        {sort === o.v && <span aria-hidden>✓</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </header>

      {error && (
        <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
          {error}
        </p>
      )}

      {isLoading ? (
        <SkeletonCards />
      ) : watches.length === 0 ? (
        <div className="t-panel p-8 text-center text-t-muted">
          <Trans i18nKey="watch.empty">
            Im <Link to="/browser" className="text-accent underline">Browser</Link> einen Ordner auswählen und „Beobachten" klicken.
          </Trans>
        </div>
      ) : view === 'calendar' ? (
        calGroups.length === 0 ? (
          <div className="t-panel p-8 text-center text-t-muted">{t('watch.calEmpty')}</div>
        ) : (
          <div className="flex flex-col gap-5">
            {calGroups.map((g) => (
              <section key={g.day} className="min-w-0">
                <h3 className="t-label t-label--accent mb-2">{g.day}</h3>
                <ul className="flex flex-col gap-2">
                  {g.items.map((w) => (
                    <li key={w.id} className="t-panel flex items-center gap-3 p-2">
                      {w.media?.coverImage?.large ? (
                        <img src={w.media.coverImage.large} alt="" className="h-14 w-10 shrink-0 object-cover" />
                      ) : (
                        <div className="t-hatch h-14 w-10 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-t-primary">
                          {w.titleOverride || w.media?.title.romaji || w.remotePath.split('/').pop()}
                        </p>
                        <p className="text-[11px] text-t-muted">
                          {t('watch.nextEp', { n: w.nextEpisode })}
                          {w.nextEpisodeAbs && w.nextEpisodeAbs !== w.nextEpisode ? ` (${w.nextEpisodeAbs})` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono text-sm text-t-secondary" title={`${airFmt(w.nextAiringAt!, 'Asia/Tokyo')} JST`}>
                          {new Date(w.nextAiringAt! * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-[11px] text-accent">{countdown(w.nextAiringAt!)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )
      ) : (
        <div className="grid gap-6">
          {grouped.map(({ g, items }) => (
            <section key={g}>
              <div className="mb-3 flex items-center gap-2">
                <span className="t-label t-label--accent">{t(`watch.group.${g}`)}</span>
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="font-mono text-[11px] text-t-muted">{items.length}</span>
              </div>
              <ul className="grid grid-cols-1 gap-3">
                {items.map((w) => (
                  <li key={w.id} className="t-panel flex flex-wrap items-center gap-4 p-3">
              {w.media?.coverImage?.large ? (
                <img src={w.media.coverImage.large} alt="" className="h-20 w-14 shrink-0 object-cover" />
              ) : (
                <div className="t-hatch h-20 w-14 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-t-primary">
                  {w.titleOverride || w.media?.title.romaji || w.remotePath.split('/').pop()}
                </h3>
                <p className="truncate font-mono text-[11px] text-t-muted" title={w.remotePath}>
                  {w.serverName}:{w.remotePath} → downloads/{w.localPath}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-t-muted">
                  <span>
                    {t('watch.lastCheck')}: {ago(w.lastCheck)}
                    {w.lastResult
                      ? ` (${w.lastResult})`
                      : w.lastQueued >= 0 && ` (${t('watch.lastQueued', { count: w.lastQueued })})`}
                  </span>
                  {w.nextAiringAt ? (
                    <span className={`t-label ${w.behind ? 't-label--warn' : 't-label--ok'}`} title={`${airFmt(w.nextAiringAt, 'Asia/Tokyo')} JST`}>
                      {t('watch.nextEp', { n: w.nextEpisode })}
                      {w.nextEpisodeAbs && w.nextEpisodeAbs !== w.nextEpisode ? ` (${w.nextEpisodeAbs})` : ''} ·{' '}
                      {airFmt(w.nextAiringAt)}
                    </span>
                  ) : (
                    w.lastCheck && <span>{next(w)}</span>
                  )}
                  {(w.behind ?? 0) > 0 && (
                    <span className="t-label t-label--warn">{t('watch.behind', { count: w.behind })}</span>
                  )}
                  {(w.langWaiting ?? 0) > 0 && (
                    <span className="t-label t-label--warn">
                      {t('watch.langWaiting', {
                        count: w.langWaiting,
                        lang: [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/'),
                      })}
                    </span>
                  )}
                  {w.lastUploading > 0 && (
                    <span className="t-label t-label--warn">{t('watch.uploading')}</span>
                  )}
                  {(w.seenEpisodes ?? 0) > 0 && (
                    <span className="t-label">{t('watch.seen', { count: w.seenEpisodes })}</span>
                  )}
                  {(w.template || w.pattern) && <span className="t-label">{t('watch.renamed')}</span>}
                  {w.active > 0 && <span className="t-label t-label--accent">{t('watch.active', { count: w.active })}</span>}
                </p>
              </div>
              <div className="text-right text-xs">
                {w.media && w.media.episodes > 0 ? (
                  <p className={w.complete ? 'text-ok' : 'text-t-secondary'}>
                    {t('watch.episodes', { have: w.localFiles, total: w.media.episodes })}
                  </p>
                ) : (
                  <p className="text-t-secondary">{t('watch.files', { count: w.localFiles })}</p>
                )}
                {w.complete && (
                  <p className="mt-1 text-ok" role="status">
                    ✓ {t('watch.complete')}
                  </p>
                )}
              </div>
              <div className="flex w-full gap-1 sm:w-auto">
                <button className="t-btn t-btn--sm flex-1 sm:flex-initial" onClick={() => check(w.id)}>
                  {t('watch.checkNow')}
                </button>
                <button className="t-btn t-btn--sm flex-1 sm:flex-initial" onClick={() => setEdit(w)}>
                  {t('servers.edit')}
                </button>
                <button className="t-btn t-btn--sm t-btn--danger flex-1 sm:flex-initial" onClick={() => del(w)}>
                  {t('servers.delete')}
                </button>
              </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {edit && (
        <WatchDialog
          title={t('watch.editTitle')}
          serverId={edit.serverId}
          initial={{
            remotePath: edit.remotePath,
            localPath: edit.localPath,
            mode: edit.mode || 'template',
            template: edit.template,
            separator: edit.separator,
            titleOverride: edit.titleOverride,
            pattern: edit.pattern,
            replacement: edit.replacement,
            subfolder: edit.subfolder,
            mediaId: edit.mediaId,
            fromEpisode: edit.fromEpisode,
            wantDub: edit.wantDub ?? '',
            wantSub: edit.wantSub ?? '',
          }}
          onSave={async (f) => {
            await api.put(`/api/watches/${edit.id}`, f)
            refresh()
          }}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}
