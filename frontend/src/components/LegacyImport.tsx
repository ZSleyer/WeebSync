import { useState, type FormEvent } from 'react'
import { AlertTriangle, Check, FileJson, Upload } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ServerInfo } from '../api'
import PathInput from './PathInput'

// One-shot migration from BastianGanze/weebsync, the separate Node project this
// one is a reimplementation of - NOT an older release of this app, so every
// text names the upstream project and links it. The user picks its config.json,
// the server converts it into a preview, and only the reviewed plan is written.
// That project spoke plain FTP only, so the server suggestion starts at SFTP
// and says why.
export const UPSTREAM_URL = 'https://github.com/BastianGanze/weebsync'

export interface LegacyWatchPlan {
  id: string
  remotePath: string
  localPath: string
  mode: string
  template: string
  titleOverride: string
  pattern: string
  replacement: string
  fromEpisode: number
  offset: number
  warnings?: string[]
  error?: string
}

export interface LegacyPlan {
  server: {
    name: string
    protocol: string
    host: string
    port: number
    username: string
    oldPort: number
    hasPassword: boolean
  }
  watches: LegacyWatchPlan[]
  intervalMin: number
  warnings?: string[]
  dropped?: string[]
}

export default function LegacyImport({ onDone }: { onDone?: (serverId: number) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  // the raw parsed config stays around: changing the local root re-runs the
  // conversion server-side instead of patching paths in the browser
  const [cfg, setCfg] = useState<unknown>(null)
  const [plan, setPlan] = useState<LegacyPlan | null>(null)
  const [localRoot, setLocalRoot] = useState('')
  const [serverId, setServerId] = useState(0) // 0 = create a new one
  const [password, setPassword] = useState('')
  const [skipped, setSkipped] = useState<Record<string, boolean>>({})
  const [fromEp, setFromEp] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)

  const preview = async (config: unknown, root: string) => {
    setBusy(true)
    setError('')
    try {
      const p = await api.post<LegacyPlan>('/api/import/legacy', { config, dryRun: true, localRoot: root })
      setPlan(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async (file: File) => {
    setResult(null)
    try {
      const config = JSON.parse(await file.text())
      setCfg(config)
      // the old file stores the password in clear text; prefill it from the
      // parsed copy in the browser - the API never echoes secrets back
      setPassword((config as { server?: { password?: string } })?.server?.password ?? '')
      await preview(config, localRoot)
    } catch {
      setError(t('legacy.errParse'))
    }
  }

  const commit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!plan) return
    const fd = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const res = await api.post<{ serverId: number; imported: number; skipped: number; errors: string[] }>(
        '/api/import/legacy',
        {
          serverId,
          server:
            serverId === 0
              ? {
                  name: String(fd.get('name') ?? ''),
                  protocol: String(fd.get('protocol') ?? 'sftp'),
                  host: String(fd.get('host') ?? ''),
                  port: Number(fd.get('port')) || 0,
                  username: String(fd.get('username') ?? ''),
                  password,
                  rootPath: String(fd.get('rootPath') ?? '/'),
                  maxConnections: 3,
                }
              : undefined,
          intervalMin: plan.intervalMin,
          watches: plan.watches
            .filter((w) => !skipped[w.id] && !w.error)
            .map((w) => ({ ...w, fromEpisode: fromEp[w.id] ?? w.fromEpisode })),
        },
      )
      setResult(res)
      qc.invalidateQueries({ queryKey: ['servers'] })
      qc.invalidateQueries({ queryKey: ['watches'] })
      onDone?.(res.serverId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const errorBox = error && (
    <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
      {error}
    </p>
  )

  if (result) {
    return (
      <div className="t-panel p-5">
        <p className="mb-2 flex items-center gap-2 text-sm text-ok" role="status">
          <Check aria-hidden size="1em" />
          {t('legacy.doneCount', { imported: result.imported, skipped: result.skipped })}
        </p>
        {result.errors.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-warn">
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  if (!plan) {
    return (
      <div className="t-panel p-5">
        <p className="mb-1 text-sm text-t-secondary">{t('legacy.intro')}</p>
        <p className="mb-4 text-xs text-t-muted">
          {t('legacy.upstreamNote')}{' '}
          <a className="underline hover:text-accent" href={UPSTREAM_URL} target="_blank" rel="noreferrer noopener">
            {UPSTREAM_URL.replace('https://', '')}
          </a>
        </p>
        {errorBox}
        {/* the real input is sr-only, so mirror its focus ring onto the label */}
        <label className="t-btn t-btn--primary t-cut inline-flex cursor-pointer items-center focus-within:outline focus-within:outline-1 focus-within:outline-offset-2 focus-within:outline-accent">
          <Upload aria-hidden size="1em" className="mr-2" />
          {t('legacy.pickFile')}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && pickFile(e.target.files[0])}
          />
        </label>
        <p className="mt-2 text-xs text-t-muted">{t('legacy.pickFileHint')}</p>
      </div>
    )
  }

  return (
    <form className="space-y-5" onSubmit={commit}>
      {/* sits directly on the hatched wizard background, so it needs an opaque
          fill of its own - a 5% tint would let the pattern show through */}
      <div className="border border-warn/40 bg-bg-card px-4 py-3" role="note">
        <p className="flex items-start gap-2 text-sm text-warn">
          <AlertTriangle aria-hidden size="1em" className="mt-0.5 shrink-0" />
          <span>{t('legacy.warnFtp', { port: plan.server.oldPort || 21 })}</span>
        </p>
      </div>

      <section className="t-panel space-y-3 p-5" aria-label={t('legacy.serverSection')}>
        <span className="t-label t-label--accent">{t('legacy.serverSection')}</span>
        {servers.length > 0 && (
          <label className="t-field block text-xs text-t-muted">
            {t('legacy.targetServer')}
            <span className="t-select-wrap block">
              <select className="t-select" value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
                <option value={0}>{t('legacy.newServer')}</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.protocol})
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}
        {serverId === 0 && (
          <div className="grid grid-cols-2 gap-3">
            <label className="t-field col-span-2 text-xs text-t-muted">
              {t('servers.name')}
              <input name="name" className="t-input" required defaultValue={plan.server.name} />
            </label>
            <label className="t-field text-xs text-t-muted">
              {t('servers.protocol')}
              <span className="t-select-wrap block">
                <select name="protocol" className="t-select" defaultValue="sftp">
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
                defaultValue={plan.server.port}
              />
            </label>
            <label className="t-field col-span-2 text-xs text-t-muted">
              {t('servers.host')}
              <input name="host" className="t-input font-mono" required defaultValue={plan.server.host} />
            </label>
            <label className="t-field text-xs text-t-muted">
              {t('servers.user')}
              <input name="username" className="t-input font-mono" required defaultValue={plan.server.username} />
            </label>
            <label className="t-field text-xs text-t-muted">
              {t('servers.password')}
              <input
                name="password"
                className="t-input"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="t-field col-span-2 text-xs text-t-muted">
              {t('servers.rootPath')}
              <input name="rootPath" className="t-input font-mono" defaultValue="/" />
            </label>
            <p className="col-span-2 text-xs text-t-muted">
              {plan.server.hasPassword ? t('legacy.passwordCarried') : t('legacy.passwordMissing')}
            </p>
          </div>
        )}
      </section>

      <section className="t-panel space-y-3 p-5" aria-label={t('legacy.targetSection')}>
        <span className="t-label t-label--accent">{t('legacy.targetSection')}</span>
        <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor="legacy-root">
          {t('legacy.localRoot')}
        </label>
        <div className="flex items-stretch gap-2">
          <PathInput
            id="legacy-root"
            value={localRoot}
            onChange={setLocalRoot}
            onCommit={(v) => {
              setLocalRoot(v)
              preview(cfg, v)
            }}
            fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p.replace(/^\/+/, ''))}`}
            queryKey={['local']}
            ariaLabel={t('legacy.localRoot')}
          />
          <button type="button" className="t-btn shrink-0" disabled={busy} onClick={() => preview(cfg, localRoot)}>
            {t('legacy.applyRoot')}
          </button>
        </div>
        <p className="text-xs text-t-muted">{t('legacy.localRootHint')}</p>
        <p className="text-xs text-t-muted">{t('legacy.intervalInfo', { min: plan.intervalMin })}</p>
        {(plan.dropped?.length ?? 0) > 0 && (
          <p className="text-xs text-t-muted">{t('legacy.dropped', { keys: plan.dropped?.join(', ') })}</p>
        )}
      </section>

      <section className="t-panel space-y-3 p-5" aria-label={t('legacy.watchSection')}>
        <span className="t-label t-label--accent">{t('legacy.watchSection')}</span>
        <p className="text-xs text-t-muted">{t('legacy.filterInfo')}</p>
        <ul className="divide-y divide-border-subtle border border-border-subtle">
          {plan.watches.map((w) => (
            <li key={w.id} className="p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!skipped[w.id] && !w.error}
                  disabled={!!w.error}
                  onChange={(e) => setSkipped((s) => ({ ...s, [w.id]: !e.target.checked }))}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-display">
                    <FileJson aria-hidden size="1em" className="shrink-0 text-t-muted" />
                    {w.id || t('legacy.unnamed')}
                  </span>
                  <span className="mt-1 block truncate font-mono text-[11px] text-t-muted">
                    {w.remotePath} → {w.localPath || '?'}
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-t-secondary">
                    {w.mode === 'regex'
                      ? `${w.pattern} → ${w.replacement}`
                      : w.template || t('legacy.noRename')}
                  </span>
                  {w.error && (
                    <span className="mt-1 block text-[11px] text-err">{t(`legacy.${w.error}`)}</span>
                  )}
                  {w.warnings?.map((g) => (
                    <span key={g} className="mt-1 block text-[11px] text-warn">
                      {t(`legacy.${g}`)}
                    </span>
                  ))}
                </span>
              </label>
              {/* only a positive offset means absolute numbering (episode 1156
                  of an endless series); a negative one just shifts a part */}
              {w.offset > 0 && (
                <label className="t-field mt-2 block pl-6 text-[11px] text-t-muted">
                  {t('legacy.fromEpisode', { offset: w.offset })}
                  <input
                    type="number"
                    min={0}
                    className="t-input w-24 font-mono"
                    value={fromEp[w.id] ?? w.fromEpisode}
                    onChange={(e) => setFromEp((f) => ({ ...f, [w.id]: Number(e.target.value) || 0 }))}
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>

      {errorBox}
      <div className="flex justify-end gap-2">
        <button type="button" className="t-btn" onClick={() => setPlan(null)} disabled={busy}>
          {t('legacy.restart')}
        </button>
        <button className="t-btn t-btn--primary t-cut" disabled={busy}>
          {t('legacy.commit')}
        </button>
      </div>
    </form>
  )
}
