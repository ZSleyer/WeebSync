import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api'
import { useSettingsForm, EnvBadge } from '../pages/settings/useSettingsForm'
import LegacyImport from './LegacyImport'

// The setup steps that need a session: import, server, storage, metadata.
// Split out of Setup.tsx only so its settings query mounts after the account
// exists - the wizard frame, the step indicator and the step order live there.
export type RestStep = 'import' | 'server' | 'storage' | 'meta'

// 409 from /test = SSH host key unknown or changed; nothing is pinned until the
// user reviews the fingerprint (same contract as the servers page).
type KeyConflict = { code: string; newKey: string; newFingerprint: string; oldFingerprint?: string }

export default function SetupSteps({
  step,
  onGo,
  onFinish,
}: {
  step: RestStep
  onGo: (s: RestStep) => void
  onFinish: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { form, set, save, locked } = useSettingsForm()

  const [serverId, setServerId] = useState(0)
  const [srvErr, setSrvErr] = useState('')
  const [srvStatus, setSrvStatus] = useState('')
  const [keyConflict, setKeyConflict] = useState<KeyConflict | null>(null)
  const [busy, setBusy] = useState(false)
  // an import already created the server, so that step has nothing left to ask
  const [imported, setImported] = useState(false)

  const next = () => {
    if (step === 'import') return onGo(imported ? 'storage' : 'server')
    if (step === 'server') return onGo('storage')
    if (step === 'storage') return onGo('meta')
    finish()
  }

  // one save at the end covers whatever the storage and metadata steps changed,
  // and marks the wizard done so it never reopens
  const finish = () => {
    if (!form) return onFinish()
    save.mutate({ ...form, onboardingDone: true }, { onSuccess: onFinish, onError: onFinish })
  }

  const testServer = async (id: number) => {
    setSrvStatus('…')
    setKeyConflict(null)
    try {
      await api.post(`/api/servers/${id}/test`)
      setSrvStatus(t('setup.serverOk'))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data as KeyConflict)?.newKey)
        setKeyConflict(e.data as KeyConflict)
      setSrvStatus(e instanceof Error ? e.message : t('app.error'))
    }
  }

  const createServer = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setBusy(true)
    setSrvErr('')
    try {
      const created = await api.post<{ id: number }>('/api/servers', {
        name: String(fd.get('name') ?? ''),
        protocol: String(fd.get('protocol') ?? 'sftp'),
        host: String(fd.get('host') ?? ''),
        port: Number(fd.get('port')) || 0,
        username: String(fd.get('username') ?? ''),
        password: String(fd.get('password') ?? ''),
        rootPath: String(fd.get('rootPath') ?? '/'),
        maxConnections: 3,
      })
      setServerId(created.id)
      qc.invalidateQueries({ queryKey: ['servers'] })
      await testServer(created.id)
    } catch (err) {
      setSrvErr(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const heading = (text: string) => <h2 className="mb-1 font-display text-sm font-bold">{text}</h2>

  const nav = (skipLabel = t('setup.skip')) => (
    <div className="mt-5 flex gap-2">
      <button type="button" className="t-btn flex-1" onClick={next}>
        {skipLabel}
      </button>
      <button type="button" className="t-btn t-btn--primary t-cut flex-1" disabled={save.isPending} onClick={finish}>
        {t('setup.finish')}
      </button>
    </div>
  )

  if (step === 'import')
    return (
      <section className="animate-fadeIn" aria-label={t('setup.step.import')}>
        <div className="t-panel mb-4 p-6">
          {heading(t('setup.importTitle'))}
          <p className="text-sm text-t-secondary">{t('setup.importHint')}</p>
        </div>
        {/* stay put after importing so its result summary stays readable */}
        <LegacyImport onDone={() => setImported(true)} />
        {nav(imported ? t('setup.continue') : t('setup.noOldConfig'))}
      </section>
    )

  if (step === 'server')
    return (
      <section className="t-panel animate-fadeIn p-6" aria-label={t('setup.step.server')}>
        {heading(t('setup.serverTitle'))}
        <p className="mb-4 text-sm text-t-secondary">{t('setup.serverHint')}</p>
        <form onSubmit={createServer} className="grid grid-cols-2 gap-3">
          <label className="t-field col-span-2 text-xs text-t-muted">
            {t('servers.name')}
            <input name="name" className="t-input" required disabled={!!serverId} />
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('servers.protocol')}
            <span className="t-select-wrap block">
              <select name="protocol" className="t-select" defaultValue="sftp" disabled={!!serverId}>
                <option value="sftp">SFTP (SSH)</option>
                <option value="ftps">FTPS (TLS)</option>
                <option value="ftp">FTP</option>
              </select>
            </span>
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('servers.port')}
            <input
              name="port"
              className="t-input font-mono"
              type="number"
              min={1}
              max={65535}
              placeholder="22 / 21"
              disabled={!!serverId}
            />
          </label>
          <label className="t-field col-span-2 text-xs text-t-muted">
            {t('servers.host')}
            <input name="host" className="t-input font-mono" required disabled={!!serverId} />
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('servers.user')}
            <input name="username" className="t-input font-mono" required disabled={!!serverId} />
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('servers.password')}
            <input
              name="password"
              className="t-input"
              type="password"
              required
              autoComplete="new-password"
              disabled={!!serverId}
            />
          </label>
          <label className="t-field col-span-2 text-xs text-t-muted">
            {t('servers.rootPath')}
            <input name="rootPath" className="t-input font-mono" defaultValue="/" disabled={!!serverId} />
          </label>
          {!serverId && (
            <button className="t-btn t-btn--primary t-cut col-span-2" disabled={busy}>
              {t('setup.serverCreate')}
            </button>
          )}
        </form>
        {srvErr && (
          <p className="mt-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {srvErr}
          </p>
        )}
        {srvStatus && (
          <p className="mt-3 text-xs text-t-secondary" role="status">
            {srvStatus}
          </p>
        )}
        {keyConflict && (
          <div className="mt-3 border border-warn/40 bg-warn/5 p-3 text-xs">
            <p className="mb-2 text-warn">
              {t(keyConflict.code === 'host_key_mismatch' ? 'servers.hostKeyChanged' : 'servers.hostKeyUnknown')}
            </p>
            <p className="mb-2 break-all font-mono">{keyConflict.newFingerprint}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="t-btn t-btn--sm"
                onClick={async () => {
                  await api.post(`/api/servers/${serverId}/trust-hostkey`, { key: keyConflict.newKey })
                  await testServer(serverId)
                }}
              >
                {t('servers.hostKeyAccept')}
              </button>
              <button type="button" className="t-btn t-btn--sm" onClick={() => setKeyConflict(null)}>
                {t('servers.hostKeyReject')}
              </button>
            </div>
          </div>
        )}
        {nav(serverId ? t('setup.continue') : t('setup.skip'))}
      </section>
    )

  if (step === 'storage' && form)
    return (
      <section className="t-panel animate-fadeIn p-6" aria-label={t('setup.step.storage')}>
        {heading(t('setup.storageTitle'))}
        <p className="mb-4 text-sm text-t-secondary">{t('setup.storageHint')}</p>
        <span className="t-label">{t('setup.roots')}</span>
        <ul className="mb-2 mt-1 border border-border-subtle p-2 font-mono text-xs text-t-secondary">
          {form.downloadRoots?.map((r) => <li key={r}>{r}</li>)}
        </ul>
        {!form.downloadsEnvSet && (
          <p className="mb-4 border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn" role="note">
            {t('setup.rootsWarn')}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="t-field text-xs text-t-muted">
            {t('settings.watchInterval')}
            <input
              type="number"
              min={5}
              max={1440}
              className="t-input font-mono"
              value={form.watchIntervalMin}
              onChange={(e) => set('watchIntervalMin', Number(e.target.value) || 30)}
            />
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('settings.maxConcurrent')}
            <input
              type="number"
              min={1}
              max={20}
              className="t-input font-mono"
              value={form.maxConcurrent}
              onChange={(e) => set('maxConcurrent', Number(e.target.value) || 3)}
            />
          </label>
          <label className="t-field text-xs text-t-muted">
            {t('settings.globalLimit')}
            <input
              type="number"
              min={0}
              className="t-input font-mono"
              value={Math.round(form.globalRateLimit / 1024)}
              onChange={(e) => set('globalRateLimit', Number(e.target.value) * 1024)}
            />
          </label>
        </div>
        {nav()}
      </section>
    )

  if (step === 'meta' && form)
    return (
      <section className="t-panel animate-fadeIn p-6" aria-label={t('setup.step.meta')}>
        {heading(t('setup.metaTitle'))}
        <p className="mb-4 text-sm text-t-secondary">{t('setup.metaHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['tmdbApiKey', 'settings.tmdbApiKey', 'password'],
              ['tvdbApiKey', 'settings.tvdbApiKey', 'password'],
              ['plexUrl', 'settings.plexUrl', 'text'],
              ['plexToken', 'settings.plexToken', 'password'],
              ['anilistClientId', 'settings.anilistClientId', 'text'],
              ['anilistClientSecret', 'settings.anilistClientSecret', 'password'],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="t-field text-xs text-t-muted">
              <span className="flex w-fit items-center">
                {t(label)}
                <EnvBadge show={locked(key)} />
              </span>
              <input
                type={type}
                className="t-input font-mono"
                autoComplete="off"
                disabled={locked(key)}
                value={form[key] ?? ''}
                onChange={(e) => set(key, e.target.value)}
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-t-muted">{t('setup.metaLater')}</p>
        {nav()}
      </section>
    )

  return null
}
