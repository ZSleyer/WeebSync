import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Input } from 'fluid-lycoris'
import { api } from '../api'
import { logout } from '../hooks'
import Brand from '../components/Brand'
import { MIN_PASSWORD } from './authLimits'
import './auth.css'

// A sign-in that worked but no longer meets the rules lands here instead of the
// app: the server answers 403 on every other route until the replacement is
// done (auth.Middleware, users.auth_upgrade).
export default function AccountUpgrade({ kind }: { kind: 'password' }) {
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
        <div className="ws-login-form ws-stage">{kind === 'password' && <PasswordUpgrade />}</div>
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
