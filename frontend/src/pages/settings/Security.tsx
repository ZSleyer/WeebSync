import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'
import { SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'

export default function Security() {
  const { t } = useTranslation()
  const { form, set, save, saved } = useSettingsForm()

  const [discovered, setDiscovered] = useState('')
  const discover = async () => {
    if (!form?.oidcIssuer) return
    setDiscovered('')
    try {
      const out = await api.post<{ issuer: string }>('/api/auth/oidc/discover', { url: form.oidcIssuer })
      set('oidcIssuer', out.issuer)
      setDiscovered(t('settings.oidcDiscoverFound', { issuer: out.issuer }))
    } catch (err) {
      setDiscovered(err instanceof Error ? err.message : t('app.error'))
    }
  }

  if (!form) return null

  return (
    <>
      <section className="t-panel mb-4 p-5" aria-label={t('settings.auth')}>
        <span className="t-label t-label--accent">{t('settings.auth')}</span>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm text-t-secondary">
            <input
              type="checkbox"
              checked={form.registrationDisabled}
              onChange={(e) => set('registrationDisabled', e.target.checked)}
            />
            {t('settings.registrationDisabled')}
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.trustedNetworks')}
            <input
              className="t-input mt-1 font-mono"
              type="text"
              placeholder="192.168.0.0/16, 10.0.0.0/8"
              value={form.trustedNetworks}
              onChange={(e) => set('trustedNetworks', e.target.value)}
            />
            <span className="mt-1 block text-xs text-t-muted">{t('settings.trustedNetworksHint')}</span>
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.authMode')}
            <span className="t-select-wrap mt-1 max-w-sm">
              <select
                className="t-select"
                value={form.authMode}
                onChange={(e) => set('authMode', e.target.value as SettingsState['authMode'])}
              >
                <option value="password">{t('settings.authModePassword')}</option>
                <option value="oidc-only" disabled={!form.oidcIssuer}>
                  {t('settings.authModeOidcOnly')}
                </option>
                <option value="oidc-auto" disabled={!form.oidcIssuer}>
                  {t('settings.authModeOidcAuto')}
                </option>
              </select>
            </span>
          </label>

          <fieldset className="border border-border-subtle p-3">
            <legend className="t-label">
              {t('settings.oidc')} ·{' '}
              <span className={form.oidcEnabled ? 'text-ok' : 'text-t-muted'}>
                {form.oidcEnabled ? t('settings.oidcActive') : t('settings.oidcInactive')}
              </span>
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcProviderName')}
                <input
                  className="t-input mt-1"
                  placeholder="Authentik"
                  value={form.oidcProviderName}
                  onChange={(e) => set('oidcProviderName', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcProviderNameHint')}</span>
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcIssuer')}
                <span className="mt-1 flex gap-2">
                  <input
                    className="t-input font-mono"
                    placeholder="https://auth.example.com/application/o/weebsync/"
                    value={form.oidcIssuer}
                    onChange={(e) => set('oidcIssuer', e.target.value)}
                  />
                  <button
                    type="button"
                    className="t-btn t-btn--sm shrink-0"
                    disabled={!form.oidcIssuer}
                    onClick={discover}
                  >
                    {t('settings.oidcDiscover')}
                  </button>
                </span>
                {discovered && (
                  <span className="mt-1 block" role="status">
                    {discovered}
                  </span>
                )}
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcClientId')}
                <input
                  className="t-input mt-1 font-mono"
                  value={form.oidcClientId}
                  onChange={(e) => set('oidcClientId', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcClientSecret')}
                <input
                  className="t-input mt-1 font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={form.oidcClientSecretSet ? t('settings.secretSet') : t('settings.secretUnset')}
                  value={form.oidcClientSecret ?? ''}
                  onChange={(e) => set('oidcClientSecret', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcRedirectUrl')}
                <input
                  className="t-input mt-1 font-mono"
                  placeholder="https://weebsync.example.com/api/auth/oidc/callback"
                  value={form.oidcRedirectUrl}
                  onChange={(e) => set('oidcRedirectUrl', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcClaim')}
                <input
                  className="t-input mt-1 font-mono"
                  placeholder="groups"
                  value={form.oidcClaim}
                  onChange={(e) => set('oidcClaim', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcClaimHint')}</span>
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcAdminValues')}
                <input
                  className="t-input mt-1 font-mono"
                  placeholder="admins"
                  value={form.oidcAdminValues}
                  onChange={(e) => set('oidcAdminValues', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcAdminValuesHint')}</span>
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcUserValues')}
                <input
                  className="t-input mt-1 font-mono"
                  placeholder="users"
                  value={form.oidcUserValues}
                  onChange={(e) => set('oidcUserValues', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcUserValuesHint')}</span>
              </label>
              <p className="text-xs text-t-muted sm:col-span-2">{t('settings.oidcAdminHint')}</p>
            </div>
            {form.oidcError && (
              <p className="mt-2 text-xs text-err" role="alert">
                {form.oidcError}
              </p>
            )}
            <p className="mt-2 text-xs text-t-muted">{t('settings.oidcMigrationHint')}</p>
          </fieldset>
        </div>
      </section>
      <SaveBar form={form} save={save} saved={saved} />
      <ApiTokenSection />
      <RateLimitSection />
    </>
  )
}

// Single machine token for the REST status API (Home Assistant etc.).
// Only the hash is stored server-side, so the raw token shows exactly once.
// Reads ['settings'] directly (not the one-shot form) so the set/not-set
// badge follows the invalidations from generate/revoke.
function ApiTokenSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: settings } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  const tokenSet = !!settings?.apiTokenSet
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => {
    setError('')
    qc.invalidateQueries({ queryKey: ['settings'] })
  }
  const generate = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api/settings/token'),
    onSuccess: (out) => {
      setToken(out.token)
      setCopied(false)
      refresh()
    },
    onError: (e: Error) => setError(e.message),
  })
  const revoke = useMutation({
    mutationFn: () => api.del('/api/settings/token'),
    onSuccess: () => {
      setToken('')
      refresh()
    },
    onError: (e: Error) => setError(e.message),
  })
  const isSet = tokenSet || !!token

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.apiTokenTitle')}>
      <span className="t-label t-label--accent">{t('settings.apiTokenTitle')}</span>
      <p className="mt-2 text-xs text-t-muted">{t('settings.apiTokenHint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={`t-label ${isSet ? 't-label--ok' : ''}`}>
          {isSet ? t('settings.apiTokenSet') : t('settings.apiTokenNotSet')}
        </span>
        <button className="t-btn t-btn--sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
          {isSet ? t('settings.apiTokenRegenerate') : t('settings.apiTokenGenerate')}
        </button>
        {isSet && (
          <button
            className="t-btn t-btn--sm t-btn--danger"
            disabled={revoke.isPending}
            onClick={() => {
              if (confirm(t('settings.apiTokenConfirmRevoke'))) revoke.mutate()
            }}
          >
            {t('settings.apiTokenRevoke')}
          </button>
        )}
      </div>
      {token && (
        <div className="mt-3">
          <label className="text-xs text-t-muted">
            {t('settings.apiTokenShowOnce')}
            <span className="mt-1 flex gap-2">
              <input className="t-input font-mono" readOnly value={token} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="t-btn t-btn--sm shrink-0"
                onClick={async () => {
                  await navigator.clipboard.writeText(token)
                  setCopied(true)
                }}
              >
                {t('settings.apiTokenCopy')}
              </button>
            </span>
          </label>
          {copied && (
            <p className="mt-1 text-xs text-ok" role="status">
              {t('settings.apiTokenCopied')}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

interface IpStatus {
  ip: string
  blocked: boolean
  tokens: number
}

function RateLimitSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data: ips } = useQuery<IpStatus[]>({
    queryKey: ['ratelimit'],
    queryFn: () => api.get('/api/auth/ratelimit'),
    refetchInterval: 10000,
  })
  const opts = {
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['ratelimit'] })
    },
    onError: (e: Error) => setError(e.message),
  }
  const reset = useMutation({ mutationFn: (ip: string) => api.post('/api/auth/ratelimit/reset', { ip }), ...opts })
  const resetAll = useMutation({ mutationFn: () => api.post('/api/auth/ratelimit/reset', { all: true }), ...opts })

  const list = ips ?? []
  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.rateLimit')}>
      <span className="t-label t-label--accent">{t('settings.rateLimit')}</span>
      <p className="mt-2 text-xs text-t-muted">{t('settings.rateLimitHint')}</p>
      {list.length === 0 ? (
        <p className="mt-3 text-sm text-t-secondary">{t('settings.rateLimitEmpty')}</p>
      ) : (
        <>
          <ul className="mt-3 grid grid-cols-1 gap-2">
            {list.map((s) => (
              <li key={s.ip} className="flex flex-wrap items-center gap-2 border-b border-border-subtle pb-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-secondary" title={s.ip}>
                  {s.ip}
                </span>
                <span className={`t-label ${s.blocked ? 't-label--err' : ''}`}>
                  {s.blocked ? t('settings.rateLimitBlocked') : t('settings.rateLimitOk')}
                </span>
                <button className="t-btn t-btn--sm" disabled={reset.isPending} onClick={() => reset.mutate(s.ip)}>
                  {t('settings.rateLimitUnblock')}
                </button>
              </li>
            ))}
          </ul>
          <button className="t-btn t-btn--sm mt-3" disabled={resetAll.isPending} onClick={() => resetAll.mutate()}>
            {t('settings.rateLimitUnblockAll')}
          </button>
        </>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
