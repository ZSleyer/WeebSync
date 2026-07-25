import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Panel, Select } from '@weebsync/design-system'
import { api } from '../../api'
import { useConfirm } from '../../components/confirm'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'
import { EnvBadge, SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'

export default function Security() {
  const { t } = useTranslation()
  const { form, set, save, saved, locked, dirty } = useSettingsForm()

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
      <UnsavedGuard dirty={dirty} />
      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.auth')}>
        <Badge tone="accent">{t('settings.auth')}</Badge>
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
            <Input
              className="mt-1 font-mono"
              type="text"
              placeholder="192.168.0.0/16, 10.0.0.0/8"
              value={form.trustedNetworks}
              onChange={(e) => set('trustedNetworks', e.target.value)}
            />
            <span className="mt-1 block text-xs text-t-muted">{t('settings.trustedNetworksHint')}</span>
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.trustedProxies')}
            <EnvBadge show={locked('trustedProxies')} />
            <Input
              className="mt-1 font-mono"
              type="text"
              placeholder="172.30.0.0/16, 10.0.0.0/8"
              value={form.trustedProxies}
              disabled={locked('trustedProxies')}
              onChange={(e) => set('trustedProxies', e.target.value)}
            />
            <span className="mt-1 block text-xs text-t-muted">{t('settings.trustedProxiesHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-t-muted">
            <input
              type="checkbox"
              checked={form.forceHttps}
              disabled={locked('forceHttps')}
              onChange={(e) => set('forceHttps', e.target.checked)}
            />
            {t('settings.forceHttps')}
            <EnvBadge show={locked('forceHttps')} />
          </label>
          <span className="-mt-2 block text-xs text-t-muted">{t('settings.forceHttpsHint')}</span>
          <label className="text-xs text-t-muted">
            {t('settings.authMode')}
            <Select
              wrapperClassName="mt-1 max-w-sm"
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
            </Select>
          </label>

          <fieldset className="border border-border-subtle p-3">
            <Badge as="legend">
              {t('settings.oidc')} ·{' '}
              <span className={form.oidcEnabled ? 'text-ok' : 'text-t-muted'}>
                {form.oidcEnabled ? t('settings.oidcActive') : t('settings.oidcInactive')}
              </span>
            </Badge>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcProviderName')}
                <EnvBadge show={locked('oidcProviderName')} />
                <Input
                  className="mt-1"
                  placeholder="Authentik"
                  value={form.oidcProviderName}
                  disabled={locked('oidcProviderName')}
                  onChange={(e) => set('oidcProviderName', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcProviderNameHint')}</span>
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcIssuer')}
                <EnvBadge show={locked('oidcIssuer')} />
                <span className="mt-1 flex gap-2">
                  <Input
                    className="font-mono"
                    placeholder="https://auth.example.com/application/o/weebsync/"
                    value={form.oidcIssuer}
                    disabled={locked('oidcIssuer')}
                    onChange={(e) => set('oidcIssuer', e.target.value)}
                  />
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={!form.oidcIssuer || locked('oidcIssuer')}
                    onClick={discover}
                  >
                    {t('settings.oidcDiscover')}
                  </Button>
                </span>
                {discovered && (
                  <span className="mt-1 block" role="status">
                    {discovered}
                  </span>
                )}
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcClientId')}
                <EnvBadge show={locked('oidcClientId')} />
                <Input
                  className="mt-1 font-mono"
                  value={form.oidcClientId}
                  disabled={locked('oidcClientId')}
                  onChange={(e) => set('oidcClientId', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcClientSecret')}
                <EnvBadge show={locked('oidcClientSecret')} />
                <Input
                  className="mt-1 font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={form.oidcClientSecretSet ? t('settings.secretSet') : t('settings.secretUnset')}
                  value={form.oidcClientSecret ?? ''}
                  disabled={locked('oidcClientSecret')}
                  onChange={(e) => set('oidcClientSecret', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcRedirectUrl')}
                <EnvBadge show={locked('oidcRedirectUrl')} />
                <Input
                  className="mt-1 font-mono"
                  placeholder="https://weebsync.example.com/api/auth/oidc/callback"
                  value={form.oidcRedirectUrl}
                  disabled={locked('oidcRedirectUrl')}
                  onChange={(e) => set('oidcRedirectUrl', e.target.value)}
                />
              </label>
              <label className="text-xs text-t-muted sm:col-span-2">
                {t('settings.oidcClaim')}
                <EnvBadge show={locked('oidcClaim')} />
                <Input
                  className="mt-1 font-mono"
                  placeholder="groups"
                  value={form.oidcClaim}
                  disabled={locked('oidcClaim')}
                  onChange={(e) => set('oidcClaim', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcClaimHint')}</span>
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcAdminValues')}
                <EnvBadge show={locked('oidcAdminValues')} />
                <Input
                  className="mt-1 font-mono"
                  placeholder="admins"
                  value={form.oidcAdminValues}
                  disabled={locked('oidcAdminValues')}
                  onChange={(e) => set('oidcAdminValues', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.oidcAdminValuesHint')}</span>
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.oidcUserValues')}
                <EnvBadge show={locked('oidcUserValues')} />
                <Input
                  className="mt-1 font-mono"
                  placeholder="users"
                  value={form.oidcUserValues}
                  disabled={locked('oidcUserValues')}
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
      </Panel>
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
  const confirm = useConfirm()
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
    <Panel as="section" className="mb-4 p-5" aria-label={t('settings.apiTokenTitle')}>
      <Badge tone="accent">{t('settings.apiTokenTitle')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('settings.apiTokenHint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={isSet ? 'ok' : 'neutral'}>
          {isSet ? t('settings.apiTokenSet') : t('settings.apiTokenNotSet')}
        </Badge>
        <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
          {isSet ? t('settings.apiTokenRegenerate') : t('settings.apiTokenGenerate')}
        </Button>
        {isSet && (
          <Button
            size="sm"
            variant="danger"
            disabled={revoke.isPending}
            onClick={async () => {
              if (await confirm({ message: t('settings.apiTokenConfirmRevoke'), destructive: true })) revoke.mutate()
            }}
          >
            {t('settings.apiTokenRevoke')}
          </Button>
        )}
      </div>
      {token && (
        <div className="mt-3">
          <label className="text-xs text-t-muted">
            {t('settings.apiTokenShowOnce')}
            <span className="mt-1 flex gap-2">
              <Input className="font-mono" readOnly value={token} onFocus={(e) => e.target.select()} />
              <Button
                size="sm"
                className="shrink-0"
                onClick={async () => {
                  await navigator.clipboard.writeText(token)
                  setCopied(true)
                }}
              >
                {t('settings.apiTokenCopy')}
              </Button>
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
    </Panel>
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
    <Panel as="section" className="mb-4 p-5" aria-label={t('settings.rateLimit')}>
      <Badge tone="accent">{t('settings.rateLimit')}</Badge>
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
                <Badge tone={s.blocked ? 'err' : 'neutral'}>
                  {s.blocked ? t('settings.rateLimitBlocked') : t('settings.rateLimitOk')}
                </Badge>
                <Button size="sm" disabled={reset.isPending} onClick={() => reset.mutate(s.ip)}>
                  {t('settings.rateLimitUnblock')}
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-3" disabled={resetAll.isPending} onClick={() => resetAll.mutate()}>
            {t('settings.rateLimitUnblockAll')}
          </Button>
        </>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}
