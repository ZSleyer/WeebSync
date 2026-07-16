import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type UserAccount } from '../api'
import { useAuth } from '../hooks'
import { LOCALES } from '../locales'
import { pushSubscription, pushSupported, subscribePush, unsubscribePush } from '../push'

const ACCENTS = ['violet', 'acid', 'crimson', 'cyan', 'blue', 'green', 'pink', 'orange']

interface SettingsState {
  maxConcurrent: number
  globalRateLimit: number
  watchIntervalMin: number
  registrationDisabled: boolean
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  anilistTokenSet: boolean
  anilistToken?: string
  plexUrl: string
  plexTokenSet: boolean
  plexToken?: string
  plexSections: string
  oidcProviderName: string
  oidcIssuer: string
  oidcClientId: string
  oidcRedirectUrl: string
  oidcClientSecretSet: boolean
  oidcClientSecret?: string
  oidcClaim: string
  oidcAdminValues: string
  oidcUserValues: string
  oidcEnabled: boolean
  oidcError?: string
}

export default function Settings() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  const [form, setForm] = useState<SettingsState | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (data && !form)
      setForm({ ...data, anilistToken: '', plexToken: '', oidcClientSecret: '', oidcClaim: data.oidcClaim || 'groups' })
  }, [data, form])

  const save = useMutation({
    mutationFn: (s: SettingsState) => api.put<SettingsState>('/api/settings', s),
    onSuccess: (fresh) => {
      qc.setQueryData(['settings'], fresh)
      setForm({ ...fresh, anilistToken: '', plexToken: '', oidcClientSecret: '' })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const isAdmin = !!user?.isAdmin
  const set = <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => form && setForm({ ...form, [k]: v })

  const [discovered, setDiscovered] = useState('')
  const discover = async () => {
    if (!form?.oidcIssuer) return
    setDiscovered('')
    try {
      const out = await api.post<{ issuer: string }>('/api/auth/oidc/discover', { url: form.oidcIssuer })
      set('oidcIssuer', out.issuer)
      setDiscovered(t('settings.oidcDiscoverFound', { issuer: out.issuer }))
    } catch (err) {
      setDiscovered(err instanceof Error ? err.message : t('app.error'))
    }
  }

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('settings.title')}</h2>
        <span className="t-label mt-1">{t('settings.sub')}</span>
      </header>

      {!isAdmin && <p className="t-panel mb-4 p-3 text-sm text-t-secondary">{t('settings.adminOnly')}</p>}

      {form && isAdmin && (
        <>
          <section className="t-panel mb-4 p-5" aria-label={t('settings.transfers')}>
            <span className="t-label t-label--accent">{t('settings.transfers')}</span>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-t-muted">
                {t('settings.maxConcurrent')}
                <input
                  className="t-input mt-1 font-mono"
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxConcurrent}
                  onChange={(e) => set('maxConcurrent', Number(e.target.value))}
                />
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.globalLimit')}
                <input
                  className="t-input mt-1 font-mono"
                  type="number"
                  min={0}
                  value={Math.round(form.globalRateLimit / 1024)}
                  onChange={(e) => set('globalRateLimit', Number(e.target.value) * 1024)}
                />
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.watchInterval')}
                <input
                  className="t-input mt-1 font-mono"
                  type="number"
                  min={5}
                  max={1440}
                  value={form.watchIntervalMin}
                  onChange={(e) => set('watchIntervalMin', Number(e.target.value))}
                />
              </label>
            </div>
          </section>

          <section className="t-panel mb-4 p-5" aria-label={t('settings.auth')}>
            <span className="t-label t-label--accent">{t('settings.auth')}</span>
            <div className="mt-3 grid grid-cols-1 gap-4">
              <label className="flex items-center gap-2 text-sm text-t-secondary">
                <input
                  type="checkbox"
                  checked={form.registrationDisabled}
                  onChange={(e) => set('registrationDisabled', e.target.checked)}
                />
                {t('settings.registrationDisabled')}
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.authMode')}
                <span className="t-select-wrap mt-1 max-w-sm">
                  <select
                    className="t-select"
                    value={form.authMode}
                    onChange={(e) => set('authMode', e.target.value as SettingsState['authMode'])}
                  >
                    <option value="password">{t('settings.authModePassword')}</option>
                    <option value="oidc-only" disabled={!form.oidcIssuer}>
                      {t('settings.authModeOidcOnly')}
                    </option>
                    <option value="oidc-auto" disabled={!form.oidcIssuer}>
                      {t('settings.authModeOidcAuto')}
                    </option>
                  </select>
                </span>
              </label>

              <fieldset className="border border-border-subtle p-3">
                <legend className="t-label">
                  {t('settings.oidc')} ·{' '}
                  <span className={form.oidcEnabled ? 'text-ok' : 'text-t-muted'}>
                    {form.oidcEnabled ? t('settings.oidcActive') : t('settings.oidcInactive')}
                  </span>
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-t-muted sm:col-span-2">
                    {t('settings.oidcProviderName')}
                    <input
                      className="t-input mt-1"
                      placeholder="Authentik"
                      value={form.oidcProviderName}
                      onChange={(e) => set('oidcProviderName', e.target.value)}
                    />
                    <span className="mt-1 block">{t('settings.oidcProviderNameHint')}</span>
                  </label>
                  <label className="text-xs text-t-muted sm:col-span-2">
                    {t('settings.oidcIssuer')}
                    <span className="mt-1 flex gap-2">
                      <input
                        className="t-input font-mono"
                        placeholder="https://auth.example.com/application/o/weebsync/"
                        value={form.oidcIssuer}
                        onChange={(e) => set('oidcIssuer', e.target.value)}
                      />
                      <button
                        type="button"
                        className="t-btn t-btn--sm shrink-0"
                        disabled={!form.oidcIssuer}
                        onClick={discover}
                      >
                        {t('settings.oidcDiscover')}
                      </button>
                    </span>
                    {discovered && (
                      <span className="mt-1 block" role="status">
                        {discovered}
                      </span>
                    )}
                  </label>
                  <label className="text-xs text-t-muted">
                    {t('settings.oidcClientId')}
                    <input
                      className="t-input mt-1 font-mono"
                      value={form.oidcClientId}
                      onChange={(e) => set('oidcClientId', e.target.value)}
                    />
                  </label>
                  <label className="text-xs text-t-muted">
                    {t('settings.oidcClientSecret')}
                    <input
                      className="t-input mt-1 font-mono"
                      type="password"
                      autoComplete="off"
                      placeholder={form.oidcClientSecretSet ? t('settings.secretSet') : t('settings.secretUnset')}
                      value={form.oidcClientSecret ?? ''}
                      onChange={(e) => set('oidcClientSecret', e.target.value)}
                    />
                  </label>
                  <label className="text-xs text-t-muted sm:col-span-2">
                    {t('settings.oidcRedirectUrl')}
                    <input
                      className="t-input mt-1 font-mono"
                      placeholder="https://weebsync.example.com/api/auth/oidc/callback"
                      value={form.oidcRedirectUrl}
                      onChange={(e) => set('oidcRedirectUrl', e.target.value)}
                    />
                  </label>
                  <label className="text-xs text-t-muted sm:col-span-2">
                    {t('settings.oidcClaim')}
                    <input
                      className="t-input mt-1 font-mono"
                      placeholder="groups"
                      value={form.oidcClaim}
                      onChange={(e) => set('oidcClaim', e.target.value)}
                    />
                    <span className="mt-1 block">{t('settings.oidcClaimHint')}</span>
                  </label>
                  <label className="text-xs text-t-muted">
                    {t('settings.oidcAdminValues')}
                    <input
                      className="t-input mt-1 font-mono"
                      placeholder="admins"
                      value={form.oidcAdminValues}
                      onChange={(e) => set('oidcAdminValues', e.target.value)}
                    />
                    <span className="mt-1 block">{t('settings.oidcAdminValuesHint')}</span>
                  </label>
                  <label className="text-xs text-t-muted">
                    {t('settings.oidcUserValues')}
                    <input
                      className="t-input mt-1 font-mono"
                      placeholder="users"
                      value={form.oidcUserValues}
                      onChange={(e) => set('oidcUserValues', e.target.value)}
                    />
                    <span className="mt-1 block">{t('settings.oidcUserValuesHint')}</span>
                  </label>
                  <p className="text-xs text-t-muted sm:col-span-2">{t('settings.oidcAdminHint')}</p>
                </div>
                {form.oidcError && (
                  <p className="mt-2 text-xs text-err" role="alert">
                    {form.oidcError}
                  </p>
                )}
                <p className="mt-2 text-xs text-t-muted">{t('settings.oidcMigrationHint')}</p>
              </fieldset>
            </div>
          </section>

          <section className="t-panel mb-4 p-5" aria-label={t('settings.integrations')}>
            <span className="t-label t-label--accent">{t('settings.integrations')}</span>
            <label className="mt-3 block text-xs text-t-muted">
              {t('settings.anilistToken')}
              <input
                className="t-input mt-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={form.anilistTokenSet ? t('settings.secretSet') : t('settings.secretUnset')}
                value={form.anilistToken ?? ''}
                onChange={(e) => set('anilistToken', e.target.value)}
              />
            </label>

            <div className="mt-5 grid grid-cols-1 gap-4">
              <span className="t-label">{t('settings.plex')}</span>
              <label className="text-xs text-t-muted">
                {t('settings.plexUrl')}
                <input
                  className="t-input mt-1 font-mono"
                  placeholder="https://plex.example.com"
                  value={form.plexUrl}
                  onChange={(e) => set('plexUrl', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.plexUrlHint')}</span>
              </label>
              <label className="text-xs text-t-muted">
                {t('settings.plexToken')}
                <input
                  className="t-input mt-1 font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={form.plexTokenSet ? t('settings.secretSet') : t('settings.secretUnset')}
                  value={form.plexToken ?? ''}
                  onChange={(e) => set('plexToken', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.plexTokenHint')}</span>
              </label>
              {form.plexTokenSet && form.plexUrl && (
                <PlexSections value={form.plexSections} onChange={(v) => set('plexSections', v)} />
              )}
            </div>
          </section>

          <div className="mb-6 flex items-center gap-3">
            <button className="t-btn t-btn--primary t-cut" onClick={() => save.mutate(form)} disabled={save.isPending}>
              {t('settings.save')}
            </button>
            {saved && <span className="t-label t-label--ok" role="status">{t('settings.saved')}</span>}
            {save.error && (
              <span className="text-sm text-err" role="alert">
                {(save.error as Error).message}
              </span>
            )}
          </div>
        </>
      )}

      {isAdmin && user && <UsersSection meId={user.id} />}
      <PushSection />
      <LookSection locales={LOCALES} language={i18n.language} onLanguage={(l) => i18n.changeLanguage(l)} />
    </div>
  )
}

function UsersSection({ meId }: { meId: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: users } = useQuery<UserAccount[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users'),
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const opts = {
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: Error) => setError(e.message),
  }
  const create = useMutation({
    mutationFn: () => api.post('/api/users', { email, password }),
    ...opts,
    onSuccess: () => {
      setEmail('')
      setPassword('')
      opts.onSuccess()
    },
  })
  const toggle = useMutation({
    mutationFn: (u: UserAccount) => api.put(`/api/users/${u.id}`, { isAdmin: !u.isAdmin }),
    ...opts,
  })
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    ...opts,
  })

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.users')}>
      <span className="t-label t-label--accent">{t('settings.users')}</span>
      <ul className="mt-3 grid grid-cols-1 gap-2">
        {(users ?? []).map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 border-b border-border-subtle pb-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-secondary" title={u.email}>
              {u.email}
            </span>
            {u.id === meId && <span className="t-label">{t('settings.usersYou')}</span>}
            {u.isAdmin && <span className="t-label t-label--accent">{t('settings.usersAdmin')}</span>}
            <button
              className="t-btn t-btn--sm"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(u)}
            >
              {u.isAdmin ? t('settings.usersRemoveAdmin') : t('settings.usersMakeAdmin')}
            </button>
            <button
              className="t-btn t-btn--sm t-btn--danger"
              disabled={u.id === meId || del.isPending}
              onClick={() => {
                if (confirm(t('settings.usersConfirmDelete', { email: u.email }))) del.mutate(u.id)
              }}
            >
              {t('servers.delete')}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <label className="text-xs text-t-muted">
          {t('login.email')}
          <input
            className="t-input mt-1 font-mono"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="text-xs text-t-muted">
          {t('login.password')}
          <input
            className="t-input mt-1 font-mono"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="t-btn self-end" type="submit" disabled={create.isPending}>
          {t('settings.usersCreate')}
        </button>
      </form>
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function PushSection() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<'ok' | 'denied' | 'unsupported' | ''>('')
  useEffect(() => {
    pushSubscription().then((s) => setEnabled(!!s))
    if (!pushSupported()) setState('unsupported')
  }, [])

  const toggle = async (on: boolean) => {
    if (on) {
      const r = await subscribePush()
      setState(r)
      setEnabled(r === 'ok')
    } else {
      await unsubscribePush()
      setEnabled(false)
      setState('')
    }
  }

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.notifications')}>
      <span className="t-label t-label--accent">{t('settings.notifications')}</span>
      <label className="mt-3 flex items-center gap-2 text-sm text-t-secondary">
        <input
          type="checkbox"
          checked={enabled}
          disabled={state === 'unsupported'}
          onChange={(e) => toggle(e.target.checked)}
        />
        {t('settings.pushEnable')}
      </label>
      <p className="mt-2 text-xs text-t-muted">{t('settings.pushHint')}</p>
      {state === 'denied' && (
        <p className="mt-1 text-xs text-err" role="alert">
          {t('settings.pushDenied')}
        </p>
      )}
      {state === 'unsupported' && <p className="mt-1 text-xs text-t-muted">{t('settings.pushUnsupported')}</p>}
    </section>
  )
}

function LookSection({
  locales,
  language,
  onLanguage,
}: {
  locales: typeof LOCALES
  language: string
  onLanguage: (l: string) => void
}) {
  const { t } = useTranslation()
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark')
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? 'violet')
  const [motion, setMotion] = useState(document.documentElement.dataset.motion !== 'off')

  const applyLook = (th: string, a: string, m: boolean) => {
    const root = document.documentElement
    root.dataset.theme = th
    root.dataset.accent = a
    if (m) delete root.dataset.motion
    else root.dataset.motion = 'off'
    localStorage.setItem('weebsync.theme', th)
    localStorage.setItem('weebsync.accent', a)
    localStorage.setItem('weebsync.motion', m ? 'on' : 'off')
  }

  return (
    <section className="t-panel p-5" aria-label={t('settings.look')}>
      <span className="t-label t-label--accent">{t('settings.look')}</span>
      <div className="mt-3 grid grid-cols-1 gap-4">
        <div role="group" aria-label={t('settings.language')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.language')}</span>
          {locales.map((l) => (
            <button
              key={l.code}
              className={`t-btn t-btn--sm ${language.startsWith(l.code) ? 't-btn--primary' : ''}`}
              aria-pressed={language.startsWith(l.code)}
              onClick={() => onLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('settings.theme')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.theme')}</span>
          {(['dark', 'light'] as const).map((th) => (
            <button
              key={th}
              className={`t-btn t-btn--sm ${theme === th ? 't-btn--primary' : ''}`}
              aria-pressed={theme === th}
              onClick={() => {
                setTheme(th)
                applyLook(th, accent, motion)
              }}
            >
              {th}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('settings.accent')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.accent')}</span>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a}
                title={a}
                aria-pressed={accent === a}
                aria-label={t('settings.accentName', { name: a })}
                className={`h-6 w-6 border ${accent === a ? 'border-t-primary outline outline-2 outline-accent' : 'border-border-subtle'}`}
                style={{ backgroundColor: `var(--accent-blue)` }}
                data-accent={a}
                onClick={() => {
                  setAccent(a)
                  applyLook(theme, a, motion)
                }}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-t-secondary">
          <input
            type="checkbox"
            checked={motion}
            onChange={(e) => {
              setMotion(e.target.checked)
              applyLook(theme, accent, e.target.checked)
            }}
          />
          {t('settings.motion')}
        </label>
      </div>
    </section>
  )
}

// Plex show sections as checkboxes (empty selection = all show sections).
function PlexSections({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const { data: sections = [], error } = useQuery<{ key: string; title: string }[]>({
    queryKey: ['plex-sections'],
    queryFn: () => api.get('/api/plex/sections'),
    retry: false,
  })
  const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next].join(','))
  }
  if (error)
    return (
      <p className="text-xs text-err" role="alert">
        {(error as Error).message}
      </p>
    )
  return (
    <fieldset className="text-xs text-t-muted">
      <legend>{t('settings.plexSections')}</legend>
      <div className="mt-1 flex flex-wrap gap-3">
        {sections.map((s) => (
          <label key={s.key} className="flex items-center gap-1.5 text-t-secondary">
            <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggle(s.key)} />
            {s.title}
          </label>
        ))}
      </div>
      <p className="mt-1">{t('settings.plexSectionsHint')}</p>
    </fieldset>
  )
}
