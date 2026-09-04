import { useEffect, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound, LogIn } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ButtonLink, Input, Panel } from '@weebsync/design-system'
import { api, type User } from '../api'
import { loginPasskey, assertSecurityKey, supportsPasskeyAutofill, conditionalPasskeyLogin } from '../webauthn'
import Loading from '../components/Loading'
import Setup from './Setup'

interface AuthConfig {
  oidc: boolean
  oidcName: string
  registrationOpen: boolean
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  setupNeeded: boolean
}

export default function Login() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: cfg } = useQuery<AuthConfig>({
    queryKey: ['authConfig'],
    queryFn: () => api.get('/api/auth/config'),
  })
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [twoFA, setTwoFA] = useState<{ token: string; totp: boolean; webauthn: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [autofill, setAutofill] = useState(false) // browser supports passkey autofill

  // email verification redirect lands here with ?verify=ok|invalid
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('verify')
    if (v === 'ok') setNotice(t('login.verifyOk'))
    else if (v === 'invalid') setError(t('login.verifyInvalid'))
  }, [t])

  // oidc-auto: straight to the provider; ?noredirect=1 is the escape hatch
  // (e.g. admin needs the password form while the provider is down)
  const noRedirect = new URLSearchParams(window.location.search).has('noredirect')
  useEffect(() => {
    if (cfg?.authMode === 'oidc-auto' && cfg.oidc && !noRedirect) {
      window.location.href = '/api/auth/oidc/login'
    }
  }, [cfg, noRedirect])

  useEffect(() => {
    document.title = `${t('login.login')} - WeebSync`
  }, [t])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // locale rides along on register so the verify email is localized
      const res = await api.post<
        User & { needsVerification?: boolean; twoFactorRequired?: boolean; token?: string; totp?: boolean; webauthn?: boolean }
      >(`/api/auth/${mode}`, { email, password, locale: i18n.language })
      if (res.needsVerification) {
        // account created but must confirm email before logging in
        setNotice(t('login.verifySent'))
        setMode('login')
        setPassword('')
        return
      }
      if (res.twoFactorRequired && res.token) {
        // password ok - ask for the second factor, don't create a session yet
        setTwoFA({ token: res.token, totp: !!res.totp, webauthn: !!res.webauthn })
        setPassword('')
        return
      }
      // clear leftovers from a previous session (e.g. expired session of
      // another user) before the new identity loads
      qc.clear()
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/api/auth/login/totp', { token: twoFA?.token, code: code.trim() })
      qc.clear()
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('app.error')
      // the pending token is gone (expired or too many wrong codes): back to
      // the password step, the code field would only keep failing
      if (msg.includes('expired login')) {
        setTwoFA(null)
        setError(t('login.twoFactorExpired'))
      } else setError(msg)
    } finally {
      setBusy(false)
    }
  }

  const afterAuth = async () => {
    qc.clear()
    await qc.invalidateQueries({ queryKey: ['me'] })
  }
  // arm passkey autofill (conditional UI) once, when password login is available:
  // the browser surfaces passkeys in the email field, no explicit button needed
  useEffect(() => {
    if (cfg?.authMode !== 'password') return
    let active = true
    supportsPasskeyAutofill().then((ok) => {
      if (!active) return
      setAutofill(ok)
      if (ok)
        conditionalPasskeyLogin()
          .then(() => {
            if (active) afterAuth()
          })
          .catch(() => {})
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.authMode])
  const passkeyLogin = async () => {
    setBusy(true)
    setError('')
    try {
      await loginPasskey()
      await afterAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.passkeyFailed'))
    } finally {
      setBusy(false)
    }
  }
  const securityKey2FA = async () => {
    if (!twoFA) return
    setBusy(true)
    setError('')
    try {
      await assertSecurityKey(twoFA.token)
      await afterAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.passkeyFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!cfg) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Loading />
      </main>
    )
  }

  if (cfg.setupNeeded) return <Setup />

  const oidcOnly = cfg.oidc && (cfg.authMode === 'oidc-only' || (cfg.authMode === 'oidc-auto' && !noRedirect))
  const oidcLabel = cfg.oidcName ? t('login.oidcNamed', { name: cfg.oidcName }) : t('login.oidc')

  return (
    <main className="t-hatch grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <Badge className="mt-3">{t('login.tagline')}</Badge>
        </div>

        {oidcOnly ? (
          <Panel className="animate-fadeIn p-6 text-center">
            {cfg.authMode === 'oidc-auto' ? (
              <p className="mb-4 text-sm text-t-secondary" role="status">
                {t('login.redirecting')}
              </p>
            ) : null}
            <ButtonLink variant="primary" cut className="block w-full" href="/api/auth/oidc/login">
              <LogIn aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {oidcLabel}
            </ButtonLink>
          </Panel>
        ) : twoFA ? (
          <Panel as="form" className="animate-fadeIn p-6" onSubmit={submitTotp}>
            <h2 className="mb-1 font-display font-semibold tracking-wider">{t('login.totpTitle')}</h2>
            <p className="mb-4 text-xs text-t-muted">{t('login.totpHint')}</p>
            {twoFA.webauthn && (
              <Button className="mb-4 block w-full" disabled={busy} onClick={securityKey2FA}>
                <KeyRound aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('login.useSecurityKey')}
              </Button>
            )}
            {twoFA.totp && (
              <>
                <Badge as="label" htmlFor="totp-code" className="mb-1 block w-fit">
                  {t('login.totpCode')}
                </Badge>
                <Input
                  id="totp-code"
                  className="mb-4 font-mono tracking-[0.3em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </>
            )}
            {error && (
              <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
                {error}
              </p>
            )}
            {twoFA.totp && (
              <Button type="submit" variant="primary" cut className="w-full" disabled={busy}>
                {t('login.submitLogin')}
              </Button>
            )}
            <Button
              className="mt-3 block w-full text-center"
              onClick={() => {
                setTwoFA(null)
                setCode('')
                setError('')
              }}
            >
              {t('servers.cancel')}
            </Button>
          </Panel>
        ) : (
          <Panel as="form" className="animate-fadeIn p-6" onSubmit={submit}>
            {/* tab bar only when there's a real choice (registration open) */}
            {cfg.registrationOpen && (
              <div className="mb-4 flex gap-1" role="group" aria-label={t('login.tabs')}>
                <Button
                  aria-pressed={mode === 'login'}
                  size="sm"
                  variant={mode === 'login' ? 'primary' : 'default'}
                  cut={mode === 'login'}
                  className="flex-1"
                  onClick={() => setMode('login')}
                >
                  {t('login.login')}
                </Button>
                <Button
                  aria-pressed={mode === 'register'}
                  size="sm"
                  variant={mode === 'register' ? 'primary' : 'default'}
                  cut={mode === 'register'}
                  className="flex-1"
                  onClick={() => setMode('register')}
                >
                  {t('login.register')}
                </Button>
              </div>
            )}
            <Badge as="label" htmlFor="email" className="mb-1 block w-fit">
              {t('login.email')}
            </Badge>
            <Input
              id="email"
              className="mb-4"
              type="email"
              // "webauthn" arms passkey autofill on this field (conditional UI)
              autoComplete="username webauthn"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Badge as="label" htmlFor="password" className="mb-1 block w-fit">
              {t('login.password')}
            </Badge>
            <Input
              id="password"
              className="mb-4"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {notice && (
              <p className="mb-3 border border-ok/40 px-3 py-2 text-sm text-ok" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" cut className="w-full" disabled={busy}>
              {mode === 'login' ? t('login.submitLogin') : t('login.submitRegister')}
            </Button>
            {mode === 'login' && !autofill && (
              <Button className="mt-3 block w-full text-center" disabled={busy} onClick={passkeyLogin}>
                <Fingerprint aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('login.passkey')}
              </Button>
            )}
            {cfg.oidc && (
              <ButtonLink className="mt-3 block w-full text-center" href="/api/auth/oidc/login">
                <LogIn aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {oidcLabel}
              </ButtonLink>
            )}
          </Panel>
        )}
      </div>
    </main>
  )
}
