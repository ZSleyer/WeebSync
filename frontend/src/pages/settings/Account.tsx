import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'

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
        <TotpSection />
      )}
    </section>
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
            {t('browser.close')}
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
