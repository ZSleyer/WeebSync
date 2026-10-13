import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, Lock, LockOpen, Pencil, Plus, PlugZap, Save, Trash2, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ActionBar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Panel,
  Segmented,
  Select,
} from '@weebsync/design-system'
import { api, keyConflictOf, type KeyConflict, type ScopeRule, type ServerInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import HostKeyPrompt from '../../components/HostKeyPrompt'
import { PageFooter } from '../../components/PageActions'
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
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  // mount-to-open, like every other dialog in the app: the state IS the dialog
  const [editing, setEditing] = useState<ServerInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
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

  return (
    <div>
      {/* the settings frame carries the title and the menu names the section,
          so the page starts with its one primary action: top right on desktop,
          the shell's footer row on a phone (a portal, so the hidden header
          does not hide it there) */}
      <header className="mb-4 hidden justify-end lg:flex">
        <PageFooter>
          <ActionBar aria-label={t('servers.add')} sticky={false}>
            <Button variant="primary" onClick={() => openDialog(null)}>
              <Plus aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('servers.add')}
            </Button>
          </ActionBar>
        </PageFooter>
      </header>

      {servers.length === 0 && <EmptyState>{t('servers.none')}</EmptyState>}
      <LocalColor />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <Panel key={s.id} className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={s.protocol === 'ftp' ? 'warn' : 'accent'}>
                {s.protocol === 'ftp' ? <LockOpen aria-hidden size="1em" /> : <Lock aria-hidden size="1em" />}
                {s.protocol}
              </Badge>
              <span aria-hidden className="t-src-dot" style={tint(serverColor(s.id, s.color))} />
              <h3 className="min-w-0 flex-1 truncate font-display font-semibold">{s.name}</h3>
            </div>
            <p className="truncate font-mono text-xs text-t-muted" title={`${s.username}@${s.host}:${s.port}`}>
              {s.username}@{s.host}:{s.port}
            </p>
            <p className="mb-3 font-mono text-xs text-t-muted">root: {s.rootPath}</p>
            {/* plain FTP still works, it is only on its way out: the card says so,
                since a server set up long ago never opens the form again */}
            {s.protocol === 'ftp' && (
              <p className="mb-3 text-xs text-warn" role="note">
                {t('servers.ftpDeprecated')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => test(s.id)}>
                <PlugZap aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('servers.test')}
              </Button>
              <Button size="sm" onClick={() => openDialog(s)}>
                <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
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
                <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('servers.delete')}
              </Button>
              {testResult[s.id] && (
                <Badge tone={testResult[s.id] === 'ok' ? 'ok' : testResult[s.id] === '…' ? 'neutral' : 'err'}>
                  {testResult[s.id] === 'ok'
                    ? t('servers.connected')
                    : testResult[s.id] === '…'
                      ? t('servers.testing')
                      : t('servers.failed')}
                </Badge>
              )}
            </div>
            {testResult[s.id] && testResult[s.id] !== 'ok' && testResult[s.id] !== '…' && !keyConflict[s.id] && (
              <p className="mt-2 break-all text-xs text-err" role="alert">
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
          </Panel>
        ))}
      </div>

      {/* every SFTP server's pinned key in one place: a check shows a changed
          key as the old and the new fingerprint, to accept or reject */}
      {servers.some((s) => s.protocol === 'sftp') && (
        <section className="mt-8" aria-labelledby="host-keys">
          <h3 id="host-keys" className="mb-1 font-display font-semibold tracking-wider">
            {t('servers.hostKeys')}
          </h3>
          <p className="mb-3 text-sm text-pretty text-t-secondary">{t('servers.hostKeysHint')}</p>
          <Panel>
            <ul className="divide-y divide-border-subtle">
              {servers
                .filter((s) => s.protocol === 'sftp')
                .map((s) => (
                  <li key={s.id} className="grid gap-2 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-28 font-medium">{s.name}</span>
                      {s.hostKey ? (
                        <code className="min-w-0 flex-1 font-mono text-xs break-all text-t-secondary">{s.hostKey}</code>
                      ) : (
                        <span className="flex-1 text-sm text-warn">{t('servers.hostKeyNone')}</span>
                      )}
                      {checkedIn[s.id] === 'keys' && testResult[s.id] === 'ok' && (
                        <Badge tone="ok">{t('servers.hostKeySame')}</Badge>
                      )}
                      <Button size="sm" onClick={() => test(s.id, 'keys')}>
                        <KeyRound aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('servers.hostKeyCheck')}
                      </Button>
                    </div>
                    {checkedIn[s.id] === 'keys' && keyConflict[s.id] && (
                      <HostKeyPrompt
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
          </Panel>
        </section>
      )}

      <ScopeRules />
      {dialogOpen && <ServerDialog editing={editing} onClose={() => setDialogOpen(false)} />}
    </div>
  )
}

// The folder rules: which new folders get a catalog mark on their own. They
// are made in the catalog view of a marked folder or from a dashboard hint,
// and this is where they are seen together and ended.
function ScopeRules() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: rules = [] } = useQuery<ScopeRule[]>({
    queryKey: ['scope-rules'],
    queryFn: () => api.get('/api/catalog/scope-rules'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/catalog/scope-rules/${id}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['scope-rules'] })
      qc.invalidateQueries({ queryKey: ['catalog-scope'] })
      qc.invalidateQueries({ queryKey: ['scope-hints'] })
    },
  })
  if (rules.length === 0) return null
  const kindLabel = (kind: string) =>
    ({
      anime: t('remote.scopeAnime'),
      manga: t('remote.scopeManga'),
      tv: t('remote.scopeTv'),
      movie: t('remote.scopeMovie'),
      tvdb: t('remote.scopeTvdb'),
    })[kind] ?? kind
  // the placeholders in words: "{n}-{n} {season}" reads as "#-# Jahreszeit"
  const shape = (s: string) => s.replaceAll('{n}', '#').replaceAll('{season}', t('servers.ruleSeason'))
  return (
    <Panel as="section" className="mt-4 p-4" aria-label={t('servers.rules')}>
      <Badge tone="accent">{t('servers.rules')}</Badge>
      <p className="mt-2 text-xs text-t-muted">{t('servers.rulesHint')}</p>
      <ul className="mt-3 divide-y divide-border-subtle text-sm">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">
              <span className="block break-all font-mono text-xs text-t-muted">
                {r.serverName || t('servers.local')}: {r.parent}
              </span>
              <span className="block">
                <span className="font-mono">{shape(r.shape)}</span> {'->'} {kindLabel(r.kind)}
              </span>
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={del.isPending}
              aria-label={`${t('servers.ruleDelete')}: ${r.parent}/${shape(r.shape)}`}
              onClick={async () => {
                if (await confirm({ message: t('servers.ruleConfirmDelete'), destructive: true })) del.mutate(r.id)
              }}
            >
              <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('servers.ruleDelete')}
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function ServerDialog({ editing, onClose }: { editing: ServerInfo | null; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [protocol, setProtocol] = useState(editing?.protocol ?? 'sftp')
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
      <form key={editing?.id ?? 'new'} onSubmit={submit} onChange={() => setDirty(true)} className="p-6">
        <h3 className="mb-4 font-display text-lg font-semibold tracking-wider">
          {editing ? t('servers.editTitle') : t('servers.newTitle')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
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
              <option value="ftp">{t('servers.ftpOption')}</option>
            </Select>
          </Field>
          <Field label={t('servers.port')}>
            <Input
              name="port"
              className="font-mono"
              type="number"
              min={1}
              max={65535}
              placeholder="22 / 21"
              defaultValue={editing?.port || ''}
            />
          </Field>
          <Field label={t('servers.host')} className="sm:col-span-2">
            <Input name="host" className="font-mono" required defaultValue={editing?.host} />
          </Field>
          <Field label={t('servers.user')}>
            <Input name="username" className="font-mono" required defaultValue={editing?.username} />
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
            <Input name="rootPath" className="font-mono" defaultValue={editing?.rootPath ?? '/'} />
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
          {protocol === 'ftp' && (
            <p className="sm:col-span-2 rounded-md border border-warn/50 px-3 py-2 text-sm text-warn" role="status">
              {t('servers.ftpWarning')}
            </p>
          )}
          <p className="sm:col-span-2 text-xs text-t-muted">{t('servers.maxConnectionsHint')}</p>
        </div>
        {error && (
          <p className="mt-3 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={cancel}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('servers.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            <Save aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('servers.save')}
          </Button>
        </div>
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
    <Panel className="mb-3 flex flex-wrap items-center gap-3 p-4">
      <span aria-hidden className="t-src-dot" style={tint(localColor())} />
      <span className="min-w-0 flex-1 font-display font-semibold">{t('palette.local')}</span>
      <ColorChoice
        value={value === LOCAL_DEFAULT ? '' : value}
        auto={LOCAL_DEFAULT}
        onChange={(v) => {
          const next = (v || LOCAL_DEFAULT) as SourceColorName
          setLocalColor(next)
          setValue(next)
        }}
      />
    </Panel>
  )
}
