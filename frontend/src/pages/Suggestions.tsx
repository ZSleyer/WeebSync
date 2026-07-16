import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AnilistSuggestions, type PlexSuggestions } from '../api'

// Suggestions, two sections: AniList lists watchlist titles (watching /
// planning) that exist on the user's servers via the remote index; Plex
// reads the configured show libraries and lists missing sequels, with the
// Plex storage folder for consistent placement.
export default function Suggestions() {
  const { t } = useTranslation()
  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
        <span className="t-label mt-1">{t('suggestions.sub')}</span>
      </header>
      <AnilistSection />
      <PlexSection />
    </div>
  )
}

// candidate row shared by both sections
function CandidateRow({ serverId, serverName, path }: { serverId: number; serverName: string; path: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-t-secondary" title={path}>
        {serverName}:{path}
      </span>
      <button
        className="t-btn t-btn--sm"
        onClick={() => navigate(`/browser?server=${serverId}&path=${encodeURIComponent(path)}`)}
      >
        {t('plex.openBrowser')}
      </button>
    </li>
  )
}

// AniList watchlist titles available on the user's servers.
function AnilistSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<AnilistSuggestions>({
    queryKey: ['anilist-suggestions'],
    queryFn: () => api.get('/api/anilist/suggestions'),
    refetchInterval: (q) => (q.state.data?.building ? 5000 : false),
  })

  return (
    <section className="mb-8" aria-label={t('suggestions.anilist')}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="t-label t-label--accent">{t('suggestions.anilist')}</span>
        {data?.connected && (
          <button
            className="t-btn t-btn--sm"
            onClick={async () => {
              await api.get('/api/anilist/suggestions?force=1')
              qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
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
      </div>
      {isLoading ? (
        <p className="text-sm text-t-muted">{t('app.loading')}</p>
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
                      await api.post('/api/anilist/progress', { mediaId: s.media.id, progress: s.progress + 1 })
                      qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
                    }}
                  >
                    {t('suggestions.plusOne')}
                  </button>
                </p>
                <ul className="mt-2 grid grid-cols-1 gap-1">
                  {s.candidates.map((c) => (
                    <CandidateRow key={c.path} serverId={c.serverId} serverName={c.serverName} path={c.path} />
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Plex: missing sequels of shows in the configured libraries.
function PlexSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<PlexSuggestions>({
    queryKey: ['plex-suggestions'],
    queryFn: () => api.get('/api/plex/suggestions'),
    refetchInterval: (q) => (q.state.data?.building ? 5000 : false),
  })

  const refresh = async () => {
    await api.get('/api/plex/suggestions?force=1')
    qc.invalidateQueries({ queryKey: ['plex-suggestions'] })
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
        <p className="text-sm text-t-muted" role="status">
          {t('app.loading')}
        </p>
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
            <li key={`${s.showTitle}-${s.sequel.id}`} className="t-panel p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-medium text-t-primary">
                  {s.showTitle} {s.year > 0 && <span className="text-t-muted">({s.year})</span>}
                </h3>
                <span className="text-xs text-t-muted">{t('plex.have', { have: s.leafCount, need: s.chainNeed })}</span>
              </div>
              <p className="mt-1 text-sm text-accent">
                {t('plex.missing')}: {s.sequel.title.romaji}
                {s.sequel.episodes > 0 && ` · ${t('watch.files', { count: s.sequel.episodes })}`}
                {s.sequel.status && ` · ${t('browser.status.' + s.sequel.status, s.sequel.status)}`}
                {' · '}
                <a className="underline" href={`https://anilist.co/anime/${s.sequel.id}`} target="_blank" rel="noreferrer">
                  AniList
                </a>
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
                      <CandidateRow key={c.path} serverId={c.serverId} serverName={c.serverName} path={c.path} />
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
