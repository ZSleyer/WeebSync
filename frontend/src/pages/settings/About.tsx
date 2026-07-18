import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'
import { useAuth } from '../../hooks'

interface VersionInfo {
  version: string
  channel: string
  commit: string
  repo: string
  updateCheck: boolean
  updateAvailable: boolean
  latest: string
  url: string
}

export default function About() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data } = useQuery<VersionInfo>({ queryKey: ['version'], queryFn: () => api.get('/api/version') })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post('/api/version/update-check', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['version'] }),
  })

  const year = new Date().getFullYear()
  const copyright = year <= 2026 ? '© 2026 ZSleyer' : `© 2026–${year} ZSleyer`
  const dev = data ? data.channel !== 'stable' : false
  const repoUrl = data?.repo ? `https://github.com/${data.repo}` : undefined

  return (
    <section className="max-w-xl" aria-label={t('settings.nav.about')}>
      <div className="t-panel space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg font-bold tracking-[0.2em] text-t-primary">
            WEEB<span className="text-accent">SYNC</span>
          </h2>
          {data && (
            <span className={`t-label ${data.channel === 'stable' ? 't-label--ok' : data.channel === 'nightly' ? 't-label--accent' : 't-label--warn'}`}>
              {t(`about.channel.${data.channel}`, data.channel)}
            </span>
          )}
          <span className="font-mono text-xs text-t-muted">
            {data?.version}
            {data?.commit ? ` · ${data.commit.slice(0, 7)}` : ''}
          </span>
        </div>

        <p className="text-xs text-t-muted">{t('app.tagline')}</p>

        {data?.updateAvailable && (
          <div className="border border-warn/40 bg-warn/5 px-4 py-3 text-sm">
            <span className="text-warn">
              {dev ? t('about.updateDev') : t('about.updateStable', { version: data.latest })}
            </span>
            {data.url && (
              <>
                {' '}
                <a href={data.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {t('about.updateLink')} ↗
                </a>
              </>
            )}
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-t-muted">{t('about.license')}</dt>
          <dd>
            <a
              href={repoUrl ? `${repoUrl}/blob/main/LICENSE` : 'https://www.gnu.org/licenses/agpl-3.0'}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              AGPL-3.0
            </a>
          </dd>
          <dt className="text-t-muted">{t('about.source')}</dt>
          <dd>
            {repoUrl ? (
              <a href={repoUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {data?.repo} ↗
              </a>
            ) : (
              <span className="text-t-muted">-</span>
            )}
          </dd>
          <dt className="text-t-muted">{t('about.copyright')}</dt>
          <dd className="text-t-secondary">{copyright}</dd>
        </dl>

        {user?.isAdmin && data && (
          <label className="flex items-center gap-2 border-t border-border-subtle pt-4 text-sm text-t-secondary">
            <input
              type="checkbox"
              checked={data.updateCheck}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            {t('about.updateCheckToggle')}
          </label>
        )}
      </div>
    </section>
  )
}
