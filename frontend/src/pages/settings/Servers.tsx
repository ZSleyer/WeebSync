import { useEffect, useState, type FormEvent } from 'react'
import { Lock, LockOpen, Pencil, Plus, PlugZap, Save, Trash2, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ActionBar, Badge, Button, Dialog, EmptyState, Field, Input, Panel, Segmented, Select } from '@weebsync/design-system'
import { api, keyConflictOf, type KeyConflict, type ServerInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import HostKeyPrompt from '../../components/HostKeyPrompt'
import { PageFooter } from '../../components/PageActions'
import { SERVER_ICONS, ServerIcon } from '../../components/serverIcon'

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

  const test = async (id: number) => {
    setTestResult((r) => ({ ...r, [id]: '…' }))
    setKeyConflict((m) => ({ ...m, [id]: undefined }))
    try {
      await api.post(`/api/servers/${id}/test`)
      setTestResult((r) => ({ ...r, [id]: 'ok' }))
    } catch (e) {
      const kc = keyConflictOf(e)
      if (kc) setKeyConflict((m) => ({ ...m, [id]: kc }))
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <Panel key={s.id} className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="accent">
                {s.protocol === 'ftp' ? <LockOpen aria-hidden size="1em" /> : <Lock aria-hidden size="1em" />}
                {s.protocol}
              </Badge>
              <h3 className="min-w-0 flex-1 truncate font-display font-semibold">{s.name}</h3>
            </div>
            <p className="truncate font-mono text-xs text-t-muted" title={`${s.username}@${s.host}:${s.port}`}>
              {s.username}@{s.host}:{s.port}
            </p>
            <p className="mb-3 font-mono text-xs text-t-muted">root: {s.rootPath}</p>
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
                  {testResult[s.id] === 'ok' ? t('servers.connected') : testResult[s.id] === '…' ? t('servers.testing') : t('servers.failed')}
                </Badge>
              )}
            </div>
            {testResult[s.id] && testResult[s.id] !== 'ok' && testResult[s.id] !== '…' && !keyConflict[s.id] && (
              <p className="mt-2 break-all text-xs text-err" role="alert">
                {testResult[s.id]}
              </p>
            )}
            {keyConflict[s.id] && (
              <HostKeyPrompt className="mt-2" serverId={s.id} conflict={keyConflict[s.id]!} onAccepted={() => test(s.id)} onRejected={() => rejectKey(s.id)} />
            )}
          </Panel>
        ))}
      </div>

      {dialogOpen && <ServerDialog editing={editing} onClose={() => setDialogOpen(false)} />}
    </div>
  )
}

function ServerDialog({ editing, onClose }: { editing: ServerInfo | null; onClose: () => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [error, setError] = useState('')
	const [protocol, setProtocol] = useState(editing?.protocol ?? 'sftp')
	const [icon, setIcon] = useState(editing?.icon ?? '')
  // uncontrolled form: any input change marks it dirty for the close guard
  const [dirty, setDirty] = useState(false)
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
    }
    setError('')
    try {
      if (editing) await api.put(`/api/servers/${editing.id}`, body)
      else await api.post('/api/servers', body)
      qc.invalidateQueries({ queryKey: ['servers'] })
      setDirty(false)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
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
              onChange={setIcon}
              options={[
                { value: '', label: t('servers.iconNone') },
                ...Object.keys(SERVER_ICONS).map((k) => ({ value: k, 'aria-label': k.replace('-', ' '), label: <ServerIcon name={k} aria-hidden size="1em" /> })),
              ]}
            />
          </Field>
          <Field label={t('servers.protocol')}>
            <Select name="protocol" value={protocol} onChange={(e) => setProtocol(e.target.value as ServerInfo['protocol'])}>
              <option value="sftp">SFTP (SSH)</option>
              <option value="ftps">FTPS (TLS)</option>
              <option value="ftp">FTP</option>
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
          <Button type="submit" variant="primary">
            <Save aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('servers.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
