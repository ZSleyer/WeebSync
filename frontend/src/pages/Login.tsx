import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound, LogIn } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, ButtonLink, Checkbox, Input, Segmented, Slot } from 'fluid-lycoris'
import { api, ApiError, type User } from '../api'
import { loginPasskey, assertSecurityKey, supportsPasskeyAutofill, conditionalPasskeyLogin } from '../webauthn'
import Loading from '../components/Loading'
import Setup from './Setup'
import Brand from '../components/Brand'
import { MIN_PASSWORD } from './authLimits'
import './auth.css'

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
const webauthn = typeof window !== 'undefined' && 'PublicKeyCredential' in window

// "stay signed in" is remembered per browser: a convenience, so a failing
// storage just falls back to unticked
const REMEMBER_KEY = 'ws-remember'
function readRemember(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '1'
  } catch {
    return false
  }
}
function writeRemember(v: boolean) {
  try {
    localStorage.setItem(REMEMBER_KEY, v ? '1' : '0')
  } catch {
    // private window or blocked storage: the box still applies to this sign-in
  }
}
const oidcHref = (remember: boolean) => '/api/auth/oidc/login' + (remember ? '?remember=1' : '')

// The 401 of a wrong email or password counts what the rate limit leaves.
interface LoginRefused {
  attemptsLeft?: number
  pauseSeconds?: number
}

/** The refusal in words, with the attempts left before the pause when the server counts them. */
export function refusedText(err: unknown, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (!(err instanceof ApiError) || err.status !== 401) return null
  const d = err.data as LoginRefused | undefined
  if (d?.attemptsLeft == null) return null
  const s = d.pauseSeconds ?? 0
  return `${err.message} ${
    d.attemptsLeft > 0 ? t('login.attemptsLeft', { count: d.attemptsLeft, s }) : t('login.attemptsNone', { s })
  }`
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
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [remember, setRememberState] = useState(readRemember)
  // the passkey autofill is armed on load and reads the box when it fires
  const rememberRef = useRef(remember)
  const setRemember = (v: boolean) => {
    rememberRef.current = v
    setRememberState(v)
    writeRemember(v)
  }
  const [twoFA, setTwoFA] = useState<{ token: string; totp: boolean; webauthn: boolean } | null>(null)
  const [code, setCode] = useState('')
  // the forgotten-password detours: asking for a link, and using one
  const [detour, setDetour] = useState<'forgot' | 'reset' | null>(resetToken ? 'reset' : null)
  // an alternative under way: its button says what it waits for
  const [waiting, setWaiting] = useState<'passkey' | 'sso' | null>(null)
  // counts refusals, so the same message shakes again
  const [errorTick, setErrorTick] = useState(0)
  const fail = (msg: string) => {
    setError(msg)
    setErrorTick((n) => n + 1)
  }

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
      window.location.href = oidcHref(readRemember())
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
      >(`/api/auth/${mode}`, { email, password, locale: i18n.language, remember })
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
      fail(refusedText(err, t) ?? (err instanceof Error ? err.message : t('app.error')))
    } finally {
      setBusy(false)
    }
  }

  // the pending token is gone (expired or too many wrong codes): back to the
  // password step, the second-factor form would only keep failing
  const twoFactorFailed = (msg: string) => {
    if (msg === i18n.t('errors.loginExpired')) {
      setTwoFA(null)
      fail(t('login.twoFactorExpired'))
    } else fail(msg)
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
      if (ok)
        conditionalPasskeyLogin(() => rememberRef.current)
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
    setWaiting('passkey')
    setError('')
    try {
      await loginPasskey(remember)
      await afterAuth()
    } catch (err) {
      fail(err instanceof Error ? err.message : t('login.passkeyFailed'))
    } finally {
      setBusy(false)
      setWaiting(null)
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
        <Loading size="lg" />
      </main>
    )
  }

  if (cfg.setupNeeded) return <Setup />

  const oidcOnly = cfg.oidc && (cfg.authMode === 'oidc-only' || (cfg.authMode === 'oidc-auto' && !noRedirect))
  const oidcLabel = cfg.oidcName ? t('login.oidcNamed', { name: cfg.oidcName }) : t('login.oidc')
  const ssoWaiting = cfg.oidcName ? t('login.ssoWaitingNamed', { name: cfg.oidcName }) : t('login.ssoWaiting')
  // which screen is up: the key restarts the slide-in on every change
  const stage = oidcOnly ? 'sso' : detour ? detour : twoFA ? 'totp' : mode
  const errorLine = error && (
    <p key={errorTick} className="ws-login-err" data-shake={errorTick > 0 || undefined} role="alert">
      {error}
    </p>
  )
  // applies to every way in on this page: password, passkey and the provider
  const rememberBox = (
    <Checkbox
      className="ws-login-remember"
      checked={remember}
      onChange={(e) => setRemember(e.target.checked)}
      label={t('login.remember')}
    />
  )
  const noticeLine = notice && (
    <p className="ws-login-note" role="status">
      {notice}
    </p>
  )
  const passkeys = mode === 'login' && webauthn
  const tooShort = Math.max(0, MIN_PASSWORD - password.length)

  return (
    // a phone stacks the mark over the form; a desktop gives each a half
    <main className="ws-login">
      <div className="ws-login-hero">
        <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
          <Brand variant="hero" slogan={t('login.tagline')} />
        </h1>
      </div>
      <div className="ws-login-side">
        <div key={stage} className="ws-login-form ws-stage">
          {oidcOnly ? (
            <>
              {cfg.authMode === 'oidc-auto' && !holdRedirect ? (
                <p className="ws-quiet" role="status">
                  {t('login.redirecting')}
                </p>
              ) : null}
              {noticeLine}
              {errorLine}
              {rememberBox}
              <ButtonLink
                variant="primary"
                className="ws-login-go"
                href={oidcHref(remember)}
                onClick={() => setWaiting('sso')}
              >
                <LogIn aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                <Slot step={waiting === 'sso' ? 1 : 0}>{waiting === 'sso' ? ssoWaiting : oidcLabel}</Slot>
              </ButtonLink>
            </>
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
            <form className="grid" onSubmit={submitTotp}>
              <h2 className="ws-login-h">{t('login.totpTitle')}</h2>
              {/* with only a security key there is no code field to point at */}
              <p className="ws-quiet">{twoFA.totp ? t('login.totpHint') : t('login.securityKeyHint')}</p>
              {twoFA.totp && (
                <>
                  <label htmlFor="totp-code" className="sr-only">
                    {t('login.totpCode')}
                  </label>
                  <Input
                    id="totp-code"
                    name="code"
                    className="ws-login-code"
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
              {errorLine}
              {twoFA.totp && (
                <Button type="submit" variant="primary" className="ws-login-go" disabled={busy}>
                  {t('login.confirm')}
                </Button>
              )}
              {twoFA.webauthn && (
                <Button
                  className={twoFA.totp ? 'ws-login-alt' : 'ws-login-go'}
                  variant={twoFA.totp ? 'default' : 'primary'}
                  disabled={busy}
                  onClick={securityKey2FA}
                >
                  <KeyRound aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                  {t('login.useSecurityKey')}
                </Button>
              )}
              <button
                type="button"
                className="ws-login-back"
                onClick={() => {
                  setTwoFA(null)
                  setCode('')
                  setError('')
                }}
              >
                {t('login.back')}
              </button>
            </form>
          ) : (
            <form className="grid" onSubmit={submit}>
              {/* a choice only when registration is open */}
              {cfg.registrationOpen && (
                <Segmented
                  aria-label={t('login.tabs')}
                  size="md"
                  className="mb-1 w-full"
                  value={mode}
                  onChange={(m) => {
                    setMode(m)
                    setError('')
                  }}
                  options={[
                    { value: 'login', label: t('login.modeLogin') },
                    { value: 'register', label: t('login.register') },
                  ]}
                />
              )}
              <label htmlFor="email" className="ws-lbl">
                {t('login.email')}
              </label>
              <Input
                id="email"
                type="email"
                // "webauthn" arms passkey autofill on this field (conditional UI)
                autoComplete="username webauthn"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="ws-lbl-row">
                <label htmlFor="password" className="ws-lbl">
                  {t('login.password')}
                </label>
                {mode === 'login' && cfg.passwordReset && (
                  <button
                    type="button"
                    className="ws-login-link"
                    onClick={() => {
                      setNotice('')
                      setError('')
                      setDetour('forgot')
                    }}
                  >
                    {t('login.forgotShort')}
                  </button>
                )}
              </div>
              <div className="ws-login-pw">
                <Input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'register' ? MIN_PASSWORD : undefined}
                  aria-describedby={mode === 'register' ? 'password-hint' : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="ws-login-link ws-login-eye"
                  aria-pressed={showPw}
                  aria-controls="password"
                  onClick={() => setShowPw((v) => !v)}
                >
                  {t(showPw ? 'login.hidePassword' : 'login.showPassword')}
                </button>
              </div>
              {mode === 'register' && (
                <p id="password-hint" className="ws-login-hint" data-ok={tooShort === 0 || undefined}>
                  {tooShort > 0 ? t('login.lengthLeft', { min: MIN_PASSWORD, n: tooShort }) : t('login.lengthOk')}
                </p>
              )}
              {noticeLine}
              {errorLine}
              {mode === 'login' && rememberBox}
              <Button type="submit" variant="primary" className="ws-login-go" disabled={busy}>
                {busy && !waiting
                  ? t('login.checking')
                  : mode === 'login'
                    ? t('login.submitLogin')
                    : t('login.submitRegister')}
              </Button>
              {(passkeys || cfg.oidc) && (
                <>
                  <p className="ws-login-or">{t('login.or')}</p>
                  {passkeys && (
                    <Button className="ws-login-alt" disabled={busy} onClick={passkeyLogin}>
                      <Fingerprint aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      <Slot step={waiting === 'passkey' ? 1 : 0}>
                        {waiting === 'passkey' ? t('login.passkeyWaiting') : t('login.passkey')}
                      </Slot>
                    </Button>
                  )}
                  {cfg.oidc && (
                    <ButtonLink className="ws-login-alt" href={oidcHref(remember)} onClick={() => setWaiting('sso')}>
                      <LogIn aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      <Slot step={waiting === 'sso' ? 1 : 0}>{waiting === 'sso' ? ssoWaiting : oidcLabel}</Slot>
                    </ButtonLink>
                  )}
                </>
              )}
            </form>
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
  // the link is asked for: the screen says where to look next
  const [sent, setSent] = useState(false)

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
        setSent(true)
        setBusy(false)
      } else {
        await api.post('/api/auth/reset', { token: resetToken, password })
        leave(t('login.resetDone'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
    }
  }

  if (sent)
    return (
      <div key="sent" className="grid ws-stage">
        <h2 className="ws-login-h">{t('login.sentTitle')}</h2>
        <p className="ws-quiet" role="status">
          {t('login.forgotSent')}
        </p>
        <Button variant="primary" className="ws-login-go" onClick={() => leave('')}>
          {t('login.toLogin')}
        </Button>
      </div>
    )

  return (
    <form className="grid" onSubmit={submit}>
      <h2 className="ws-login-h">{kind === 'forgot' ? t('login.forgotTitle') : t('login.resetTitle')}</h2>
      <p className="ws-quiet">{kind === 'forgot' ? t('login.forgotHint') : t('login.resetHint')}</p>
      {kind === 'forgot' ? (
        <>
          <label htmlFor="forgot-email" className="ws-lbl">
            {t('login.email')}
          </label>
          <Input
            id="forgot-email"
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
          <label htmlFor="reset-password" className="ws-lbl">
            {t('account.passwordNew')}
          </label>
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label htmlFor="reset-again" className="ws-lbl">
            {t('account.passwordAgain')}
          </label>
          <Input
            id="reset-again"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </>
      )}
      {error && (
        <p className="ws-login-err" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="ws-login-go" disabled={busy}>
        {kind === 'forgot' ? t('login.forgotSubmit') : t('login.resetSubmit')}
      </Button>
      <button type="button" className="ws-login-back" onClick={() => leave('')}>
        {t('login.toLogin')}
      </button>
    </form>
  )
}
