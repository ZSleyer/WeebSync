import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Input } from 'fluid-lycoris'
import { api } from '../api'
import { logout } from '../hooks'
import { registerCredential } from '../webauthn'
import Brand from '../components/Brand'
import { MIN_PASSWORD } from './authLimits'
import './auth.css'

// A sign-in that worked but no longer meets the rules lands here instead of the
// app: the server answers 403 on every other route until the replacement is
// done (auth.Middleware, users.auth_upgrade).
export default function AccountUpgrade({ kind }: { kind: 'password' | 'passkey' }) {
  const { t } = useTranslation()
  useEffect(() => {
    document.title = `${t('upgrade.title')} - WeebSync`
  }, [t])
  return (
    <main className="ws-login">
      <div className="ws-login-hero">
        <Brand variant="hero" slogan={t('login.tagline')} />
      </div>
      <div className="ws-login-side">
        <div className="ws-login-form ws-stage">{kind === 'password' ? <PasswordUpgrade /> : <PasskeyUpgrade />}</div>
      </div>
    </main>
  )
}

function PasswordUpgrade() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== again) return setError(t('account.passwordMismatch'))
    setBusy(true)
    setError('')
    try {
      await api.put('/api/auth/password', { current, new: next })
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
    }
  }

  return (
    <form className="grid" onSubmit={submit}>
      <h2 className="ws-login-h">{t('upgrade.passwordTitle')}</h2>
      <p className="ws-quiet">{t('upgrade.passwordHint')}</p>
      <label htmlFor="upgrade-current" className="ws-lbl">
        {t('account.passwordCurrent')}
      </label>
      <Input
        id="upgrade-current"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <label htmlFor="upgrade-new" className="ws-lbl">
        {t('account.passwordNew')}
      </label>
      <Input
        id="upgrade-new"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <label htmlFor="upgrade-again" className="ws-lbl">
        {t('account.passwordAgain')}
      </label>
      <Input
        id="upgrade-again"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD}
        value={again}
        onChange={(e) => setAgain(e.target.value)}
      />
      {error && (
        <p className="ws-login-err" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="ws-login-go" disabled={busy}>
        {t('account.passwordChange')}
      </Button>
      <button type="button" className="ws-login-back" onClick={() => void logout()}>
        {t('upgrade.logout')}
      </button>
    </form>
  )
}

interface Credential {
  id: number
  name: string
  replaceDue: boolean
}

// A passkey that signed in without asking for a PIN or biometrics: a new one
// that does replaces it (the server drops the old one), or the old one goes
// and the account carries on with its password - the way out for a device
// that cannot verify its user at all.
function PasskeyUpgrade() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: creds } = useQuery<Credential[]>({
    queryKey: ['webauthn'],
    queryFn: () => api.get('/api/auth/webauthn/credentials'),
  })
  const old = (creds ?? []).filter((c) => c.replaceDue)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
    }
  }
  const replace = (e: FormEvent) => {
    e.preventDefault()
    void run(() => registerCredential('passkey', old[0]?.name || 'Passkey', password))
  }
  const remove = () =>
    run(async () => {
      for (const c of old) await api.del(`/api/auth/webauthn/credentials/${c.id}`, { password })
    })

  return (
    <form className="grid" onSubmit={replace}>
      <h2 className="ws-login-h">{t('upgrade.passkeyTitle')}</h2>
      <p className="ws-quiet">{t('upgrade.passkeyHint', { name: old.map((c) => c.name).join(', ') || 'Passkey' })}</p>
      <label htmlFor="upgrade-password" className="ws-lbl">
        {t('login.password')}
      </label>
      <Input
        id="upgrade-password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <p className="ws-login-err" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="ws-login-go" disabled={busy || !password}>
        {t('upgrade.passkeyReplace')}
      </Button>
      <Button
        type="button"
        className="ws-login-alt"
        disabled={busy || old.length === 0 || !password}
        onClick={() => void remove()}
      >
        {t('upgrade.passkeyRemove')}
      </Button>
      <button type="button" className="ws-login-back" onClick={() => void logout()}>
        {t('upgrade.logout')}
      </button>
    </form>
  )
}
