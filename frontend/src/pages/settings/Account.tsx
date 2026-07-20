import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'
import { usePrompt } from '../../components/prompt'
import { registerCredential } from '../../webauthn'

interface AuthConfig {
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
}

export default function Account() {
  const { t } = useTranslation()
  const { data: cfg } = useQuery<AuthConfig>({ queryKey: ['authConfig'], queryFn: () => api.get('/api/auth/config') })
  return (
    <section className="max-w-xl" aria-label={t('settings.nav.account')}>
      {cfg && cfg.authMode !== 'password' ? (
        <div className="t-panel p-5 text-sm text-t-muted">{t('account.oidcOnly')}</div>
      ) : (
        <div className="space-y-4">
          <PasskeySection />
          <TotpSection />
        </div>
      )}
    </section>
  )
}

interface Passkey {
  id: number
  name: string
  passwordless: boolean
  createdAt: string
  lastUsed: string
}

function PasskeySection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const prompt = usePrompt()
  const { data: creds } = useQuery<Passkey[]>({
    queryKey: ['webauthn'],
    queryFn: () => api.get('/api/auth/webauthn/credentials'),
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const add = (kind: 'passkey' | 'key') => async () => {
    const fallback = kind === 'passkey' ? 'Passkey' : 'Security Key'
    const name = await prompt({ title: t('account.passkeyName'), defaultValue: fallback })
    if (name === null) return
    setBusy(true)
    setError('')
    try {
      await registerCredential(kind, name || fallback)
      qc.invalidateQueries({ queryKey: ['webauthn'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }
  const remove = (id: number) => async () => {
    setBusy(true)
    try {
      await api.del(`/api/auth/webauthn/credentials/${id}`)
      qc.invalidateQueries({ queryKey: ['webauthn'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="t-panel p-5" aria-label={t('account.passkeyTitle')}>
      <span className="t-label t-label--accent">{t('account.passkeyTitle')}</span>
      <p className="mt-2 text-xs text-t-muted">{t('account.passkeyHint')}</p>
      {creds && creds.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle/50">
          {creds.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-t-secondary">{c.name}</span>
              <span className="t-label">{c.passwordless ? t('account.passkeyKindPasskey') : t('account.passkeyKindKey')}</span>
              <button className="t-btn t-btn--sm t-btn--danger" disabled={busy} onClick={remove(c.id)}>
                {t('servers.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="t-btn t-btn--sm t-btn--primary t-cut" disabled={busy} onClick={add('passkey')}>
          {t('account.passkeyAdd')}
        </button>
        <button className="t-btn t-btn--sm" disabled={busy} onClick={add('key')}>
          {t('account.keyAdd')}
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

type SetupData = { secret: string; otpauthUrl: string; qr?: string }

function TotpSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<{ enabled: boolean }>({ queryKey: ['totp'], queryFn: () => api.get('/api/auth/totp') })
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const start = () => run(async () => setSetup(await api.post<SetupData>('/api/auth/totp/setup')))
  const confirm = () =>
    run(async () => {
      const out = await api.post<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { code: code.trim() })
      setRecovery(out.recoveryCodes)
      setSetup(null)
      setCode('')
      qc.invalidateQueries({ queryKey: ['totp'] })
    })
  const disable = () =>
    run(async () => {
      await api.del('/api/auth/totp', { password })
      setPassword('')
      qc.invalidateQueries({ queryKey: ['totp'] })
    })

  return (
    <div className="t-panel p-5" aria-label={t('account.totpTitle')}>
      <span className="t-label t-label--accent">{t('account.totpTitle')}</span>
      <p className="mt-2 text-xs text-t-muted">{t('account.totpHint')}</p>

      {recovery && (
        <div className="mt-4 border border-warn/40 bg-warn/5 p-4">
          <p className="mb-2 text-sm text-warn">{t('account.recoveryTitle')}</p>
          <p className="mb-3 text-xs text-t-muted">{t('account.recoveryHint')}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button className="t-btn t-btn--sm mt-3" onClick={() => navigator.clipboard?.writeText(recovery.join('\n'))}>
            {t('account.copy')}
          </button>
          <button className="t-btn t-btn--sm mt-3 ml-2" onClick={() => setRecovery(null)}>
            {t('remote.close')}
          </button>
        </div>
      )}

      {!recovery && data?.enabled && (
        <div className="mt-4">
          <span className="t-label t-label--ok">{t('account.totpOn')}</span>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-t-muted">
              {t('login.password')}
              <input
                className="t-input mt-1"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="t-btn t-btn--sm t-btn--danger" disabled={busy || !password} onClick={disable}>
              {t('account.totpDisable')}
            </button>
          </div>
        </div>
      )}

      {!recovery && !data?.enabled && !setup && (
        <button className="t-btn t-btn--sm t-btn--primary t-cut mt-4" disabled={busy} onClick={start}>
          {t('account.totpEnable')}
        </button>
      )}

      {!recovery && setup && (
        <div className="mt-4 space-y-3">
          {setup.qr && <img src={setup.qr} alt="" className="border border-border-subtle" width={180} height={180} />}
          <p className="text-xs text-t-muted">
            {t('account.totpManual')} <span className="font-mono text-t-secondary">{setup.secret}</span>
          </p>
          <label className="block text-xs text-t-muted">
            {t('account.totpEnterCode')}
            <input
              className="t-input mt-1 font-mono tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className="t-btn t-btn--sm t-btn--primary t-cut" disabled={busy || !code} onClick={confirm}>
            {t('account.totpConfirm')}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
