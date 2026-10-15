import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Row, RowAction, Rows, SettingsField } from 'fluid-lycoris'
import { api, type SessionInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import { qrPath } from '../../components/PhoneHint'
import { registerCredential } from '../../webauthn'
import { useAuth } from '../../hooks'
import { SettingsPanel } from './ui'
import './security.css'

interface AuthConfig {
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  oidcName?: string
}

export default function Account() {
  const { t } = useTranslation()
  const { data: cfg } = useQuery<AuthConfig>({ queryKey: ['authConfig'], queryFn: () => api.get('/api/auth/config') })
  return (
    <>
      {cfg && cfg.authMode !== 'password' ? (
        <SettingsPanel title={t('account.loginTitle')}>
          <p className="sf-note">{t('account.oidcNote', { name: cfg.oidcName || 'OIDC' })}</p>
        </SettingsPanel>
      ) : (
        <>
          <PasswordSection />
          <PasskeySection />
          <TotpSection />
        </>
      )}
      <SessionsSection />
    </>
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
  const id = useId()
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
    <SettingsPanel title={t('account.passwordTitle')} desc={t('account.passwordHint')}>
      <form onSubmit={submit}>
        <SettingsField label={t('account.passwordCurrent')} htmlFor={id + 'c'}>
          <Input
            id={id + 'c'}
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </SettingsField>
        <div className="sf-2">
          <SettingsField label={t('account.passwordNew')} htmlFor={id + 'n'}>
            <Input
              id={id + 'n'}
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </SettingsField>
          <SettingsField label={t('account.passwordAgain')} htmlFor={id + 'a'}>
            <Input
              id={id + 'a'}
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </SettingsField>
        </div>
        <div className="sf-acts">
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {t('account.passwordChange')}
          </Button>
        </div>
        <p role="status" className="t-sf-h mt-2 text-ok empty:hidden">
          {done ? t('account.passwordChanged') : ''}
        </p>
        {error && (
          <p className="sf-issue mt-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </SettingsPanel>
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
  // a new way in is confirmed with the password, so a stolen session alone
  // cannot add one
  const [password, setPassword] = useState('')
  const nameId = useId()

  const add = (kind: 'passkey' | 'key') => async () => {
    const fallback = kind === 'passkey' ? 'Passkey' : 'Security Key'
    setBusy(true)
    setError('')
    try {
      await registerCredential(kind, name.trim() || fallback, password)
      setName('')
      setPassword('')
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
      await api.del(`/api/auth/webauthn/credentials/${c.id}`, { password })
      setPassword('')
      qc.invalidateQueries({ queryKey: ['webauthn'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsPanel title={t('account.passkeyTitle')} desc={t('account.passkeyHint')}>
      {creds && creds.length > 0 && (
        <Rows dense>
          {creds.map((c) => (
            <Row
              key={c.id}
              title={c.name}
              sub={c.passwordless ? t('account.passkeyKindPasskey') : t('account.passkeyKindKey')}
              trailing={
                <RowAction
                  className="text-err"
                  disabled={busy || (!oidcOnly && !password)}
                  title={oidcOnly || password ? undefined : t('account.removeNeedsPassword')}
                  onClick={remove(c)}
                >
                  {t('account.remove')}
                </RowAction>
              }
            />
          ))}
        </Rows>
      )}
      {!oidcOnly && (
        <div className="ws-inline">
          <SettingsField label={t('account.passkeyName')} htmlFor={nameId}>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('account.passkeyNameHint')}
            />
          </SettingsField>
          <SettingsField label={t('login.password')} htmlFor={nameId + 'p'}>
            <Input
              id={nameId + 'p'}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </SettingsField>
          <Button variant="primary" disabled={busy || !password} onClick={add('passkey')}>
            {t('account.passkeyAdd')}
          </Button>
          <Button disabled={busy || !password} onClick={add('key')}>
            {t('account.keyAdd')}
          </Button>
        </div>
      )}
      {oidcOnly && <p className="sf-note">{t('account.passkeyNeedsPassword')}</p>}
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
  )
}

type SetupData = { secret: string; otpauthUrl: string }

/** The otpauth URL as a QR code for the authenticator app to scan; the secret
 *  is spelled out beside it for typing in, so the picture is decorative. */
function TotpQr({ uri }: { uri: string }) {
  const qr = useMemo(() => qrPath(uri), [uri])
  return (
    <svg
      viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
      aria-hidden="true"
      className="rounded-md bg-white"
      width={180}
      height={180}
      shapeRendering="crispEdges"
    >
      <path d={qr.d} fill="#000" />
    </svg>
  )
}

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
  const id = useId()
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

  const start = () =>
    run(async () => {
      setSetup(await api.post<SetupData>('/api/auth/totp/setup', { password }))
      setPassword('')
    })
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
    <SettingsPanel
      title={t('account.totpTitle')}
      badge={!recovery && data?.enabled ? <Badge tone="ok">{t('account.totpOn')}</Badge> : undefined}
      desc={t('account.totpHint')}
    >
      {recovery && (
        <div className="ws-codes">
          <p className="sf-note mt-0 font-medium text-warn">{t('account.recoveryTitle')}</p>
          <p className="t-sf-h">{t('account.recoveryHint')}</p>
          <ul ref={codesRef}>
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="sf-acts">
            <Button size="sm" onClick={() => copyCodes(recovery)}>
              {t('account.copy')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setRecovery(null)
                setCopied('')
              }}
            >
              {t('remote.close')}
            </Button>
          </div>
          <p role="status" className={`t-sf-h mt-2 empty:hidden ${copied === 'ok' ? 'text-ok' : 'text-warn'}`}>
            {copied === 'ok' ? t('account.copied') : copied === 'select' ? t('account.copySelect') : ''}
          </p>
        </div>
      )}

      {!recovery && data?.enabled && (
        <div className="ws-inline">
          {!oidcOnly && (
            <SettingsField label={t('login.password')} htmlFor={id + 'p'}>
              <Input
                id={id + 'p'}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </SettingsField>
          )}
          <Button variant="danger" disabled={busy || (!oidcOnly && !password)} onClick={disable}>
            {t('account.totpDisable')}
          </Button>
        </div>
      )}

      {!recovery && !data?.enabled && !setup && oidcOnly && (
        <p className="sf-note">{t('account.passkeyNeedsPassword')}</p>
      )}
      {!recovery && !data?.enabled && !setup && !oidcOnly && (
        <div className="ws-inline">
          <SettingsField label={t('login.password')} htmlFor={id + 'sp'}>
            <Input
              id={id + 'sp'}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </SettingsField>
          <Button variant="primary" disabled={busy || !password} onClick={start}>
            {t('account.totpEnable')}
          </Button>
        </div>
      )}

      {!recovery && setup && (
        <div className="mt-3">
          <TotpQr uri={setup.otpauthUrl} />
          <p className="sf-note">
            {t('account.totpManual')} <span className="font-mono break-all">{setup.secret}</span>
          </p>
          <SettingsField label={t('account.totpEnterCode')} htmlFor={id + 'c'}>
            <Input
              id={id + 'c'}
              className="sf-num font-mono tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </SettingsField>
          <div className="sf-acts">
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
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
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
    <SettingsPanel title={t('account.sessionsTitle')} desc={t('account.sessionsHint')}>
      {sessions && (
        <Rows>
          {sessions.map((x) => (
            <Row
              key={x.id}
              title={
                <span className="ws-user-t" title={x.userAgent}>
                  <span className="min-w-0 truncate">{browserOf(x.userAgent) || t('account.sessionsUnknown')}</span>
                  {x.current && <Badge>{t('account.sessionsThis')}</Badge>}
                </span>
              }
              sub={
                (x.createdAt ? t('account.sessionsSince', { when: when(x.createdAt) }) : t('account.sessionsOld')) +
                (x.oidc ? ` · ${t('account.sessionsSso')}` : '')
              }
              trailing={
                x.current ? undefined : (
                  <RowAction disabled={busy} onClick={() => void run(() => api.del(`/api/auth/sessions/${x.id}`))}>
                    {t('account.sessionsEnd')}
                  </RowAction>
                )
              }
            />
          ))}
        </Rows>
      )}
      {others.length > 1 && (
        <div className="sf-acts">
          <Button size="sm" disabled={busy} onClick={endOthers}>
            {t('account.sessionsEndOthers')}
          </Button>
        </div>
      )}
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
  )
}
