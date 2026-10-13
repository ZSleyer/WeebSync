import { useEffect, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound, LogIn } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ButtonLink, Input, Panel } from '@weebsync/design-system'
import { api, type User } from '../api'
import { loginPasskey, assertSecurityKey, supportsPasskeyAutofill, conditionalPasskeyLogin } from '../webauthn'
import Loading from '../components/Loading'
import Setup from './Setup'
import Brand from '../components/Brand'

interface AuthConfig {
  oidc: boolean
  oidcName: string
  registrationOpen: boolean
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  setupNeeded: boolean
  passwordReset: boolean
}

// what the address brings, read once: the token of a password reset link, a
// sign-in the provider refused, and a fresh logout
const landing = new URLSearchParams(window.location.search)
const resetToken = landing.get('reset') ?? ''
const oidcError = landing.get('oidc_error') ?? ''
const loggedOut = landing.has('loggedout')
// a refused sign-in or a logout must not bounce back to the provider
const holdRedirect = landing.has('noredirect') || !!oidcError || loggedOut

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
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [twoFA, setTwoFA] = useState<{ token: string; totp: boolean; webauthn: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [autofill, setAutofill] = useState(false) // browser supports passkey autofill
  // the forgotten-password detours: asking for a link, and using one
  const [detour, setDetour] = useState<'forgot' | 'reset' | null>(resetToken ? 'reset' : null)

  // email verification redirect lands here with ?verify=ok|invalid, a refused
  // OIDC sign-in with ?oidc_error=<code>, a logout with ?loggedout
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('verify')
    if (v === 'ok') setNotice(t('login.verifyOk'))
    else if (v === 'invalid') setError(t('login.verifyInvalid'))
    if (oidcError) setError(t(`login.oidcError.${oidcError}`, { defaultValue: t('login.oidcError.generic') }))
    if (loggedOut) setNotice(t('login.loggedOut'))
  }, [t])

  // oidc-auto: straight to the provider; ?noredirect=1 is the escape hatch
  // (e.g. admin needs the password form while the provider is down)
  const noRedirect = landing.has('noredirect')
  useEffect(() => {
    if (cfg?.authMode === 'oidc-auto' && cfg.oidc && !holdRedirect) {
      window.location.href = '/api/auth/oidc/login'
    }
  }, [cfg])

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
        User & {
          needsVerification?: boolean
          twoFactorRequired?: boolean
          token?: string
          totp?: boolean
          webauthn?: boolean
        }
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
      await afterAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  // the pending token is gone (expired or too many wrong codes): back to the
  // password step, the second-factor form would only keep failing
  const twoFactorFailed = (msg: string) => {
    if (msg === i18n.t('errors.loginExpired')) {
      setTwoFA(null)
      setError(t('login.twoFactorExpired'))
    } else setError(msg)
  }

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault()
    // from the form, not the state: the sixth digit submits in the same
    // change event that sets it, before the state has caught up
    const typed = new FormData(e.currentTarget as HTMLFormElement).get('code')
    setBusy(true)
    setError('')
    try {
      await api.post('/api/auth/login/totp', { token: twoFA?.token, code: String(typed ?? code).trim() })
      await afterAuth()
    } catch (err) {
      twoFactorFailed(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  // wipe leftovers from a previous session (e.g. expired session of another
  // user) and refetch the identity. Not qc.clear(): that drops the 'me' query
  // out from under App's observer, the invalidate then finds nothing and the
  // login screen stays until a reload.
  const afterAuth = () => qc.resetQueries()
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
      twoFactorFailed(err instanceof Error ? err.message : t('login.passkeyFailed'))
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
    // a desktop splits the screen: the mark on its own half, the form on the
    // other; a phone stacks them as before
    <main className="grid min-h-dvh lg:grid-cols-2">
      <div className="hidden place-items-center border-r border-border-subtle bg-bg-secondary p-10 lg:grid">
        <div className="text-center">
          <p className="font-display text-3xl font-bold tracking-[0.25em]" aria-hidden>
            <Brand variant="hero" slogan={t('login.tagline')} className="mb-2" />
          </p>
        </div>
      </div>
      <div className="grid content-start justify-items-center p-4 pt-[max(2rem,var(--safe-t))] pb-[calc(1rem+var(--safe-b))] sm:content-center sm:pt-4 sm:pb-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
              <span className="lg:hidden">
                <Brand variant="hero" slogan={t('login.tagline')} className="mb-2" />
              </span>
              <span className="hidden text-2xl tracking-wider lg:inline">{t('login.login')}</span>
            </h1>
          </div>

          {oidcOnly ? (
            <Panel className="animate-fadeIn p-6 text-center">
              {cfg.authMode === 'oidc-auto' && !holdRedirect ? (
                <p className="mb-4 text-sm text-t-secondary" role="status">
                  {t('login.redirecting')}
                </p>
              ) : null}
              {notice && (
                <p className="mb-4 text-sm text-ok" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="mb-4 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
                  {error}
                </p>
              )}
              <ButtonLink variant="primary" className="block w-full" href="/api/auth/oidc/login">
                <LogIn aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {oidcLabel}
              </ButtonLink>
            </Panel>
          ) : detour ? (
            <PasswordDetour
              kind={detour}
              email={email}
              onDone={(msg) => {
                setDetour(null)
                setError('')
                setNotice(msg)
              }}
            />
          ) : twoFA ? (
            <Panel as="form" className="animate-fadeIn p-6" onSubmit={submitTotp}>
              <h2 className="mb-1 font-display font-semibold tracking-wider">{t('login.totpTitle')}</h2>
              {/* with only a security key there is no code field to point at */}
              <p className="mb-4 text-xs text-t-muted">
                {twoFA.totp ? t('login.totpHint') : t('login.securityKeyHint')}
              </p>
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
                    name="code"
                    className="mb-4 text-center font-mono text-lg tracking-[0.5em]"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                      setCode(v)
                      // the sixth digit is the submit: nothing else to decide
                      if (v.length === 6 && !busy) e.target.form?.requestSubmit()
                    }}
                  />
                </>
              )}
              {error && (
                <p className="mb-3 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
                  {error}
                </p>
              )}
              {twoFA.totp && (
                <Button type="submit" variant="primary" className="w-full" disabled={busy}>
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
                    className="flex-1"
                    onClick={() => setMode('login')}
                  >
                    {t('login.login')}
                  </Button>
                  <Button
                    aria-pressed={mode === 'register'}
                    size="sm"
                    variant={mode === 'register' ? 'primary' : 'default'}
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
              <div className="relative mb-4">
                <Input
                  id="password"
                  className="pr-20"
                  type={showPw ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'register' ? 10 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 min-w-16 px-3 text-ctl-sm text-accent hover:underline"
                  aria-pressed={showPw}
                  aria-controls="password"
                  onClick={() => setShowPw((v) => !v)}
                >
                  {t(showPw ? 'login.hidePassword' : 'login.showPassword')}
                </button>
              </div>
              {notice && (
                <p className="mb-3 rounded-md border border-ok/40 px-3 py-2 text-sm text-ok" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="mb-3 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {mode === 'login' ? t('login.submitLogin') : t('login.submitRegister')}
              </Button>
              {mode === 'login' && cfg.passwordReset && (
                <Button
                  className="mt-3 block w-full text-center"
                  onClick={() => {
                    setNotice('')
                    setDetour('forgot')
                  }}
                >
                  {t('login.forgot')}
                </Button>
              )}
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
      </div>
    </main>
  )
}

// The two steps of a forgotten password. "forgot" asks for a link by mail; the
// answer is the same whether or not the address has an account. "reset" is
// where the link lands: a new password, twice, and back to the login.
function PasswordDetour({
  kind,
  email: initialEmail,
  onDone,
}: {
  kind: 'forgot' | 'reset'
  email: string
  onDone: (notice: string) => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const leave = (notice: string) => {
    // the token is spent (or abandoned): a reload must not show the form again
    if (resetToken) history.replaceState(null, '', window.location.pathname)
    onDone(notice)
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (kind === 'reset' && password !== again) return setError(t('account.passwordMismatch'))
    setBusy(true)
    setError('')
    try {
      if (kind === 'forgot') {
        await api.post('/api/auth/forgot', { email })
        leave(t('login.forgotSent'))
      } else {
        await api.post('/api/auth/reset', { token: resetToken, password })
        leave(t('login.resetDone'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
    }
  }

  return (
    <Panel as="form" className="animate-fadeIn p-6" onSubmit={submit}>
      <h2 className="mb-1 font-display font-semibold tracking-wider">
        {kind === 'forgot' ? t('login.forgotTitle') : t('login.resetTitle')}
      </h2>
      <p className="mb-4 text-xs text-t-muted">{kind === 'forgot' ? t('login.forgotHint') : t('login.resetHint')}</p>
      {kind === 'forgot' ? (
        <>
          <Badge as="label" htmlFor="forgot-email" className="mb-1 block w-fit">
            {t('login.email')}
          </Badge>
          <Input
            id="forgot-email"
            className="mb-4"
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </>
      ) : (
        <>
          <Badge as="label" htmlFor="reset-password" className="mb-1 block w-fit">
            {t('account.passwordNew')}
          </Badge>
          <Input
            id="reset-password"
            className="mb-4"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Badge as="label" htmlFor="reset-again" className="mb-1 block w-fit">
            {t('account.passwordAgain')}
          </Badge>
          <Input
            id="reset-again"
            className="mb-4"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </>
      )}
      {error && (
        <p className="mb-3 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {kind === 'forgot' ? t('login.forgotSubmit') : t('login.resetSubmit')}
      </Button>
      <Button className="mt-3 block w-full text-center" onClick={() => leave('')}>
        {t('servers.cancel')}
      </Button>
    </Panel>
  )
}
