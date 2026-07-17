import { useState } from 'react'
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

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('watch.title')}</h2>
        <span className="t-label mt-1">{t('watch.sub')}</span>
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
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {watches.map((w) => (
            <li key={w.id} className="t-panel flex flex-wrap items-center gap-4 p-3">
              {w.media?.coverImage?.large ? (
                <img src={w.media.coverImage.large} alt="" className="h-20 w-14 shrink-0 object-cover" />
              ) : (
                <div className="t-hatch h-20 w-14 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-t-primary">
                  {w.media?.title.romaji ?? w.remotePath.split('/').pop()}
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
                  {w.waiting && w.nextAiringAt ? (
                    <span className="t-label t-label--ok">
                      {t('watch.waitingFor', { n: w.nextEpisode })} ·{' '}
                      {new Date(w.nextAiringAt * 1000).toLocaleString([], {
                        weekday: 'short',
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  ) : (
                    w.lastCheck && <span>{next(w)}</span>
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
