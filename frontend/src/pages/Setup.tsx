import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import SetupSteps from '../components/SetupSteps'
import { EnvBadge } from './settings/useSettingsForm'

// First-run wizard, shown while the instance has no users yet
// (authConfig.setupNeeded). One list of steps, one indicator - the only fork is
// INSIDE step 01: either a local admin account, or no local account at all, in
// which case step 02 stores the OIDC config through the unauthenticated setup
// endpoint and the first OIDC login becomes admin. That login navigates away,
// so the wizard resumes at step 03 on the way back (RootLayout renders it with
// initialStep while settings.onboardingDone is false). Nothing may invalidate
// ['me'] before the last step, that would swap in the app shell mid-wizard.
export type Step = 'account' | 'oidc' | 'import' | 'server' | 'storage' | 'meta' | 'done'
const STEPS: Step[] = ['account', 'oidc', 'import', 'server', 'storage', 'meta']

export default function Setup({
  initialStep = 'account',
  onDone,
}: {
  initialStep?: Step
  // resumed run: the session already exists, so swapping in the app shell is a
  // settings refetch, not a ['me'] invalidation
  onDone?: () => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>(initialStep)
  // no local account: step 02 becomes mandatory and the first OIDC login is admin
  const [oidcOnly, setOidcOnly] = useState(false)
  // set once the OIDC config is stored and the provider is reachable
  const [oidcReady, setOidcReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [oidc, setOidc] = useState({
    oidcProviderName: '',
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcRedirectUrl: `${window.location.origin}/api/auth/oidc/callback`,
    oidcClaim: 'groups',
    oidcAdminValues: '',
    oidcUserValues: '',
  })
  // recommended default for public instances: close open registration
  const [registrationDisabled, setRegistrationDisabled] = useState(true)
  const [discovered, setDiscovered] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // OIDC fields forced by env vars (names only - values stay server-side,
  // this endpoint is unauthenticated); same cache key as the login page
  const { data: authCfg } = useQuery<{ oidcEnvLocked?: string[] }>({
    queryKey: ['authConfig'],
    queryFn: () => api.get('/api/auth/config'),
  })
  const envLocked = (k: string) => authCfg?.oidcEnvLocked?.includes(k) ?? false

  useEffect(() => {
    document.title = `${t('setup.title')} - WeebSync`
  }, [t])
  // move focus to the step heading on step CHANGES only - focusing on the
  // initial render would greet the user with a bare focus ring
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    headingRef.current?.focus()
    setError('')
  }, [step])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const createAccount = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      // locale rides along so server-delivered texts match the ui language
      await api.post('/api/auth/register', { email, password, locale: i18n.language })
      setStep('oidc')
    })
  }

  // the session from step 1 is admin, so this is the normal settings API.
  // Always persists the registration choice, even when OIDC is skipped, so the
  // recommended "close registration" default actually takes effect.
  const saveAuth = (withOidc: boolean) =>
    run(async () => {
      const cur = await api.get<Record<string, unknown>>('/api/settings')
      const out = await api.put<{ oidcError?: string }>('/api/settings', {
        ...cur,
        ...(withOidc && oidc.oidcIssuer ? oidc : {}),
        // instance URL for email links: keep what's set, else the setup origin
        baseUrl: (cur.baseUrl as string) || window.location.origin,
        registrationDisabled,
      })
      if (out.oidcError) {
        setError(out.oidcError)
        return
      }
      setStep('import')
    })

  // no account yet, so this goes through the unauthenticated setup endpoint.
  // It only stores the config; the wizard then waits for the first OIDC login.
  const saveOidcOnly = () =>
    run(async () => {
      const out = await api.post<{ oidcEnabled: boolean; oidcError?: string }>('/api/auth/setup/oidc', {
        ...oidc,
        baseUrl: window.location.origin,
      })
      if (out.oidcError || !out.oidcEnabled) {
        setError(out.oidcError || t('app.error'))
        return
      }
      setOidcReady(true)
    })

  const saveOidc = (e: FormEvent) => {
    e.preventDefault()
    if (oidcOnly) saveOidcOnly()
    else saveAuth(true)
  }

  const discover = () =>
    run(async () => {
      const out = await api.post<{ issuer: string }>('/api/auth/oidc/discover', { url: oidc.oidcIssuer })
      setOidc((o) => ({ ...o, oidcIssuer: out.issuer }))
      setDiscovered(out.issuer)
    })

  const finish = () => (onDone ? onDone() : qc.invalidateQueries({ queryKey: ['me'] }))

  const heading = (text: string) => (
    <h2 ref={headingRef} tabIndex={-1} className="mb-1 font-display text-sm font-bold">
      {text}
    </h2>
  )
  const errorBox = error && (
    <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
      {error}
    </p>
  )
  const field = (key: keyof typeof oidc, label: string, type = 'text', required = false, hint = '') => (
    <div className="mb-3">
      <span className="mb-1 flex w-fit items-center">
        <label className="t-label block w-fit" htmlFor={`setup-${key}`}>
          {label}
        </label>
        <EnvBadge show={envLocked(key)} />
      </span>
      <input
        id={`setup-${key}`}
        className="t-input"
        type={type}
        required={required && !envLocked(key)}
        disabled={envLocked(key)}
        aria-describedby={hint ? `setup-${key}-hint` : undefined}
        value={oidc[key]}
        onChange={(e) => setOidc({ ...oidc, [key]: e.target.value })}
      />
      {hint && (
        <p id={`setup-${key}-hint`} className="mt-1 text-xs text-t-muted">
          {hint}
        </p>
      )}
    </div>
  )

  // the account/oidc/done panels are narrow forms; the later steps hold tables
  // and two-column grids and need the room
  const wide = step === 'import' || step === 'server' || step === 'storage' || step === 'meta'

  return (
    <main className="t-hatch grid min-h-screen place-items-center p-4">
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <span className="t-label mt-3">{t('setup.title')}</span>
        </div>

        {step !== 'done' && (
          <ol className="mb-5 flex flex-wrap gap-1" aria-label={t('setup.title')}>
            {STEPS.map((s, i) => (
              <li
                key={s}
                aria-current={s === step ? 'step' : undefined}
                className={`min-w-16 flex-1 border-t-2 pt-1.5 font-display text-[11px] ${
                  s === step ? 'border-accent text-accent' : 'border-border-subtle text-t-muted'
                }`}
              >
                <span className="font-mono text-[10px]">0{i + 1}</span> {t(`setup.step.${s}`)}
              </li>
            ))}
          </ol>
        )}

        {step === 'account' && (
          <form className="t-panel animate-fadeIn p-6" onSubmit={createAccount}>
            {heading(t('setup.step.account'))}
            <p className="mb-4 text-sm text-t-secondary">{t('setup.accountHint')}</p>
            <label className="t-label mb-1 block w-fit" htmlFor="setup-email">
              {t('login.email')}
            </label>
            <input
              id="setup-email"
              className="t-input mb-4"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="t-label mb-1 block w-fit" htmlFor="setup-password">
              {t('login.password')}
            </label>
            <input
              id="setup-password"
              className="t-input mb-4"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {errorBox}
            <button className="t-btn t-btn--primary t-cut w-full" disabled={busy}>
              {t('login.submitRegister')}
            </button>
            <div className="mt-4 border-t border-border-subtle pt-4">
              <button
                type="button"
                className="t-btn w-full"
                disabled={busy}
                onClick={() => {
                  setOidcOnly(true)
                  setStep('oidc')
                }}
              >
                {t('setup.noLocalAccount')}
              </button>
              <p className="mt-1 text-xs text-t-muted">{t('setup.noLocalAccountHint')}</p>
            </div>
          </form>
        )}

        {/* OIDC config stored and the provider answered: the first login through
            it creates the admin account, and the wizard resumes afterwards */}
        {step === 'oidc' && oidcReady && (
          <div className="t-panel animate-fadeIn p-6 text-center">
            {heading(t('setup.step.oidc'))}
            <p className="mb-4 text-sm text-t-secondary" role="status">
              {t('setup.oidcReady')}
            </p>
            <a className="t-btn t-btn--primary t-cut block w-full" href="/api/auth/oidc/login">
              {oidc.oidcProviderName ? t('login.oidcNamed', { name: oidc.oidcProviderName }) : t('login.oidc')}
            </a>
          </div>
        )}

        {step === 'oidc' && !oidcReady && (
          <form className="t-panel animate-fadeIn p-6" onSubmit={saveOidc}>
            {heading(t('setup.step.oidc'))}
            <p className="mb-4 text-sm text-t-secondary">{t(oidcOnly ? 'setup.oidcOnlyHint' : 'setup.oidcHint')}</p>
            {field('oidcProviderName', t('settings.oidcProviderName'), 'text', false, t('settings.oidcProviderNameHint'))}
            <div className="mb-3">
              <span className="mb-1 flex w-fit items-center">
                <label className="t-label block w-fit" htmlFor="setup-oidcIssuer">
                  {t('settings.oidcIssuer')}
                </label>
                <EnvBadge show={envLocked('oidcIssuer')} />
              </span>
              <div className="flex gap-2">
                <input
                  id="setup-oidcIssuer"
                  className="t-input"
                  type="text"
                  required={oidcOnly && !envLocked('oidcIssuer')}
                  disabled={envLocked('oidcIssuer')}
                  value={oidc.oidcIssuer}
                  onChange={(e) => setOidc({ ...oidc, oidcIssuer: e.target.value })}
                />
                <button
                  type="button"
                  className="t-btn shrink-0"
                  disabled={busy || !oidc.oidcIssuer || envLocked('oidcIssuer')}
                  onClick={discover}
                >
                  {t('settings.oidcDiscover')}
                </button>
              </div>
              {discovered && (
                <p className="mt-1 text-xs text-t-muted" role="status">
                  {t('settings.oidcDiscoverFound', { issuer: discovered })}
                </p>
              )}
              <p className="mt-1 text-xs text-t-muted">{t('settings.oidcIssuerHint')}</p>
            </div>
            {field('oidcClientId', t('settings.oidcClientId'), 'text', oidcOnly, t('settings.oidcClientIdHint'))}
            {field('oidcClientSecret', t('settings.oidcClientSecret'), 'password', false, t('settings.oidcClientSecretHint'))}
            {field('oidcRedirectUrl', t('settings.oidcRedirectUrl'), 'url', oidcOnly, t('settings.oidcRedirectUrlHint'))}
            {field('oidcClaim', t('settings.oidcClaim'), 'text', false, t('settings.oidcClaimHint'))}
            {field('oidcAdminValues', t('settings.oidcAdminValues'), 'text', false, t('settings.oidcAdminValuesHint'))}
            {field('oidcUserValues', t('settings.oidcUserValues'), 'text', false, t('settings.oidcUserValuesHint'))}
            {/* only meaningful with a password account: OIDC-only has no
                password registration to close (and it is off by default) */}
            {!oidcOnly && (
              <>
                <label className="mb-1 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={registrationDisabled}
                    onChange={(e) => setRegistrationDisabled(e.target.checked)}
                  />
                  {t('setup.closeRegistration')}
                </label>
                <p className="mb-4 text-xs text-t-muted">{t('setup.closeRegistrationHint')}</p>
              </>
            )}
            {errorBox}
            <div className="flex gap-2">
              <button
                type="button"
                className="t-btn flex-1"
                disabled={busy}
                onClick={() => (oidcOnly ? (setOidcOnly(false), setStep('account')) : saveAuth(false))}
              >
                {t(oidcOnly ? 'setup.back' : 'setup.skip')}
              </button>
              <button className="t-btn t-btn--primary t-cut flex-1" disabled={busy}>
                {t('settings.save')}
              </button>
            </div>
          </form>
        )}

        {(step === 'import' || step === 'server' || step === 'storage' || step === 'meta') && (
          <SetupSteps step={step} onGo={setStep} onFinish={() => setStep('done')} />
        )}

        {step === 'done' && (
          <div className="t-panel animate-fadeIn p-6 text-center">
            {heading(t('setup.stepDone'))}
            <p className="mb-4 text-sm text-t-secondary" role="status">
              {t('setup.done')}
            </p>
            <button className="t-btn t-btn--primary t-cut w-full" onClick={finish}>
              {t('setup.start')}
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
