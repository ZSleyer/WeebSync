import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleCheck, CircleMinus } from 'lucide-react'
import { Button, ButtonLink, Input, Switch } from 'fluid-lycoris'
import { api } from '../api'
import SetupSteps, { SetupFoot, SetupHeading, type SetupSummary } from '../components/SetupSteps'
import { EnvBadge } from './settings/useSettingsForm'
import Brand from '../components/Brand'
import { MIN_PASSWORD } from './authLimits'
import { FINISHING_KEY } from './setupState'
import './auth.css'

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
// steps the rail marks as optional (the OIDC step is required without a local account)
const OPTIONAL: Step[] = ['oidc', 'import']

// The step survives the wizard being mounted afresh: a reload, or RootLayout
// swapping from the login screen's wizard to the signed-in one once ['me'] is
// refetched after step 01, which mounts it with initialStep "import". Without
// it a reload on step 02 jumped to 03 and the OIDC step never came back. The
// OIDC-only path stores "import" before it leaves for its provider, so it
// comes back at step 03. Signed out (initialStep "account") there is no
// account yet, so nothing past step 01 can be resumed.
const STEP_KEY = 'weebsync.setup.step'
const storedStep = (initial: Step): Step => {
  if (initial === 'account') return initial
  const s = sessionStorage.getItem(STEP_KEY) as Step | null
  // the save before the closing step can remount the wizard; it comes back
  // on that step, not at the start of the list
  if (s === 'done' && sessionStorage.getItem(FINISHING_KEY)) return 'done'
  return s && s !== 'account' && STEPS.includes(s) ? s : initial
}

// The first-run token from the server log: the account and provider steps
// carry it until the first account exists. Kept for the tab, so the provider
// detour of the OIDC-only path does not ask for it twice.
const SETUP_TOKEN_KEY = 'ws-setup-token'
function readSetupToken(): string {
  try {
    return sessionStorage.getItem(SETUP_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeSetupToken(v: string) {
  try {
    sessionStorage.setItem(SETUP_TOKEN_KEY, v)
  } catch {
    // storage blocked: the field still holds it for this page
  }
}
const setupHeader = () => ({ 'X-Setup-Token': readSetupToken() })

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
  const [setupToken, setSetupToken] = useState(readSetupToken)
  const [step, setStep] = useState<Step>(() => storedStep(initialStep))
  useEffect(() => {
    sessionStorage.setItem(STEP_KEY, step)
  }, [step])
  // no local account: step 02 becomes mandatory and the first OIDC login is admin
  const [oidcOnly, setOidcOnly] = useState(false)
  // set once the OIDC config is stored and the provider is reachable
  const [oidcReady, setOidcReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // typed twice: a typo here locks the only admin out before anything else exists
  const [again, setAgain] = useState('')
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
  // what the run left behind, for the closing list; gone after a reload
  const [oidcSaved, setOidcSaved] = useState(false)
  const [summary, setSummary] = useState<SetupSummary | null>(null)
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
    // no local account: straight on to the provider's settings
    if (oidcOnly) return setStep('oidc')
    if (password !== again) return setError(t('account.passwordMismatch'))
    run(async () => {
      // locale rides along so server-delivered texts match the ui language
      await api.post('/api/auth/register', { email, password, locale: i18n.language, remember: true }, setupHeader())
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
      setOidcSaved(withOidc && !!oidc.oidcIssuer)
      setStep('import')
    })

  // no account yet, so this goes through the unauthenticated setup endpoint.
  // It only stores the config; the wizard then waits for the first OIDC login.
  const saveOidcOnly = () =>
    run(async () => {
      const out = await api.post<{ oidcEnabled: boolean; oidcError?: string }>(
        '/api/auth/setup/oidc',
        { ...oidc, baseUrl: window.location.origin },
        setupHeader(),
      )
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
      const out = await api.post<{ issuer: string }>('/api/auth/oidc/discover', { url: oidc.oidcIssuer }, setupHeader())
      setOidc((o) => ({ ...o, oidcIssuer: out.issuer }))
      setDiscovered(out.issuer)
    })

  const finish = () => {
    sessionStorage.removeItem(FINISHING_KEY)
    sessionStorage.removeItem(STEP_KEY)
    return onDone ? onDone() : qc.invalidateQueries({ queryKey: ['me'] })
  }

  const heading = (text: string) => <SetupHeading headingRef={headingRef}>{text}</SetupHeading>
  const field = (key: keyof typeof oidc, label: string, type = 'text', required = false, hint = '') => (
    <div>
      <span className="ws-lbl-row">
        <label htmlFor={`setup-${key}`} className="ws-lbl">
          {label}
        </label>
        <EnvBadge show={envLocked(key)} />
      </span>
      <Input
        id={`setup-${key}`}
        type={type}
        required={required && !envLocked(key)}
        disabled={envLocked(key)}
        aria-describedby={hint ? `setup-${key}-hint` : undefined}
        value={oidc[key]}
        onChange={(e) => setOidc({ ...oidc, [key]: e.target.value })}
      />
      {hint && (
        <p id={`setup-${key}-hint`} className="ws-login-hint">
          {hint}
        </p>
      )}
    </div>
  )

  // "done" is the last of the steps the wizard counts, as the user sees it
  const all = [...STEPS, 'done'] as const
  const at = all.indexOf(step)
  const pad = (n: number) => String(n).padStart(2, '0')
  const label = (s: (typeof all)[number]) => (s === 'done' ? t('setup.stepDone') : t(`setup.step.${s}`))
  const tooShort = Math.max(0, MIN_PASSWORD - password.length)

  return (
    // a desktop keeps the steps in a rail on the left, a phone counts them
    // above the step
    <main className="ws-su">
      <aside className="ws-su-rail">
        <p className="ws-su-brand font-display text-lg font-bold tracking-[0.2em]" aria-hidden>
          <Brand variant="rail" />
        </p>
        <ol className="ws-su-steps" aria-label={t('setup.title')}>
          {all.map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              data-st={s === step ? 'on' : i < at ? 'done' : undefined}
            >
              <span>{pad(i + 1)}</span>
              {label(s)}
              {OPTIONAL.includes(s as Step) && <small>{t('setup.optional')}</small>}
            </li>
          ))}
        </ol>
      </aside>
      <div className="ws-su-main">
        <h1 className="sr-only">{t('setup.title')}</h1>
        {/* where the wizard stands: "04 / 07" and a bar, on every width */}
        <div className="ws-su-top" aria-hidden>
          <span>
            {pad(at + 1)} / {pad(all.length)}
          </span>
          <span className="ws-su-bar">
            <span style={{ transform: `scaleX(${(at + 1) / all.length})` }} />
          </span>
        </div>
        <p className="sr-only" aria-live="polite">
          {t('setup.stepOf', { n: at + 1, total: all.length })}: {label(step)}
        </p>

        {step === 'account' && (
          <form key="account" className="ws-su-step" onSubmit={createAccount}>
            <div className="ws-su-body">
              {heading(t('setup.accountTitle'))}
              <p className="ws-quiet">{t('setup.accountHint')}</p>
              <label htmlFor="setup-token" className="ws-lbl">
                {t('setup.token')}
              </label>
              <Input
                id="setup-token"
                kind="code"
                required
                autoComplete="off"
                spellCheck={false}
                aria-describedby="setup-token-hint"
                className="font-mono"
                value={setupToken}
                onChange={(e) => {
                  setSetupToken(e.target.value)
                  writeSetupToken(e.target.value)
                }}
              />
              <p id="setup-token-hint" className="ws-login-hint">
                {t('setup.tokenHint')}
              </p>
              <Switch
                label={<span className="text-sm font-medium">{t('setup.noLocalAccount')}</span>}
                aria-describedby="setup-oidc-only-hint"
                checked={oidcOnly}
                onChange={(e) => setOidcOnly(e.target.checked)}
              />
              <p id="setup-oidc-only-hint" className="ws-login-hint">
                {t('setup.noLocalAccountHint')}
              </p>
              {!oidcOnly && (
                <>
                  <label htmlFor="setup-email" className="ws-lbl">
                    {t('login.email')}
                  </label>
                  <Input
                    id="setup-email"
                    enterKeyHint="next"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <label htmlFor="setup-password" className="ws-lbl">
                    {t('login.password')}
                  </label>
                  <Input
                    id="setup-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={MIN_PASSWORD}
                    aria-describedby="setup-password-hint"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <p id="setup-password-hint" className="ws-login-hint" data-ok={tooShort === 0 || undefined}>
                    {tooShort > 0 ? t('login.lengthLeft', { min: MIN_PASSWORD, n: tooShort }) : t('login.lengthOk')}
                  </p>
                  <label htmlFor="setup-password-again" className="ws-lbl">
                    {t('login.passwordAgain')}
                  </label>
                  <Input
                    id="setup-password-again"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={MIN_PASSWORD}
                    value={again}
                    onChange={(e) => setAgain(e.target.value)}
                  />
                </>
              )}
            </div>
            <SetupFoot error={error}>
              <Button type="submit" variant="primary" disabled={busy}>
                {oidcOnly ? t('setup.continue') : t('login.submitRegister')}
              </Button>
            </SetupFoot>
          </form>
        )}

        {/* OIDC config stored and the provider answered: the first login through
            it creates the admin account, and the wizard resumes afterwards */}
        {step === 'oidc' && oidcReady && (
          <section key="oidc-ready" className="ws-su-step">
            <div className="ws-su-body">
              {heading(t('setup.oidcTitle'))}
              <p className="ws-quiet" role="status">
                {t('setup.oidcReady')}
              </p>
            </div>
            <SetupFoot>
              <ButtonLink
                variant="primary"
                href="/api/auth/oidc/login?remember=1"
                onClick={(e) => {
                  // the first identity the provider sends back becomes the
                  // admin: the server lets it only with the setup code
                  e.preventDefault()
                  sessionStorage.setItem(STEP_KEY, 'import')
                  void run(async () => {
                    await api.post('/api/auth/setup/oidc-start', undefined, setupHeader())
                    window.location.href = '/api/auth/oidc/login?remember=1'
                  })
                }}
              >
                {oidc.oidcProviderName ? t('login.oidcNamed', { name: oidc.oidcProviderName }) : t('login.oidc')}
              </ButtonLink>
            </SetupFoot>
          </section>
        )}

        {step === 'oidc' && !oidcReady && (
          <form key="oidc" className="ws-su-step" onSubmit={saveOidc}>
            <div className="ws-su-body">
              {heading(t('setup.oidcTitle'))}
              <p className="ws-quiet">{t(oidcOnly ? 'setup.oidcOnlyHint' : 'setup.oidcHint')}</p>
              {field(
                'oidcProviderName',
                t('settings.oidcProviderName'),
                'text',
                false,
                t('settings.oidcProviderNameHint'),
              )}
              <div>
                <span className="ws-lbl-row">
                  <label htmlFor="setup-oidcIssuer" className="ws-lbl">
                    {t('settings.oidcIssuer')}
                  </label>
                  <EnvBadge show={envLocked('oidcIssuer')} />
                </span>
                <div className="flex gap-2">
                  <Input
                    id="setup-oidcIssuer"
                    kind="url"
                    type="text"
                    className="font-mono"
                    required={oidcOnly && !envLocked('oidcIssuer')}
                    disabled={envLocked('oidcIssuer')}
                    aria-describedby="setup-oidcIssuer-hint"
                    value={oidc.oidcIssuer}
                    onChange={(e) => setOidc({ ...oidc, oidcIssuer: e.target.value })}
                  />
                  <Button
                    className="shrink-0"
                    disabled={busy || !oidc.oidcIssuer || envLocked('oidcIssuer')}
                    onClick={discover}
                  >
                    {t('settings.oidcDiscover')}
                  </Button>
                </div>
                {discovered && (
                  <p className="ws-su-ok" role="status">
                    <CircleCheck aria-hidden size={18} />
                    {t('settings.oidcDiscoverFound', { issuer: discovered })}
                  </p>
                )}
                <p id="setup-oidcIssuer-hint" className="ws-login-hint">
                  {t('settings.oidcIssuerHint')}
                </p>
              </div>
              <div className="ws-su-2">
                {field('oidcClientId', t('settings.oidcClientId'), 'text', oidcOnly, t('settings.oidcClientIdHint'))}
                {field(
                  'oidcClientSecret',
                  t('settings.oidcClientSecret'),
                  'password',
                  false,
                  t('settings.oidcClientSecretHint'),
                )}
              </div>
              {field(
                'oidcRedirectUrl',
                t('settings.oidcRedirectUrl'),
                'url',
                oidcOnly,
                t('settings.oidcRedirectUrlHint'),
              )}
              {field('oidcClaim', t('settings.oidcClaim'), 'text', false, t('settings.oidcClaimHint'))}
              <div className="ws-su-2">
                {field(
                  'oidcAdminValues',
                  t('settings.oidcAdminValues'),
                  'text',
                  false,
                  t('settings.oidcAdminValuesHint'),
                )}
                {field('oidcUserValues', t('settings.oidcUserValues'), 'text', false, t('settings.oidcUserValuesHint'))}
              </div>
              {/* only meaningful with a password account: OIDC-only has no
                  password registration to close (and it is off by default) */}
              {!oidcOnly && (
                <div className="mt-4">
                  <Switch
                    label={<span className="text-sm font-medium">{t('setup.closeRegistration')}</span>}
                    aria-describedby="setup-close-hint"
                    checked={registrationDisabled}
                    onChange={(e) => setRegistrationDisabled(e.target.checked)}
                  />
                  <p id="setup-close-hint" className="ws-login-hint">
                    {t('setup.closeRegistrationHint')}
                  </p>
                </div>
              )}
            </div>
            <SetupFoot
              onBack={
                oidcOnly
                  ? () => {
                      setOidcOnly(false)
                      setStep('account')
                    }
                  : undefined
              }
              onSkip={oidcOnly ? undefined : () => saveAuth(false)}
              error={error}
            >
              <Button type="submit" variant="primary" disabled={busy}>
                {t('setup.continue')}
              </Button>
            </SetupFoot>
          </form>
        )}

        {(step === 'import' || step === 'server' || step === 'storage' || step === 'meta') && (
          <SetupSteps
            key={step}
            step={step}
            onGo={setStep}
            onFinish={(s) => {
              sessionStorage.setItem(FINISHING_KEY, '1')
              setSummary(s)
              setStep('done')
            }}
            headingRef={headingRef}
          />
        )}

        {step === 'done' && (
          <section key="done" className="ws-su-step">
            <div className="ws-su-body">
              {heading(t('setup.doneTitle'))}
              <p className="ws-quiet" role="status">
                {t('setup.done')}
              </p>
              {summary && (
                <ul className="ws-su-sum">
                  {(
                    [
                      [t('setup.step.account'), email || t('setup.sumDone')],
                      [t('setup.step.oidc'), oidcSaved || oidcOnly ? t('setup.sumDone') : null],
                      [t('setup.step.import'), summary.imported ? t('setup.sumDone') : null],
                      [t('setup.step.server'), summary.server ?? null],
                      [t('setup.step.storage'), t('setup.sumRoots', { count: summary.roots })],
                      [t('setup.step.meta'), summary.meta.length ? summary.meta.join(', ') : null],
                    ] as const
                  ).map(([k, v]) => (
                    <li key={k} data-skip={v === null || undefined}>
                      {v === null ? <CircleMinus aria-hidden size={18} /> : <CircleCheck aria-hidden size={18} />}
                      <span>{k}</span>
                      <span>{v ?? t('setup.sumSkipped')}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="ws-quiet">{t('setup.doneNext')}</p>
            </div>
            <SetupFoot>
              <Button variant="primary" onClick={finish}>
                {t('setup.start')}
              </Button>
            </SetupFoot>
          </section>
        )}
      </div>
    </main>
  )
}
