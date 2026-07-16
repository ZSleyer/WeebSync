import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AnilistSuggestions, type PlexSuggestions } from '../api'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { usePersistedQuery } from '../hooks'
import { SkeletonCards } from '../components/Loading'

// Suggestions, two sections: AniList lists watchlist titles (watching /
// planning) that exist on the user's servers via the remote index; Plex
// reads the configured show libraries and lists missing sequels, with the
// Plex storage folder for consistent placement.
export default function Suggestions() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'plex' | 'anilist'>('plex')
  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
        <span className="t-label mt-1">{t('suggestions.sub')}</span>
      </header>
      <div role="group" aria-label={t('suggestions.title')} className="mb-4 flex">
        <button
          className={`t-btn t-btn--sm ${tab === 'plex' ? 't-btn--primary' : ''}`}
          aria-pressed={tab === 'plex'}
          onClick={() => setTab('plex')}
        >
          Plex
        </button>
        <button
          className={`t-btn t-btn--sm ${tab === 'anilist' ? 't-btn--primary' : ''}`}
          aria-pressed={tab === 'anilist'}
          onClick={() => setTab('anilist')}
        >
          AniList
        </button>
      </div>
      {tab === 'plex' ? <PlexSection /> : <AnilistSection />}
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
  // otherwise empty — the sync then creates the remote folder name, and the
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
      ) : !data?.connected ? (
        <div className="t-panel p-6 text-center text-sm text-t-muted">
          <Trans i18nKey="suggestions.notConnected">
            Kein AniList-Konto verbunden. Unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> verbinden.
          </Trans>
        </div>
      ) : data.suggestions.length === 0 ? (
        <div className="t-panel p-6 text-center text-sm text-t-muted">
          {data.building ? t('plex.buildingLong') : t('suggestions.anilistEmpty')}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {data.suggestions.map((s) => (
            <li key={s.media.id} className="t-panel flex flex-wrap items-center gap-4 p-3">
              {s.media.coverImage?.large ? (
                <img src={s.media.coverImage.large} alt="" className="h-20 w-14 shrink-0 object-cover" />
              ) : (
                <div className="t-hatch h-20 w-14 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-t-primary">{s.media.title.romaji}</h3>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-t-muted">
                  <span className={`t-label ${s.status === 'CURRENT' ? 't-label--accent' : ''}`}>
                    {t(`suggestions.status${s.status}`)}
                  </span>
                  {s.media.episodes > 0 && (
                    <span>{t('suggestions.seen', { seen: s.progress, total: s.media.episodes })}</span>
                  )}
                  {s.media.status && <span>{t(`browser.status.${s.media.status}`, s.media.status)}</span>}
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
                </p>
                {s.plexFolder && (
                  <p className="mt-1 truncate font-mono text-[11px] text-t-muted" title={s.plexFolder}>
                    {t('suggestions.plexFolder')}: {s.plexFolder}
                  </p>
                )}
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
              </div>
            </li>
          ))}
        </ul>
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
    // movies get no SxxEyy episode template — empty template = no rename
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
        <ul className="grid grid-cols-1 gap-3">
          {data.suggestions.map((s) => (
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
