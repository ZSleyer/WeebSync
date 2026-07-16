import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'
import { SaveBar, useSettingsForm } from './useSettingsForm'

export default function Integrations() {
  const { t } = useTranslation()
  const { form, set, save, saved } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <section className="t-panel mb-4 p-5" aria-label={t('settings.integrations')}>
        <span className="t-label t-label--accent">{t('settings.integrations')}</span>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <span className="t-label">AniList</span>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-t-muted">
              {t('settings.anilistClientId')}
              <input
                className="t-input mt-1 font-mono"
                value={form.anilistClientId}
                onChange={(e) => set('anilistClientId', e.target.value)}
              />
            </label>
            <label className="text-xs text-t-muted">
              {t('settings.anilistClientSecret')}
              <input
                className="t-input mt-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={form.anilistSecretSet ? t('settings.secretSet') : t('settings.secretUnset')}
                value={form.anilistClientSecret ?? ''}
                onChange={(e) => set('anilistClientSecret', e.target.value)}
              />
            </label>
          </div>
          <label className="text-xs text-t-muted">
            {t('settings.anilistRedirectUrl')}
            <input
              className="t-input mt-1 font-mono"
              placeholder={`${window.location.origin}/api/anilist/callback`}
              value={form.anilistRedirectUrl}
              onChange={(e) => set('anilistRedirectUrl', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.anilistClientHint')}</span>
          </label>
          <AnilistAccount />
        </div>
        <label className="mt-3 block text-xs text-t-muted">
          {t('settings.tmdbApiKey')}
          <input
            className="t-input mt-1 font-mono"
            type="password"
            autoComplete="off"
            placeholder={form.tmdbApiKeySet ? t('settings.secretSet') : t('settings.secretUnset')}
            value={form.tmdbApiKey ?? ''}
            onChange={(e) => set('tmdbApiKey', e.target.value)}
          />
          <span className="mt-1 block">{t('settings.tmdbApiKeyHint')}</span>
        </label>

        <div className="mt-5 grid grid-cols-1 gap-4">
          <span className="t-label">{t('settings.plex')}</span>
          <label className="text-xs text-t-muted">
            {t('settings.plexUrl')}
            <input
              className="t-input mt-1 font-mono"
              placeholder="https://plex.example.com"
              value={form.plexUrl}
              onChange={(e) => set('plexUrl', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.plexUrlHint')}</span>
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.plexToken')}
            <input
              className="t-input mt-1 font-mono"
              type="password"
              autoComplete="off"
              placeholder={form.plexTokenSet ? t('settings.secretSet') : t('settings.secretUnset')}
              value={form.plexToken ?? ''}
              onChange={(e) => set('plexToken', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.plexTokenHint')}</span>
          </label>
          {form.plexTokenSet && form.plexUrl && (
            <PlexSections value={form.plexSections} onChange={(v) => set('plexSections', v)} />
          )}
        </div>
      </section>
      <SaveBar form={form} save={save} saved={saved} />
    </>
  )
}

// Plex show sections as checkboxes (empty selection = all show sections).
function PlexSections({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const { data: sections = [], error } = useQuery<{ key: string; type: string; title: string }[]>({
    queryKey: ['plex-sections'],
    queryFn: () => api.get('/api/plex/sections'),
    retry: false,
  })
  const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next].join(','))
  }
  if (error)
    return (
      <p className="text-xs text-err" role="alert">
        {(error as Error).message}
      </p>
    )
  return (
    <fieldset className="text-xs text-t-muted">
      <legend>{t('settings.plexSections')}</legend>
      <div className="mt-1 flex flex-wrap gap-3">
        {sections.map((s) => (
          <label key={s.key} className="flex items-center gap-1.5 text-t-secondary">
            <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggle(s.key)} />
            {s.title}
            {s.type === 'movie' && <span className="t-label">{t('settings.plexMovies')}</span>}
          </label>
        ))}
      </div>
      <p className="mt-1">{t('settings.plexSectionsHint')}</p>
    </fieldset>
  )
}

// Linked AniList account of the current user (OAuth). Connecting redirects
// to AniList; tokens live about a year, so an expiry hint prompts re-connect.
function AnilistAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [pinToken, setPinToken] = useState('')
  const { data } = useQuery<{ configured: boolean; clientId?: string; connected: boolean; name?: string; expiresAt?: string }>({
    queryKey: ['anilist-me'],
    queryFn: () => api.get('/api/anilist/me'),
  })
  const connectPin = useMutation({
    mutationFn: () => api.post('/api/anilist/token', { token: pinToken }),
    onSuccess: () => {
      setPinToken('')
      setError('')
      qc.invalidateQueries({ queryKey: ['anilist-me'] })
      qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
    },
    onError: (e: Error) => setError(e.message),
  })
  if (!data) return null
  const expires = data.expiresAt ? Date.parse(data.expiresAt.replace(' ', 'T') + 'Z') : 0
  const expiringSoon = expires > 0 && expires - Date.now() < 30 * 86_400_000
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        <>
          <span className="t-label t-label--ok">{t('settings.anilistConnectedAs', { name: data.name })}</span>
          {expires > 0 && (
            <span className={expiringSoon ? 'text-warn' : ''}>
              {t('settings.anilistExpires', { date: new Date(expires).toLocaleDateString() })}
              {expiringSoon && ` ${t('settings.anilistReconnect')}`}
            </span>
          )}
          <button
            className="t-btn t-btn--sm"
            onClick={async () => {
              try {
                await api.del('/api/anilist/connect')
                setError('')
                qc.invalidateQueries({ queryKey: ['anilist-me'] })
                qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
              } catch (err) {
                setError(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('settings.anilistDisconnect')}
          </button>
          {error && (
            <span className="text-err" role="alert">
              {error}
            </span>
          )}
        </>
      ) : (
        <div className="grid w-full grid-cols-1 gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="t-btn t-btn--sm"
              disabled={!data.configured}
              onClick={() => (window.location.href = '/api/anilist/connect')}
            >
              {t('settings.anilistConnect')}
            </button>
            {!data.configured && <span>{t('settings.anilistNotConfigured')}</span>}
          </div>
          {/* pin flow: token pasted by the user — no secret, no redirect URL */}
          <label className="text-xs text-t-muted">
            {t('settings.anilistPinLabel')}
            <span className="mt-1 flex gap-2">
              <input
                className="t-input font-mono"
                type="password"
                autoComplete="off"
                placeholder={t('settings.anilistPinPlaceholder')}
                value={pinToken}
                onChange={(e) => setPinToken(e.target.value)}
              />
              <button
                type="button"
                className="t-btn t-btn--sm shrink-0"
                disabled={!pinToken.trim() || connectPin.isPending}
                onClick={() => connectPin.mutate()}
              >
                {t('settings.anilistPinConnect')}
              </button>
            </span>
            <span className="mt-1 block">
              {data.clientId ? (
                <a
                  className="text-accent underline"
                  href={`https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(data.clientId)}&response_type=token`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('settings.anilistPinGet')}
                </a>
              ) : (
                t('settings.anilistPinHint')
              )}
            </span>
          </label>
          {error && (
            <span className="text-err" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
