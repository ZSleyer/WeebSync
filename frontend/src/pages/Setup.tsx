import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { EnvBadge } from './settings/useSettingsForm'

// First-run wizard, shown while the instance has no users yet (authConfig.setupNeeded).
// Two paths: a local password account (registered first, so it becomes admin; OIDC
// optional afterwards via the settings API) - or pure OIDC, where the config is
// stored through the unauthenticated setup endpoint and the first OIDC login
// becomes admin. The account path must NOT invalidate ['me'] before the final
// step - that would swap in the app shell mid-wizard.
type Step = 'choose' | 'account' | 'oidc' | 'oidc-first' | 'oidc-ready' | 'done'

export default function Setup() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>('choose')
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

  // account path: session from step 1 is admin → normal settings API.
  // Always persists the registration choice, even when OIDC is skipped, so the
  // recommended "close registration" default actually takes effect.
  const persistAndDone = (withOidc: boolean) =>
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
      setStep('done')
    })

  const saveOidc = (e: FormEvent) => {
    e.preventDefault()
    persistAndDone(true)
  }

  // pure-OIDC path: no account yet → unauthenticated setup endpoint
  const saveOidcFirst = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const out = await api.post<{ oidcEnabled: boolean; oidcError?: string }>('/api/auth/setup/oidc', { ...oidc, baseUrl: window.location.origin })
      if (out.oidcError || !out.oidcEnabled) {
        setError(out.oidcError || t('app.error'))
        return
      }
      setStep('oidc-ready')
    })
  }

  const discover = () =>
    run(async () => {
      const out = await api.post<{ issuer: string }>('/api/auth/oidc/discover', { url: oidc.oidcIssuer })
      setOidc((o) => ({ ...o, oidcIssuer: out.issuer }))
      setDiscovered(out.issuer)
    })

  const finish = () => qc.invalidateQueries({ queryKey: ['me'] })

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
  const backBtn = (
    <button type="button" className="t-btn flex-1" disabled={busy} onClick={() => setStep('choose')}>
      {t('setup.back')}
    </button>
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
  const oidcFields = (required: boolean) => (
    <>
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
            required={required && !envLocked('oidcIssuer')}
            disabled={envLocked('oidcIssuer')}
            value={oidc.oidcIssuer}
            onChange={(e) => setOidc({ ...oidc, oidcIssuer: e.target.value })}
          />
          <button type="button" className="t-btn shrink-0" disabled={busy || !oidc.oidcIssuer || envLocked('oidcIssuer')} onClick={discover}>
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
      {field('oidcClientId', t('settings.oidcClientId'), 'text', required, t('settings.oidcClientIdHint'))}
      {field('oidcClientSecret', t('settings.oidcClientSecret'), 'password', false, t('settings.oidcClientSecretHint'))}
      {field('oidcRedirectUrl', t('settings.oidcRedirectUrl'), 'url', required, t('settings.oidcRedirectUrlHint'))}
      {field('oidcClaim', t('settings.oidcClaim'), 'text', false, t('settings.oidcClaimHint'))}
      {field('oidcAdminValues', t('settings.oidcAdminValues'), 'text', false, t('settings.oidcAdminValuesHint'))}
      {field('oidcUserValues', t('settings.oidcUserValues'), 'text', false, t('settings.oidcUserValuesHint'))}
    </>
  )

  const steps: { key: Step[]; labels: string[] } | null =
    step === 'choose'
      ? null
      : step === 'oidc-first' || step === 'oidc-ready'
        ? { key: ['oidc-first', 'oidc-ready'], labels: [t('setup.stepOidc'), t('setup.stepLogin')] }
        : { key: ['account', 'oidc', 'done'], labels: [t('setup.stepAccount'), t('setup.stepOidc'), t('setup.stepDone')] }

  return (
    <main className="t-hatch grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <span className="t-label mt-3">{t('setup.title')}</span>
        </div>

        <div className="t-panel animate-fadeIn p-6">
          {steps && (
            <ol className="mb-5 flex gap-1" aria-label={t('setup.title')}>
              {steps.labels.map((s, i) => (
                <li
                  key={s}
                  aria-current={steps.key[i] === step ? 'step' : undefined}
                  className={`flex-1 border-t-2 pt-1.5 font-display text-[11px] ${
                    steps.key[i] === step ? 'border-accent text-accent' : 'border-border-subtle text-t-muted'
                  }`}
                >
                  <span className="font-mono text-[10px]">0{i + 1}</span> {s}
                </li>
              ))}
            </ol>
          )}

          {step === 'choose' && (
            <div>
              {heading(t('setup.choose'))}
              <p className="mb-4 text-sm text-t-secondary">{t('setup.intro')}</p>
              <button className="t-btn t-btn--primary t-cut mb-1 w-full" onClick={() => setStep('account')}>
                {t('setup.choosePassword')}
              </button>
              <p className="mb-4 text-xs text-t-muted">{t('setup.choosePasswordHint')}</p>
              <button className="t-btn mb-1 w-full" onClick={() => setStep('oidc-first')}>
                {t('setup.chooseOidc')}
              </button>
              <p className="text-xs text-t-muted">{t('setup.chooseOidcHint')}</p>
            </div>
          )}

          {step === 'account' && (
            <form onSubmit={createAccount}>
              {heading(t('setup.stepAccount'))}
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
              <div className="flex gap-2">
                {backBtn}
                <button className="t-btn t-btn--primary t-cut flex-1" disabled={busy}>
                  {t('login.submitRegister')}
                </button>
              </div>
            </form>
          )}

          {step === 'oidc' && (
            <form onSubmit={saveOidc}>
              {heading(t('setup.stepOidc'))}
              <p className="mb-4 text-sm text-t-secondary">{t('setup.oidcHint')}</p>
              {oidcFields(false)}
              <label className="mb-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={registrationDisabled}
                  onChange={(e) => setRegistrationDisabled(e.target.checked)}
                />
                {t('setup.closeRegistration')}
              </label>
              <p className="mb-4 text-xs text-t-muted">{t('setup.closeRegistrationHint')}</p>
              {errorBox}
              <div className="flex gap-2">
                <button type="button" className="t-btn flex-1" disabled={busy} onClick={() => persistAndDone(false)}>
                  {t('setup.skip')}
                </button>
                <button className="t-btn t-btn--primary t-cut flex-1" disabled={busy}>
                  {t('settings.save')}
                </button>
              </div>
            </form>
          )}

          {step === 'oidc-first' && (
            <form onSubmit={saveOidcFirst}>
              {heading(t('setup.chooseOidc'))}
              <p className="mb-4 text-sm text-t-secondary">{t('setup.chooseOidcHint')}</p>
              {oidcFields(true)}
              {errorBox}
              <div className="flex gap-2">
                {backBtn}
                <button className="t-btn t-btn--primary t-cut flex-1" disabled={busy}>
                  {t('settings.save')}
                </button>
              </div>
            </form>
          )}

          {step === 'oidc-ready' && (
            <div className="text-center">
              {heading(t('setup.stepLogin'))}
              <p className="mb-4 text-sm text-t-secondary" role="status">
                {t('setup.oidcReady')}
              </p>
              <a className="t-btn t-btn--primary t-cut block w-full" href="/api/auth/oidc/login">
                {oidc.oidcProviderName
                  ? t('login.oidcNamed', { name: oidc.oidcProviderName })
                  : t('login.oidc')}
              </a>
            </div>
          )}

          {step === 'done' && (
            <div className="text-center">
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
      </div>
    </main>
  )
}
