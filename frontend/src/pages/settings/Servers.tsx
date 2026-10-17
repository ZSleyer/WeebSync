import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, Server, ShieldAlert } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, Field, Input, RowAction, Segmented, Select, SettingsField } from 'fluid-lycoris'
import { api, keyConflictOf, type KeyConflict, type ServerInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import FtpsMigrateDialog from '../../components/FtpsMigrate'
import HostKeyPrompt from '../../components/HostKeyPrompt'
import { useAuth } from '../../hooks'
import { SettingsPanel } from './ui'
import { ScopeRules } from './Matching'
import { SERVER_ICONS, ServerIcon } from '../../components/serverIcon'
import {
  LOCAL_DEFAULT,
  localColor,
  serverColor,
  setLocalColor,
  SOURCE_COLORS,
  tint,
  type SourceColorName,
} from '../../components/sourceColor'

export default function Servers() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  // mount-to-open, like every other dialog in the app: the state IS the dialog
  const [editing, setEditing] = useState<ServerInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [migrating, setMigrating] = useState<ServerInfo | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})

  const openDialog = (s: ServerInfo | null) => {
    setEditing(s)
    setDialogOpen(true)
  }

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/servers/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })

  // 409 on /test = SSH host key unknown or changed; the test itself never
  // trusts anything - the user reviews old/new fingerprints and accepts or
  // rejects explicitly
  const [keyConflict, setKeyConflict] = useState<Record<number, KeyConflict | undefined>>({})
  // where the check ran: the review shows up there, on the card or in the key list
  const [checkedIn, setCheckedIn] = useState<Record<number, 'card' | 'keys'>>({})

  const test = async (id: number, where: 'card' | 'keys' = 'card') => {
    setCheckedIn((m) => ({ ...m, [id]: where }))
    setTestResult((r) => ({ ...r, [id]: '…' }))
    setKeyConflict((m) => ({ ...m, [id]: undefined }))
    try {
      await api.post(`/api/servers/${id}/test`)
      setTestResult((r) => ({ ...r, [id]: 'ok' }))
    } catch (e) {
      const kc = keyConflictOf(e)
      if (kc) setKeyConflict((m) => ({ ...m, [id]: kc }))
      else qc.invalidateQueries({ queryKey: ['servers'] })
      setTestResult((r) => ({ ...r, [id]: e instanceof Error ? e.message : t('app.error') }))
    }
  }

  // reject just dismisses the prompt; accept pins the key and tests again
  const rejectKey = (id: number) => {
    setKeyConflict((m) => ({ ...m, [id]: undefined }))
    setTestResult((r) => ({ ...r, [id]: t('servers.hostKeyRejected') }))
  }

  const status = (id: number) => {
    const r = testResult[id]
    if (!r) return null
    if (r === '…') return <Badge>{t('servers.testing')}</Badge>
    return r === 'ok' ? (
      <Badge tone="ok">{t('servers.connected')}</Badge>
    ) : (
      <Badge tone="err">{t('servers.failed')}</Badge>
    )
  }
  const sftp = servers.filter((s) => s.protocol === 'sftp')
  const ftp = servers.filter((s) => s.protocol === 'ftp')

  return (
    <>
      {/* plain FTP is gone: every such server is listed with the one action that fixes it */}
      {ftp.length > 0 && (
        <section className="srv-ftp" role="alert" aria-labelledby="srv-ftp-h">
          <h2 id="srv-ftp-h">
            <ShieldAlert aria-hidden size="1.1em" />
            {t('servers.ftpBannerTitle', { count: ftp.length })}
          </h2>
          <p>{t('servers.ftpBannerBody')}</p>
          <ul>
            {ftp.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.name}</strong> <span className="font-mono">{s.host}</span>
                </span>
                <Button size="sm" variant="primary" onClick={() => setMigrating(s)}>
                  {t('servers.migrate.act')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <SettingsPanel title={t('nav.servers')}>
        {servers.length === 0 && <p className="sf-note">{t('servers.none')}</p>}
        {servers.map((s) => (
          <article key={s.id} className="srv" aria-labelledby={`srv-${s.id}`}>
            <div className="srv-h">
              <span className="srv-ic" aria-hidden style={tint(serverColor(s.id, s.color))}>
                {s.icon ? <ServerIcon name={s.icon} size="1.25rem" /> : <Server size="1.25rem" />}
              </span>
              <div className="t">
                <strong id={`srv-${s.id}`}>{s.name}</strong>
                <span className="font-mono">
                  {s.protocol} · {s.username}@{s.host}:{s.port} · {s.rootPath}
                </span>
              </div>
              <span aria-live="polite">{status(s.id)}</span>
            </div>
            {/* plain FTP is gone and such a server cannot connect any more: the card
                says so, since a server set up long ago never opens the form again */}
            {s.protocol === 'ftp' && (
              <p className="sf-note text-warn" role="note">
                {t('servers.ftpDeprecated')}
              </p>
            )}
            <div className="sf-acts">
              {s.protocol === 'ftp' && (
                <Button size="sm" variant="primary" onClick={() => setMigrating(s)}>
                  {t('servers.migrate.act')}
                </Button>
              )}
              <Button size="sm" onClick={() => test(s.id)} disabled={testResult[s.id] === '…'}>
                {testResult[s.id] === '…' ? t('servers.testing') : t('servers.test')}
              </Button>
              <Button size="sm" onClick={() => openDialog(s)}>
                {t('servers.edit')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (await confirm({ message: t('servers.confirmDelete', { name: s.name }), destructive: true }))
                    del.mutate(s.id)
                }}
              >
                {t('servers.delete')}
              </Button>
              <span className="text-ctl-sm text-t-muted">{t('servers.maxConn', { n: s.maxConnections })}</span>
            </div>
            {testResult[s.id] && testResult[s.id] !== 'ok' && testResult[s.id] !== '…' && !keyConflict[s.id] && (
              <p className="sf-issue mt-2 break-all" role="alert">
                {testResult[s.id]}
              </p>
            )}
            {keyConflict[s.id] && checkedIn[s.id] !== 'keys' && (
              <HostKeyPrompt
                className="mt-2"
                serverId={s.id}
                conflict={keyConflict[s.id]!}
                onAccepted={() => {
                  qc.invalidateQueries({ queryKey: ['servers'] })
                  void test(s.id)
                }}
                onRejected={() => rejectKey(s.id)}
              />
            )}
          </article>
        ))}
        <div className="sf-acts">
          <Button variant="primary" onClick={() => openDialog(null)}>
            <Plus aria-hidden size="1em" />
            {t('servers.add')}
          </Button>
        </div>
      </SettingsPanel>

      {/* every SFTP server's pinned key in one place: a check shows a changed
          key as the old and the new fingerprint, to accept or reject */}
      {sftp.length > 0 && (
        <SettingsPanel title={t('servers.hostKeys')} desc={t('servers.hostKeysHint')}>
          <ul className="t-rows">
            {sftp.map((s) => (
              <li key={s.id} className="t-row">
                <div className="t-row-in">
                  <div className="t-row-t">
                    <strong>{s.name}</strong>
                    {s.hostKey ? (
                      <code className="block font-mono text-ctl-sm break-all text-t-muted">{s.hostKey}</code>
                    ) : (
                      <span className="text-warn">{t('servers.hostKeyNone')}</span>
                    )}
                  </div>
                  {checkedIn[s.id] === 'keys' && testResult[s.id] === 'ok' && (
                    <Badge tone="ok">{t('servers.hostKeySame')}</Badge>
                  )}
                  <RowAction onClick={() => test(s.id, 'keys')}>{t('servers.hostKeyCheck')}</RowAction>
                </div>
                {checkedIn[s.id] === 'keys' && keyConflict[s.id] && (
                  <HostKeyPrompt
                    className="mb-3"
                    serverId={s.id}
                    conflict={keyConflict[s.id]!}
                    onAccepted={() => {
                      qc.invalidateQueries({ queryKey: ['servers'] })
                      void test(s.id, 'keys')
                    }}
                    onRejected={() => rejectKey(s.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        </SettingsPanel>
      )}

      <SettingsPanel title={t('servers.local')}>
        <LocalColor />
      </SettingsPanel>

      {/* an admin finds the folder rules with the index and the matches */}
      {!user?.isAdmin && <ScopeRules />}
      {migrating && <FtpsMigrateDialog server={migrating} onClose={() => setMigrating(null)} />}
      {dialogOpen && <ServerDialog editing={editing} onClose={() => setDialogOpen(false)} />}
    </>
  )
}

function ServerDialog({ editing, onClose }: { editing: ServerInfo | null; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [protocol, setProtocol] = useState<ServerInfo['protocol']>(
    editing?.protocol === 'ftp' ? 'ftps' : (editing?.protocol ?? 'sftp'),
  )
  const [icon, setIcon] = useState(editing?.icon ?? '')
  const [color, setColor] = useState(editing?.color ?? '')
  // uncontrolled form: any input change marks it dirty for the close guard;
  // the icon and colour pickers are buttons, not inputs, so they mark it
  // themselves (a form change event never fires for them)
  const [dirty, setDirty] = useState(false)
  const pickIcon = (v: string) => {
    setIcon(v)
    setDirty(true)
  }
  const pickColor = (v: string) => {
    setColor(v)
    setDirty(true)
  }
  // a second Enter or click while the first save is in flight would create
  // the server twice; the ref closes the gap before the disabled re-render
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  // Dialog asks this before Escape or a backdrop click closes it
  const mayClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: t('common.unsavedTitle'),
        message: t('common.unsavedMsg'),
        confirmLabel: t('common.discard'),
        cancelLabel: t('common.keepEditing'),
        destructive: true,
      }))
    )
      return false
    setDirty(false)
    return true
  }
  const cancel = async () => {
    if (await mayClose()) onClose()
  }
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busyRef.current) return
    const fd = new FormData(e.currentTarget)
    const body = {
      name: fd.get('name'),
      protocol: fd.get('protocol'),
      host: fd.get('host'),
      port: Number(fd.get('port')) || 0,
      username: fd.get('username'),
      password: fd.get('password'),
      rootPath: fd.get('rootPath'),
      maxConnections: Number(fd.get('maxConnections')) || 3,
      icon,
      color,
    }
    setError('')
    busyRef.current = true
    setBusy(true)
    try {
      if (editing) await api.put(`/api/servers/${editing.id}`, body)
      else await api.post('/api/servers', body)
      qc.invalidateQueries({ queryKey: ['servers'] })
      setDirty(false)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      onClose={onClose}
      onRequestClose={mayClose}
      aria-label={editing ? t('servers.dialogEdit') : t('servers.dialogNew')}
    >
      {/* key remounts the form so defaultValues follow the edited server */}
      <form
        key={editing?.id ?? 'new'}
        onSubmit={submit}
        onChange={() => setDirty(true)}
        className="dialog-body form-dlg"
      >
        <h2 className="form-dlg-h">{editing ? t('servers.editTitle') : t('servers.newTitle')}</h2>
        <div className="form-dlg-bd grid gap-3 overflow-y-auto sm:grid-cols-2">
          <Field label={t('servers.name')} className="sm:col-span-2">
            <Input name="name" required defaultValue={editing?.name} />
          </Field>
          {/* the picture the source switch shows for this server; none = its name */}
          <Field label={t('servers.icon')} className="sm:col-span-2">
            <Segmented
              aria-label={t('servers.icon')}
              value={icon}
              onChange={pickIcon}
              options={[
                { value: '', label: t('servers.iconNone') },
                ...Object.keys(SERVER_ICONS).map((k) => ({
                  value: k,
                  'aria-label': k.replace('-', ' '),
                  label: <ServerIcon name={k} aria-hidden size="1em" />,
                })),
              ]}
            />
          </Field>
          {/* the tint of this server's entries where sources meet, e.g. in the search */}
          <Field label={t('servers.color')} className="sm:col-span-2">
            <ColorChoice value={color} onChange={pickColor} auto={editing ? serverColor(editing.id) : undefined} />
          </Field>
          <Field label={t('servers.protocol')}>
            <Select
              name="protocol"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as ServerInfo['protocol'])}
            >
              <option value="sftp">SFTP (SSH)</option>
              <option value="ftps">FTPS (TLS)</option>
            </Select>
          </Field>
          <Field label={t('servers.port')}>
            <Input
              name="port"
              className="font-mono"
              type="number"
              min={1}
              max={65535}
              placeholder={protocol === 'ftps' ? '21 / 990' : '22'}
              defaultValue={editing?.port || ''}
            />
            {protocol === 'ftps' && <p className="mt-1 text-xs text-t-muted">{t('servers.tlsHint')}</p>}
          </Field>
          <Field label={t('servers.host')} className="sm:col-span-2">
            <Input name="host" kind="host" className="font-mono" required defaultValue={editing?.host} />
          </Field>
          <Field label={t('servers.user')}>
            <Input name="username" kind="username" className="font-mono" required defaultValue={editing?.username} />
          </Field>
          <Field label={t('servers.password')}>
            <Input
              name="password"
              type="password"
              placeholder={editing ? t('servers.unchanged') : ''}
              required={!editing}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('servers.rootPath')} className="sm:col-span-2">
            <Input name="rootPath" kind="path" className="font-mono" defaultValue={editing?.rootPath ?? '/'} />
          </Field>
          {/* the hint is its own grid cell: inside the Field it would sit
              below the control, which pins itself to the bottom of the row */}
          <Field label={t('servers.maxConnections')} className="sm:col-span-2">
            <Input
              name="maxConnections"
              type="number"
              min={1}
              max={10}
              className="w-24"
              defaultValue={editing?.maxConnections ?? 3}
            />
          </Field>
          <p className="sm:col-span-2 text-xs text-t-muted">{t('servers.maxConnectionsHint')}</p>
          {error && (
            <p className="sf-issue sm:col-span-2" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dlg-foot">
          <Button onClick={cancel}>{t('servers.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('servers.save')}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}

/** The tints to pick from, as dots; "auto" keeps the one taken from the id. */
function ColorChoice({
  value,
  onChange,
  auto,
}: {
  value: string
  onChange: (v: string) => void
  auto?: SourceColorName
}) {
  const { t } = useTranslation()
  return (
    <Segmented
      aria-label={t('servers.color')}
      value={value}
      onChange={onChange}
      className="flex-wrap"
      options={[
        {
          value: '',
          label: (
            <span className="inline-flex items-center gap-1.5">
              {auto && <span aria-hidden className="t-src-dot" style={tint(auto)} />}
              {t('servers.colorAuto')}
            </span>
          ),
        },
        ...(Object.keys(SOURCE_COLORS) as SourceColorName[]).map((k) => ({
          value: k,
          'aria-label': t(`servers.colors.${k}`),
          label: <span aria-hidden className="t-src-dot" style={tint(k)} />,
        })),
      ]}
    />
  )
}

// the local library has no server row; its tint is a look of this device
function LocalColor() {
  const { t } = useTranslation()
  const [value, setValue] = useState<string>(localColor)
  return (
    <SettingsField label={t('servers.localColor')}>
      <ColorChoice
        value={value === LOCAL_DEFAULT ? '' : value}
        auto={LOCAL_DEFAULT}
        onChange={(v) => {
          const next = (v || LOCAL_DEFAULT) as SourceColorName
          setLocalColor(next)
          setValue(next)
        }}
      />
    </SettingsField>
  )
}
