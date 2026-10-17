import { useState, type CSSProperties, type FormEvent, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck } from 'lucide-react'
import { Button, Input, Segmented } from 'fluid-lycoris'
import { api, fmtBytes, keyConflictOf, type DiskUsage, type KeyConflict, type SystemStatus } from '../api'
import HostKeyPrompt from './HostKeyPrompt'
import { useSettingsForm, EnvBadge } from '../pages/settings/useSettingsForm'
import LegacyImport from './LegacyImport'
import PlexServerSignIn from './PlexServerSignIn'
import JellyfinQuickConnect from './JellyfinQuickConnect'
import '../pages/settings/settings.css' // .sf-disc for the folded fallback

// The setup steps that need a session: import, server, storage, metadata.
// Split out of Setup.tsx only so its settings query mounts after the account
// exists - the wizard frame, the step indicator and the step order live there.
export type RestStep = 'import' | 'server' | 'storage' | 'meta'

/** What the steps after the account left behind, for the closing summary. */
export interface SetupSummary {
  server?: string
  imported: boolean
  roots: number
  meta: string[]
}

// 409 from /test = SSH host key unknown or changed; nothing is pinned until the
// user reviews the fingerprint (same contract as the servers page).

/** A step's heading: the wizard moves focus here on every step change. */
export function SetupHeading({ headingRef, children }: { headingRef: Ref<HTMLHeadingElement>; children: ReactNode }) {
  return (
    <h2 ref={headingRef} tabIndex={-1} className="ws-su-h">
      {children}
    </h2>
  )
}

/**
 * The wizard's one footer, sticking to the bottom edge: back at the left, then
 * skip on an optional step and the step's main action at the right.
 */
export function SetupFoot({
  onBack,
  onSkip,
  skipLabel,
  error,
  children,
}: {
  onBack?: () => void
  onSkip?: () => void
  skipLabel?: string
  error?: ReactNode
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="ws-su-foot">
      <div className="ws-su-foot-in">
        {error && (
          <p className="ws-login-err" role="alert">
            {error}
          </p>
        )}
        {onBack && <Button onClick={onBack}>{t('setup.back')}</Button>}
        <span className="ws-su-sp" />
        {onSkip && <Button onClick={onSkip}>{skipLabel ?? t('setup.skip')}</Button>}
        {children}
      </div>
    </div>
  )
}

type Protocol = 'sftp' | 'ftps'

// the disk a root lives on: the status lists each filesystem once, with the
// other library paths that share it
const diskOf = (disks: DiskUsage[] | undefined, root: string) =>
  disks?.find((d) => d.path === root || d.paths?.includes(root))

export default function SetupSteps({
  step,
  onGo,
  onFinish,
  headingRef,
}: {
  step: RestStep
  onGo: (s: RestStep) => void
  onFinish: (summary: SetupSummary) => void
  /** the wizard moves focus here on every step change */
  headingRef: Ref<HTMLHeadingElement>
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { form, set, save, locked } = useSettingsForm()
  // the free space next to each root; the endpoint is admin-gated and the
  // wizard's account is the admin, a refusal just leaves the meters out
  const { data: status } = useQuery<SystemStatus>({
    queryKey: ['status', 'setup'],
    queryFn: () => api.get('/api/status'),
    retry: false,
    enabled: step === 'storage',
  })

  const [serverId, setServerId] = useState(0)
  const [serverName, setServerName] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('sftp')
  const [srvErr, setSrvErr] = useState('')
  const [testing, setTesting] = useState(false)
  // the connection test passed: only then is the server settled and the form
  // locked; a failed test leaves it open to correct and test again
  const [srvOk, setSrvOk] = useState(false)
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
  // the account exists from step 01 on, so the way back ends at the import
  const back = () => {
    if (step === 'server') return onGo('import')
    if (step === 'storage') return onGo(imported ? 'import' : 'server')
    if (step === 'meta') return onGo('storage')
  }

  // one save at the end covers whatever the storage and metadata steps changed,
  // and marks the wizard done so it never reopens
  const finish = () => {
    const meta = (
      [
        ['anilistClientId', 'AniList'],
        ['tmdbApiKey', 'TMDB'],
        ['tvdbApiKey', 'TVDB'],
        ['plexUrl', 'Plex'],
        ['jellyfinUrl', 'Jellyfin'],
      ] as const
    ).flatMap(([k, name]) =>
      form?.[k] || (k === 'tmdbApiKey' && form?.tmdbApiKeySet) || (k === 'tvdbApiKey' && form?.tvdbApiKeySet)
        ? [name]
        : [],
    )
    const summary: SetupSummary = {
      server: srvOk ? serverName : undefined,
      imported,
      roots: form?.downloadRoots?.length ?? 0,
      meta,
    }
    if (!form) return onFinish(summary)
    // a refused save stays on this step with its reason (shown in the footer):
    // before, it reported "setup complete" with nothing stored
    save.mutate({ ...form, onboardingDone: true }, { onSuccess: () => onFinish(summary) })
  }

  const testServer = async (id: number) => {
    setTesting(true)
    setSrvErr('')
    setKeyConflict(null)
    try {
      await api.post(`/api/servers/${id}/test`)
      setSrvOk(true)
    } catch (e) {
      const kc = keyConflictOf(e)
      if (kc) setKeyConflict(kc)
      else setSrvErr(t('setup.serverTestFailed', { msg: e instanceof Error ? e.message : t('app.error') }))
    } finally {
      setTesting(false)
    }
  }

  const createServer = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setBusy(true)
    setSrvErr('')
    const body = {
      name: String(fd.get('name') ?? ''),
      protocol,
      host: String(fd.get('host') ?? ''),
      port: Number(fd.get('port')) || 0,
      username: String(fd.get('username') ?? ''),
      password: String(fd.get('password') ?? ''),
      rootPath: String(fd.get('rootPath') ?? '/'),
      maxConnections: 3,
    }
    try {
      // a second try corrects the server the first one created
      let id = serverId
      if (id) await api.put(`/api/servers/${id}`, body)
      else id = (await api.post<{ id: number }>('/api/servers', body)).id
      setServerId(id)
      setServerName(body.name)
      qc.invalidateQueries({ queryKey: ['servers'] })
      await testServer(id)
    } catch (err) {
      setSrvErr(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const saveError = save.error ? t('setup.finishFailed', { msg: save.error.message }) : undefined
  const nextButton = (
    <Button variant="primary" disabled={save.isPending} onClick={next}>
      {step === 'meta' ? t('setup.finish') : t('setup.continue')}
    </Button>
  )

  if (step === 'import')
    return (
      <section className="ws-su-step" aria-labelledby="su-h">
        <div className="ws-su-body ws-su-body--wide">
          <SetupHeading headingRef={headingRef}>
            <span id="su-h">{t('setup.importTitle')}</span>
          </SetupHeading>
          <p className="ws-quiet">{t('setup.importHint')}</p>
          {/* stay put after importing so its result summary stays readable */}
          <LegacyImport onDone={() => setImported(true)} />
        </div>
        <SetupFoot onSkip={imported ? undefined : next} error={saveError}>
          {imported && nextButton}
        </SetupFoot>
      </section>
    )

  if (step === 'server') {
    const pending = busy || testing
    return (
      <form className="ws-su-step" onSubmit={createServer} aria-labelledby="su-h">
        <div className="ws-su-body">
          <SetupHeading headingRef={headingRef}>
            <span id="su-h">{t('setup.serverTitle')}</span>
          </SetupHeading>
          <p className="ws-quiet">{t('setup.serverHint')}</p>
          <span className="ws-lbl" aria-hidden>
            {t('servers.protocol')}
          </span>
          <Segmented
            aria-label={t('servers.protocol')}
            size="md"
            className="w-full"
            value={protocol}
            onChange={(p) => !srvOk && setProtocol(p)}
            options={[
              { value: 'sftp', label: 'SFTP' },
              { value: 'ftps', label: 'FTPS' },
            ]}
          />
          <label htmlFor="su-name" className="ws-lbl">
            {t('servers.name')}
          </label>
          <Input id="su-name" name="name" required disabled={srvOk} />
          <div className="ws-su-hp">
            <div>
              <label htmlFor="su-host" className="ws-lbl">
                {t('servers.host')}
              </label>
              <Input id="su-host" name="host" className="font-mono" required disabled={srvOk} />
            </div>
            <div>
              <label htmlFor="su-port" className="ws-lbl">
                {t('servers.port')}
              </label>
              <Input
                id="su-port"
                name="port"
                className="font-mono"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={protocol === 'sftp' ? '22' : '21'}
                disabled={srvOk}
              />
            </div>
          </div>
          <div className="ws-su-2">
            <div>
              <label htmlFor="su-user" className="ws-lbl">
                {t('servers.user')}
              </label>
              <Input id="su-user" name="username" className="font-mono" required disabled={srvOk} />
            </div>
            <div>
              <label htmlFor="su-pass" className="ws-lbl">
                {t('servers.password')}
              </label>
              {/* on a retry an empty password keeps the one already stored */}
              <Input
                id="su-pass"
                name="password"
                type="password"
                required={!serverId}
                autoComplete="new-password"
                disabled={srvOk}
              />
            </div>
          </div>
          <label htmlFor="su-root" className="ws-lbl">
            {t('servers.rootPath')}
          </label>
          <Input id="su-root" name="rootPath" className="font-mono" defaultValue="/" disabled={srvOk} />
          {testing && (
            <p className="ws-quiet mt-3" role="status">
              {t('setup.serverTesting')}
            </p>
          )}
          {srvOk && (
            <p className="ws-su-ok" role="status">
              <CircleCheck aria-hidden size={18} />
              {t('setup.serverOk')}
            </p>
          )}
          {keyConflict && (
            <HostKeyPrompt
              className="mt-4"
              serverId={serverId}
              conflict={keyConflict}
              onAccepted={() => testServer(serverId)}
              onRejected={() => setKeyConflict(null)}
            />
          )}
        </div>
        <SetupFoot onBack={back} onSkip={srvOk ? undefined : next} error={srvErr || saveError}>
          {srvOk ? (
            nextButton
          ) : (
            <Button type="submit" variant="primary" disabled={pending}>
              {serverId ? t('setup.serverRetry') : t('setup.serverCreate')}
            </Button>
          )}
        </SetupFoot>
      </form>
    )
  }

  if (step === 'storage' && form)
    return (
      <section className="ws-su-step" aria-labelledby="su-h">
        <div className="ws-su-body">
          <SetupHeading headingRef={headingRef}>
            <span id="su-h">{t('setup.storageTitle')}</span>
          </SetupHeading>
          <p className="ws-quiet">{t('setup.storageHint')}</p>
          <p className="ws-lbl" id="su-roots">
            {t('setup.roots')}
          </p>
          <ul className="ws-su-disks" aria-labelledby="su-roots">
            {form.downloadRoots?.map((r) => {
              const d = diskOf(status?.disks, r)
              return (
                <li key={r}>
                  <span className="ws-su-path">{r}</span>
                  {d && d.totalBytes > 0 && (
                    <>
                      <span className="ws-quiet">{t('setup.free', { size: fmtBytes(d.freeBytes) })}</span>
                      <span
                        className="ws-su-meter"
                        role="meter"
                        aria-label={t('setup.used', { path: r })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round((d.usedBytes / d.totalBytes) * 100)}
                      >
                        <span style={{ '--f': d.usedBytes / d.totalBytes } as CSSProperties} />
                      </span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          {!form.downloadsEnvSet && (
            <p className="ws-su-warn" role="note">
              {t('setup.rootsWarn')}
            </p>
          )}
          <div className="ws-su-2">
            <div>
              <label htmlFor="su-interval" className="ws-lbl">
                {t('settings.watchInterval')}
              </label>
              <Input
                id="su-interval"
                inputMode="numeric"
                className="font-mono"
                value={form.watchIntervalMin || ''}
                onChange={(e) => set('watchIntervalMin', Math.trunc(Number(e.target.value.replace(/\D/g, ''))))}
              />
            </div>
            <div>
              <label htmlFor="su-parallel" className="ws-lbl">
                {t('settings.maxConcurrent')}
              </label>
              <Input
                id="su-parallel"
                inputMode="numeric"
                className="font-mono"
                value={form.maxConcurrent || ''}
                onChange={(e) => set('maxConcurrent', Math.trunc(Number(e.target.value.replace(/\D/g, ''))))}
              />
            </div>
          </div>
          <label htmlFor="su-limit" className="ws-lbl">
            {t('settings.globalLimit')}
          </label>
          <Input
            id="su-limit"
            inputMode="numeric"
            className="font-mono"
            value={Math.round(form.globalRateLimit / 1024)}
            onChange={(e) => set('globalRateLimit', Math.trunc(Number(e.target.value.replace(/\D/g, ''))) * 1024)}
          />
        </div>
        <SetupFoot onBack={back} error={saveError}>
          {nextButton}
        </SetupFoot>
      </section>
    )

  type MetaKey =
    | 'tmdbApiKey'
    | 'tvdbApiKey'
    | 'plexUrl'
    | 'plexToken'
    | 'jellyfinUrl'
    | 'jellyfinToken'
    | 'anilistClientId'
    | 'anilistClientSecret'
  const field = (key: MetaKey, label: string, type: 'text' | 'password') => (
    <div key={key}>
      <span className="ws-lbl-row">
        <label htmlFor={`su-${key}`} className="ws-lbl">
          {t(label)}
        </label>
        <EnvBadge show={locked(key)} />
      </span>
      <Input
        id={`su-${key}`}
        type={type}
        className="font-mono"
        autoComplete="off"
        disabled={locked(key)}
        value={form?.[key] ?? ''}
        onChange={(e) => set(key, e.target.value)}
      />
    </div>
  )
  if (step === 'meta' && form)
    return (
      <section className="ws-su-step" aria-labelledby="su-h">
        <div className="ws-su-body ws-su-body--wide">
          <SetupHeading headingRef={headingRef}>
            <span id="su-h">{t('setup.metaTitle')}</span>
          </SetupHeading>
          <p className="ws-quiet">{t('setup.metaHint')}</p>
          {/* the sign-ins come first; typing a URL and a token is the fallback
              and stays folded unless the environment already set one */}
          {!locked('plexUrl') && !locked('plexToken') && (
            <div className="mb-4">
              <span className="ws-lbl">Plex</span>
              <PlexServerSignIn
                connected={!!form.plexUrl && !!form.plexTokenSet}
                onConnected={(res) => set('plexUrl', res.url)}
              />
            </div>
          )}
          {/* Quick Connect asks the server for a code, so only its address is
              needed up front */}
          <div className="mb-4 space-y-2">
            <span className="ws-lbl">Jellyfin</span>
            {field('jellyfinUrl', 'settings.jellyfinUrl', 'text')}
            {!locked('jellyfinToken') && (
              <JellyfinQuickConnect
                server={form.jellyfinUrl}
                disabled={!form.jellyfinUrl}
                label={t('settings.jellyfinSignIn')}
              />
            )}
          </div>
          <details
            className="sf-disc mb-4"
            open={locked('plexUrl') || locked('plexToken') || locked('jellyfinToken') || undefined}
          >
            <summary>{t('setup.metaManual')}</summary>
            <div className="ws-su-2 mt-2">
              {field('plexUrl', 'settings.plexUrl', 'text')}
              {field('plexToken', 'settings.plexToken', 'password')}
              {field('jellyfinToken', 'settings.jellyfinToken', 'password')}
            </div>
          </details>
          <div className="ws-su-2">
            {field('tmdbApiKey', 'settings.tmdbApiKey', 'password')}
            {field('tvdbApiKey', 'settings.tvdbApiKey', 'password')}
            {field('anilistClientId', 'settings.anilistClientId', 'text')}
            {field('anilistClientSecret', 'settings.anilistClientSecret', 'password')}
          </div>
          <p className="ws-quiet mt-4">{t('setup.metaLater')}</p>
        </div>
        <SetupFoot onBack={back} error={saveError}>
          {nextButton}
        </SetupFoot>
      </section>
    )

  return null
}
