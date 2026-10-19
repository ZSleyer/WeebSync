import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from 'fluid-lycoris'
import { api } from '../../api'
import { updateText, useAuth, useVersion } from '../../hooks'
import Brand from '../../components/Brand'
import { ProviderMark } from '../../components/SourceLine'
import { SettingsPanel, SwitchSetting } from './ui'

// read once per page load; the year does not change during a session
const year = new Date().getFullYear()
const copyright = year <= 2026 ? '© 2026 ZSleyer' : `© 2026–${year} ZSleyer`

export default function About() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data } = useVersion()

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post('/api/version/update-check', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['version'] }),
  })

  const repoUrl = data?.repo ? `https://github.com/${data.repo}` : undefined
  const licenseUrl = repoUrl ? `${repoUrl}/blob/main/LICENSE` : 'https://www.gnu.org/licenses/agpl-3.0'

  return (
    <SettingsPanel className="set-about">
      <div className="set-about-brand font-display text-2xl font-bold tracking-[0.2em]">
        <Brand variant="about" slogan={t('app.tagline')} />
      </div>
      <p className="set-about-v">
        {data && (
          <Badge tone={data.channel === 'stable' ? 'ok' : data.channel === 'nightly' ? 'accent' : 'warn'}>
            {t(`about.channel.${data.channel}`, data.channel)}
          </Badge>
        )}
        <span className="font-mono">
          {data?.version}
          {data?.commit ? ` · ${data.commit.slice(0, 7)}` : ''}
        </span>
      </p>

      {data?.updateAvailable && (
        <p className="sf-note">
          <span className="text-warn">{updateText(t, data)}</span>
          {data.url && (
            <>
              {' '}
              <a href={data.url} target="_blank" rel="noreferrer" className="t-link">
                {t('about.updateLink')} <ExternalLink aria-hidden size="1em" />
              </a>
            </>
          )}
        </p>
      )}

      <p className="sf-note">
        {t('about.licenseLine')}{' '}
        <a href={licenseUrl} target="_blank" rel="noreferrer" className="t-link">
          AGPL-3.0
        </a>
        {repoUrl && (
          <>
            {' · '}
            <a href={repoUrl} target="_blank" rel="noreferrer" className="t-link">
              {t('about.source')} <ExternalLink aria-hidden size="1em" />
            </a>
          </>
        )}
        {' · '}
        {copyright}
      </p>

      <ul className="set-about-credits" aria-label={t('about.creditsTitle')}>
        <li>
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
            <ProviderMark name="TMDB" />
          </a>
          {/* TMDB's terms prescribe this wording */}
          <span className="sf-note">This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
        </li>
        <li>
          <a href="https://thetvdb.com" target="_blank" rel="noreferrer">
            <ProviderMark name="TVDB" />
          </a>
          <span className="sf-note">{t('about.tvdbNote')}</span>
        </li>
        <li>
          <a href="https://anilist.co" target="_blank" rel="noreferrer">
            <ProviderMark name="AniList" />
          </a>
          <span className="sf-note">{t('about.anilistNote')}</span>
        </li>
        <li>
          {/* the CC BY 4.0 terms of the database prescribe this link text */}
          <a href="https://db-ip.com" target="_blank" rel="noopener" className="t-link">
            IP Geolocation by DB-IP
          </a>
          <span className="sf-note">{t('about.dbipNote')}</span>
        </li>
      </ul>

      {user?.isAdmin && data && (
        <SwitchSetting
          label={t('about.updateCheckToggle')}
          checked={data.updateCheck}
          disabled={toggle.isPending}
          onChange={(on) => toggle.mutate(on)}
        />
      )}
    </SettingsPanel>
  )
}
