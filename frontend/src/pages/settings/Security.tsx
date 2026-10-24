import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Row, RowAction, Rows, Select, SettingsField } from 'fluid-lycoris'
import { api } from '../../api'
import { useConfirm } from '../../components/confirm'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'
import { SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'
import { EnvChip, ListSetting, LoadGate, SecretSetting, SettingsPanel, SwitchSetting, TextSetting } from './ui'
import Users from './Users'
import { copyText } from '../../clipboard'
import './security.css'

// The backend keeps these lists as CSV; the form shows one entry per line.
// Nothing is trimmed while typing (a group name may hold a space), the
// backend trims and skips empty entries.
export const csvToLines = (csv: string) =>
  csv
    .split(',')
    .map((p) => p.trimStart())
    .join('\n')
export const linesToCsv = (lines: string) => lines.split('\n').join(',')

export default function Security() {
  const { t } = useTranslation()
  const { form, set, save, saved, locked, dirty, reset, clearSecret, isError, refetch } = useSettingsForm()
  const modeId = useId()
  const issuerId = useId()

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

  if (!form) return <LoadGate error={isError} onRetry={() => refetch()} />

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <SecurityReview />
      <SettingsPanel title={t('settings.auth')}>
        <SettingsField label={t('settings.authMode')} htmlFor={modeId}>
          <Select
            id={modeId}
            wrapperClassName="max-w-sm"
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
        </SettingsField>
        <SwitchSetting
          label={t('settings.registrationDisabled')}
          checked={form.registrationDisabled}
          onChange={(v) => set('registrationDisabled', v)}
        />
        <ListSetting
          label={t('settings.trustedNetworks')}
          hint={t('settings.trustedNetworksHint')}
          placeholder={'192.168.0.0/16\n10.0.0.0/8'}
          value={csvToLines(form.trustedNetworks)}
          onChange={(v) => set('trustedNetworks', linesToCsv(v))}
        />
        <ListSetting
          label={t('settings.trustedProxies')}
          hint={t('settings.trustedProxiesHint')}
          env={locked('trustedProxies')}
          placeholder={'172.30.0.0/16'}
          value={csvToLines(form.trustedProxies)}
          onChange={(v) => set('trustedProxies', linesToCsv(v))}
        />
        <SwitchSetting
          label={t('settings.forceHttps')}
          hint={t('settings.forceHttpsHint')}
          env={locked('forceHttps')}
          checked={form.forceHttps}
          onChange={(v) => set('forceHttps', v)}
        />
        <SwitchSetting
          label={t('settings.geoipEnabled')}
          hint={t('settings.geoipEnabledHint')}
          checked={form.geoipEnabled}
          onChange={(v) => set('geoipEnabled', v)}
        />
      </SettingsPanel>

      <SettingsPanel
        id="oidc"
        title={t('settings.oidc')}
        badge={
          <Badge tone={form.oidcEnabled ? 'ok' : 'neutral'}>
            {form.oidcEnabled ? t('settings.oidcActive') : t('settings.oidcInactive')}
          </Badge>
        }
      >
        <TextSetting
          label={t('settings.oidcProviderName')}
          hint={t('settings.oidcProviderNameHint')}
          env={locked('oidcProviderName')}
          placeholder="Authentik"
          value={form.oidcProviderName}
          onChange={(v) => set('oidcProviderName', v)}
        />
        <SettingsField
          label={t('settings.oidcIssuer')}
          htmlFor={issuerId}
          badge={<EnvChip show={locked('oidcIssuer')} />}
          hint={discovered ? <span role="status">{discovered}</span> : undefined}
        >
          <span className="flex gap-2">
            <Input
              id={issuerId}
              kind="url"
              className="font-mono"
              placeholder="https://auth.example.com/application/o/weebsync/"
              value={form.oidcIssuer}
              readOnly={locked('oidcIssuer')}
              onChange={(e) => set('oidcIssuer', e.target.value)}
            />
            <Button className="shrink-0" disabled={!form.oidcIssuer || locked('oidcIssuer')} onClick={discover}>
              {t('settings.oidcDiscover')}
            </Button>
          </span>
        </SettingsField>
        <div className="sf-2">
          <TextSetting
            label={t('settings.oidcClientId')}
            env={locked('oidcClientId')}
            mono
            value={form.oidcClientId}
            onChange={(v) => set('oidcClientId', v)}
          />
          <SecretSetting
            label={t('settings.oidcClientSecret')}
            env={locked('oidcClientSecret')}
            stored={form.oidcClientSecretSet}
            value={form.oidcClientSecret ?? ''}
            onChange={(v) => set('oidcClientSecret', v)}
            onRemove={() => clearSecret('oidcClientSecret')}
          />
        </div>
        <TextSetting
          label={t('settings.oidcRedirectUrl')}
          env={locked('oidcRedirectUrl')}
          mono
          placeholder="https://weebsync.example.com/api/auth/oidc/callback"
          value={form.oidcRedirectUrl}
          onChange={(v) => set('oidcRedirectUrl', v)}
        />
        <TextSetting
          label={t('settings.oidcClaim')}
          hint={t('settings.oidcClaimHint')}
          env={locked('oidcClaim')}
          mono
          placeholder="groups"
          value={form.oidcClaim}
          onChange={(v) => set('oidcClaim', v)}
        />
        <ListSetting
          label={t('settings.oidcAdminValues')}
          hint={t('settings.oidcAdminValuesHint')}
          env={locked('oidcAdminValues')}
          placeholder="admins"
          value={csvToLines(form.oidcAdminValues)}
          onChange={(v) => set('oidcAdminValues', linesToCsv(v))}
        />
        <ListSetting
          label={t('settings.oidcUserValues')}
          hint={t('settings.oidcUserValuesHint')}
          env={locked('oidcUserValues')}
          placeholder="users"
          value={csvToLines(form.oidcUserValues)}
          onChange={(v) => set('oidcUserValues', linesToCsv(v))}
        />
        <p className="sf-note">{t('settings.oidcAdminHint')}</p>
        <p className="sf-note">{t('settings.oidcMigrationHint')}</p>
        {form.oidcError && (
          <p className="sf-issue mt-2" role="alert">
            {form.oidcError}
          </p>
        )}
      </SettingsPanel>
      <SettingsPanel title={t('settings.instance')}>
        <TextSetting
          label={t('settings.baseUrl')}
          hint={t('settings.baseUrlHint')}
          env={locked('baseUrl')}
          mono
          type="url"
          placeholder="https://weebsync.example.com"
          value={form.baseUrl}
          onChange={(v) => set('baseUrl', v)}
        />
      </SettingsPanel>
      <ApiTokenSection />
      <RateLimitSection />
      {/* the user list has no form of its own and reads the saved settings,
          so it lives on the same screen as the sign-in policy it depends on */}
      <Users />
      <SaveBar form={form} save={save} saved={saved} dirty={dirty} reset={reset} />
    </>
  )
}

// Single machine token for the REST status API (Home Assistant etc.).
// Only the hash is stored server-side, so the raw token shows exactly once.
// Reads ['settings'] directly (not the one-shot form) so the set/not-set
// badge follows the invalidations from generate/revoke.
export function ApiTokenSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const tokenId = useId()
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
    <SettingsPanel
      title={t('settings.apiTokenTitle')}
      badge={
        <Badge tone={isSet ? 'ok' : 'neutral'}>
          {isSet ? t('settings.apiTokenSet') : t('settings.apiTokenNotSet')}
        </Badge>
      }
      desc={t('settings.apiTokenHint')}
    >
      {token && (
        <SettingsField label={t('settings.apiTokenShowOnce')} htmlFor={tokenId}>
          <span className="flex gap-2">
            <Input
              id={tokenId}
              kind="code"
              className="font-mono"
              readOnly
              value={token}
              onFocus={(e) => e.target.select()}
            />
            <Button className="shrink-0" onClick={async () => setCopied(await copyText(token))}>
              {t('settings.apiTokenCopy')}
            </Button>
          </span>
          {copied && (
            <p className="t-sf-h text-ok" role="status">
              {t('settings.apiTokenCopied')}
            </p>
          )}
        </SettingsField>
      )}
      <div className="sf-acts">
        <Button
          size="sm"
          disabled={generate.isPending}
          onClick={async () => {
            // the old token stops working at once and the new one shows only once
            if (isSet && !(await confirm({ message: t('settings.apiTokenConfirmRegenerate'), destructive: true })))
              return
            generate.mutate()
          }}
        >
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
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
  )
}

interface IpStatus {
  ip: string
  kind: 'ip' | 'account'
  blocked: boolean
  tokens: number
}

// Addresses and accounts with failed sign-ins, and the way to free one at once.
export function RateLimitSection() {
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
    <SettingsPanel id="ratelimit" title={t('settings.rateLimit')} desc={t('settings.rateLimitHint')}>
      {list.length === 0 ? (
        <p className="sf-note">{t('settings.rateLimitEmpty')}</p>
      ) : (
        <>
          <Rows dense>
            {list.map((s) => (
              <Row
                key={s.kind + s.ip}
                title={<span className="font-mono">{s.ip}</span>}
                sub={
                  (s.kind === 'account' ? t('settings.rateLimitAccount') + ' · ' : '') +
                  (s.blocked ? t('settings.rateLimitBlocked') : t('settings.rateLimitOk'))
                }
                trailing={
                  <RowAction
                    aria-label={`${t('settings.rateLimitUnblock')}: ${s.ip}`}
                    disabled={reset.isPending}
                    onClick={() => reset.mutate(s.ip)}
                  >
                    {t('settings.rateLimitUnblock')}
                  </RowAction>
                }
              />
            ))}
          </Rows>
          <div className="sf-acts">
            <Button size="sm" disabled={resetAll.isPending} onClick={() => resetAll.mutate()}>
              {t('settings.rateLimitUnblockAll')}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
  )
}

interface SecurityFinding {
  id: string
  level: 'risk' | 'warn' | 'info' | 'ok'
  count?: number
  detail?: string
}

const toneOf = { risk: 'err', warn: 'warn', info: undefined, ok: 'ok' } as const

// What about this instance is not set up as well as it could be, worst first,
// with the checks that passed folded away. The server words nothing: each
// finding is an id the texts below explain, with what to do about it.
function SecurityReview() {
  const { t } = useTranslation()
  const { data } = useQuery<SecurityFinding[]>({
    queryKey: ['security-check'],
    queryFn: () => api.get('/api/admin/security-check'),
  })
  const findings = (data ?? []).filter((f) => f.level !== 'ok')
  const passed = (data ?? []).filter((f) => f.level === 'ok')
  const text = (f: SecurityFinding, part: 'title' | 'fix') =>
    t(`securityCheck.items.${f.id}_${f.level}.${part}`, {
      count: f.count ?? 0,
      detail: f.detail ?? '',
      defaultValue: t(`securityCheck.items.${f.id}.${part}`, {
        count: f.count ?? 0,
        detail: f.detail ?? '',
        defaultValue: '',
      }),
    })
  return (
    <SettingsPanel id="security-check" title={t('securityCheck.title')} desc={t('securityCheck.hint')}>
      {data && findings.length === 0 && <p className="sf-note text-ok">{t('securityCheck.allGood')}</p>}
      {findings.length > 0 && (
        <Rows>
          {findings.map((f) => (
            <Row
              key={f.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={toneOf[f.level]}>{t(`securityCheck.level.${f.level}`)}</Badge>
                  <span>{text(f, 'title')}</span>
                </span>
              }
              sub={text(f, 'fix')}
            />
          ))}
        </Rows>
      )}
      {passed.length > 0 && (
        <details className="mt-3">
          <summary className="sf-note cursor-pointer">{t('securityCheck.passed', { count: passed.length })}</summary>
          <ul className="sf-note mt-2 list-disc ps-5">
            {passed.map((f) => (
              <li key={f.id}>{text(f, 'title')}</li>
            ))}
          </ul>
        </details>
      )}
    </SettingsPanel>
  )
}
