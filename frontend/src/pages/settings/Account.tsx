import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Panel } from 'fluid-lycoris'
import { api, type SessionInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import { registerCredential } from '../../webauthn'
import { useAuth } from '../../hooks'

interface AuthConfig {
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
}

export default function Account() {
  const { t } = useTranslation()
  const { data: cfg } = useQuery<AuthConfig>({ queryKey: ['authConfig'], queryFn: () => api.get('/api/auth/config') })
  return (
    <section className="max-w-xl" aria-label={t('settings.nav.account')}>
      {cfg && cfg.authMode !== 'password' ? (
        <div className="space-y-4">
          <Panel className="p-5 text-sm text-t-muted">{t('account.oidcOnly')}</Panel>
          <SessionsSection />
        </div>
      ) : (
        <div className="space-y-4">
          <PasswordSection />
          <PasskeySection />
          <TotpSection />
          <SessionsSection />
        </div>
      )}
    </section>
  )
}

// Changing the password ends the account's other sessions; this one stays.
// An account that signs in through OIDC has none, so it sees nothing here.
function PasswordSection() {
  const { t } = useTranslation()
  const { data: me } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!me?.hasPassword) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setDone(false)
    if (next !== again) return setError(t('account.passwordMismatch'))
    setBusy(true)
    setError('')
    try {
      await api.put('/api/auth/password', { current, new: next })
      setCurrent('')
      setNext('')
      setAgain('')
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel as="form" className="p-5" aria-label={t('account.passwordTitle')} onSubmit={submit}>
      <Badge tone="accent">{t('account.passwordTitle')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('account.passwordHint')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1">
          <span className="t-label">{t('account.passwordCurrent')}</span>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="t-label">{t('account.passwordNew')}</span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="t-label">{t('account.passwordAgain')}</span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
      </div>
      <Button type="submit" size="sm" variant="primary" className="mt-3" disabled={busy}>
        {t('account.passwordChange')}
      </Button>
      <p role="status" className="mt-3 text-sm text-ok empty:hidden">
        {done ? t('account.passwordChanged') : ''}
      </p>
      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}

interface Passkey {
  id: number
  name: string
  passwordless: boolean
  createdAt: string
  lastUsed: string
}

function PasskeySection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: creds } = useQuery<Passkey[]>({
    queryKey: ['webauthn'],
    queryFn: () => api.get('/api/auth/webauthn/credentials'),
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // an OIDC account has no password a passkey could stand in for (the server
  // refuses one), and no password login a security key could be the second
  // factor of: its provider does both
  const { data: me } = useAuth()
  const oidcOnly = me?.hasPassword === false
  // the device's name is typed beside the buttons, not asked in a dialog
  // after the click; empty, it falls back to the kind
  const [name, setName] = useState('')

  const add = (kind: 'passkey' | 'key') => async () => {
    const fallback = kind === 'passkey' ? 'Passkey' : 'Security Key'
    setBusy(true)
    setError('')
    try {
      await registerCredential(kind, name.trim() || fallback)
      setName('')
      qc.invalidateQueries({ queryKey: ['webauthn'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }
  // a passkey is a way in: removing one asks first, and says so when it is
  // the last one. A security key only ever confirmed a password sign-in, so
  // it gets its own words
  const remove = (c: Passkey) => async () => {
    const last = (creds ?? []).filter((x) => x.passwordless).length === 1 && c.passwordless
    const ok = await confirm({
      title: t('account.removeTitle', { name: c.name }),
      message: !c.passwordless ? t('account.removeKeyHint') : last ? t('account.removeLast') : t('account.removeHint'),
      confirmLabel: t('account.remove'),
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.del(`/api/auth/webauthn/credentials/${c.id}`)
      qc.invalidateQueries({ queryKey: ['webauthn'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="p-5" aria-label={t('account.passkeyTitle')}>
      <Badge tone="accent">{t('account.passkeyTitle')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('account.passkeyHint')}</p>
      {creds && creds.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle/50">
          {creds.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-t-secondary">{c.name}</span>
              <Badge>{c.passwordless ? t('account.passkeyKindPasskey') : t('account.passkeyKindKey')}</Badge>
              <Button size="sm" variant="danger" disabled={busy} onClick={remove(c)}>
                {t('account.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!oidcOnly && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 basis-48 gap-1">
            <span className="t-label">{t('account.passkeyName')}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('account.passkeyNameHint')} />
          </label>
          <Button size="sm" variant="primary" disabled={busy} onClick={add('passkey')}>
            {t('account.passkeyAdd')}
          </Button>
          <Button size="sm" disabled={busy} onClick={add('key')}>
            {t('account.keyAdd')}
          </Button>
        </div>
      )}
      {oidcOnly && <p className="mt-2 text-xs text-t-muted">{t('account.passkeyNeedsPassword')}</p>}
      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}

type SetupData = { secret: string; otpauthUrl: string; qr?: string }

function TotpSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<{ enabled: boolean }>({ queryKey: ['totp'], queryFn: () => api.get('/api/auth/totp') })
  // only a password login asks for the code: an OIDC account gets nothing from
  // it, so it is not offered, and one already on goes off without a password
  const { data: me } = useAuth()
  const oidcOnly = me?.hasPassword === false
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // the copy button says what it did; without a clipboard (plain http, an
  // old engine) or when the write is refused, the codes are selected so the
  // user copies them by hand
  const [copied, setCopied] = useState<'' | 'ok' | 'select'>('')
  const codesRef = useRef<HTMLUListElement>(null)
  const copyCodes = async (codes: string[]) => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(codes.join('\n'))
      setCopied('ok')
    } catch {
      if (codesRef.current) window.getSelection()?.selectAllChildren(codesRef.current)
      setCopied('select')
    }
  }

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
    <Panel className="p-5" aria-label={t('account.totpTitle')}>
      <Badge tone="accent">{t('account.totpTitle')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('account.totpHint')}</p>

      {recovery && (
        <div className="mt-4 rounded-lg border border-warn/40 bg-warn/5 p-4">
          <p className="mb-2 text-sm text-warn">{t('account.recoveryTitle')}</p>
          <p className="mb-3 text-xs text-t-muted">{t('account.recoveryHint')}</p>
          <ul ref={codesRef} className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button size="sm" className="mt-3" onClick={() => copyCodes(recovery)}>
            {t('account.copy')}
          </Button>
          <Button
            size="sm"
            className="mt-3 ml-2"
            onClick={() => {
              setRecovery(null)
              setCopied('')
            }}
          >
            {t('remote.close')}
          </Button>
          <p role="status" className={`mt-2 text-xs empty:hidden ${copied === 'ok' ? 'text-ok' : 'text-warn'}`}>
            {copied === 'ok' ? t('account.copied') : copied === 'select' ? t('account.copySelect') : ''}
          </p>
        </div>
      )}

      {!recovery && data?.enabled && (
        <div className="mt-4">
          <Badge tone="ok">{t('account.totpOn')}</Badge>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            {!oidcOnly && (
              <label className="text-xs text-t-muted">
                {t('login.password')}
                <Input
                  className="mt-1"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            <Button size="sm" variant="danger" disabled={busy || (!oidcOnly && !password)} onClick={disable}>
              {t('account.totpDisable')}
            </Button>
          </div>
        </div>
      )}

      {!recovery && !data?.enabled && !setup && oidcOnly && (
        <p className="mt-2 text-xs text-t-muted">{t('account.passkeyNeedsPassword')}</p>
      )}
      {!recovery && !data?.enabled && !setup && !oidcOnly && (
        <Button size="sm" variant="primary" className="mt-4" disabled={busy} onClick={start}>
          {t('account.totpEnable')}
        </Button>
      )}

      {!recovery && setup && (
        <div className="mt-4 space-y-3">
          {setup.qr && <img src={setup.qr} alt="" className="border border-border-subtle" width={180} height={180} />}
          <p className="text-xs text-t-muted">
            {t('account.totpManual')} <span className="font-mono text-t-secondary">{setup.secret}</span>
          </p>
          <label className="block text-xs text-t-muted">
            {t('account.totpEnterCode')}
            <Input
              className="mt-1 font-mono tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={busy || !code} onClick={confirm}>
              {t('account.totpConfirm')}
            </Button>
            {/* a way back out: the unconfirmed secret stays inert on the
                server and the next start replaces it */}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setSetup(null)
                setCode('')
                setError('')
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}

// "Firefox on Linux" from a user agent string: enough to tell sessions apart,
// not a device database. The raw string stays in the row's title.
export function browserOf(ua: string): string {
  if (!ua) return ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrom(e|ium)\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40)
}

// Where the account is signed in: every browser with when it began, this one
// marked. Another one can be ended on its own, or all others at once - the
// answer to a session the user does not recognize.
function SessionsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: sessions } = useQuery<SessionInfo[]>({
    queryKey: ['sessions'],
    queryFn: () => api.get('/api/auth/sessions'),
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }
  const others = (sessions ?? []).filter((x) => !x.current)
  const endOthers = async () => {
    const ok = await confirm({
      title: t('account.sessionsEndOthersTitle'),
      message: t('account.sessionsEndOthersHint', { count: others.length }),
      confirmLabel: t('account.sessionsEndOthers'),
      destructive: true,
    })
    if (ok) void run(() => api.del('/api/auth/sessions/others'))
  }
  const when = (iso: string) =>
    iso
      ? new Date(iso).toLocaleString([], {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
  return (
    <Panel className="p-5" aria-label={t('account.sessionsTitle')}>
      <Badge tone="accent">{t('account.sessionsTitle')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('account.sessionsHint')}</p>
      {sessions && (
        <ul className="mt-3 divide-y divide-border-subtle/50">
          {sessions.map((x) => (
            <li key={x.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1" title={x.userAgent}>
                <span className="block truncate text-t-secondary">
                  {browserOf(x.userAgent) || t('account.sessionsUnknown')}
                </span>
                <span className="block text-xs text-t-muted">
                  {x.createdAt ? t('account.sessionsSince', { when: when(x.createdAt) }) : t('account.sessionsOld')}
                  {x.oidc ? ` · ${t('account.sessionsSso')}` : ''}
                </span>
              </span>
              {x.current ? (
                <Badge tone="ok">{t('account.sessionsThis')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void run(() => api.del(`/api/auth/sessions/${x.id}`))}
                >
                  {t('account.sessionsEnd')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 1 && (
        <Button size="sm" className="mt-3" disabled={busy} onClick={endOthers}>
          {t('account.sessionsEndOthers')}
        </Button>
      )}
      {error && (
        <p className="mt-3 text-sm text-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}
