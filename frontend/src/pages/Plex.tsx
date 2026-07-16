import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { api, type PlexSuggestions } from '../api'

// Plex: reads the configured Plex show libraries, matches them against
// AniList and lists missing sequels, with the Plex storage folder (to keep
// a series in one place) and remote folder candidates from the index.
export default function Plex() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
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
    <div className="max-w-4xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('plex.title')}</h2>
          <span className="t-label mt-1">{t('plex.sub')}</span>
        </div>
        {data?.configured && (
          <div className="flex items-center gap-2">
            {data.building && (
              <span className="text-xs text-t-muted" role="status">
                {t('plex.building')}
              </span>
            )}
            <button className="t-btn t-btn--sm" onClick={refresh}>
              {t('plex.refresh')}
            </button>
          </div>
        )}
      </header>

      {isLoading ? (
        <p className="text-sm text-t-muted" role="status">
          {t('app.loading')}
        </p>
      ) : !data?.configured ? (
        <div className="t-panel p-8 text-center text-t-muted">
          <Trans i18nKey="plex.notConfigured">
            Plex ist nicht eingerichtet. URL und Token unter <Link to="/settings" className="text-accent underline">Einstellungen</Link> hinterlegen.
          </Trans>
        </div>
      ) : data.suggestions.length === 0 ? (
        <div className="t-panel p-8 text-center text-t-muted">
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
                <span className="text-xs text-t-muted">
                  {t('plex.have', { have: s.leafCount, need: s.chainNeed })}
                </span>
              </div>
              <p className="mt-1 text-sm text-accent">
                {t('plex.missing')}: {s.sequel.title.romaji}
                {s.sequel.episodes > 0 && ` · ${t('watch.files', { count: s.sequel.episodes })}`}
                {s.sequel.status && ` · ${t('browser.status.' + s.sequel.status, s.sequel.status)}`}
                {' · '}
                <a
                  className="underline"
                  href={`https://anilist.co/anime/${s.sequel.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
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
                      <li key={c.path} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-t-secondary" title={c.path}>
                          {c.serverName}:{c.path}
                        </span>
                        <button
                          className="t-btn t-btn--sm"
                          onClick={() =>
                            navigate(`/browser?server=${c.serverId}&path=${encodeURIComponent(c.path)}`)
                          }
                        >
                          {t('plex.openBrowser')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
