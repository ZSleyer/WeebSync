import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Lock, LockOpen, Pencil, Plus, PlugZap, ShieldCheck, Trash2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, ApiError, type ServerInfo } from '../api'
import { useConfirm } from '../components/confirm'

export default function Servers() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [editing, setEditing] = useState<ServerInfo | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})

  const openDialog = (s: ServerInfo | null) => {
    setEditing(s)
    dialogRef.current?.showModal()
  }

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/servers/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })

  // 409 on /test = SSH host key unknown or changed; the test itself never
  // trusts anything - the user reviews old/new fingerprints and accepts or
  // rejects explicitly
  type KeyConflict = { code: string; newKey: string; newFingerprint: string; oldFingerprint?: string }
  const [keyConflict, setKeyConflict] = useState<Record<number, KeyConflict | undefined>>({})

  const test = async (id: number) => {
    setTestResult((r) => ({ ...r, [id]: '…' }))
    setKeyConflict((m) => ({ ...m, [id]: undefined }))
    try {
      await api.post(`/api/servers/${id}/test`)
      setTestResult((r) => ({ ...r, [id]: 'ok' }))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data as KeyConflict)?.newKey)
        setKeyConflict((m) => ({ ...m, [id]: e.data as KeyConflict }))
      setTestResult((r) => ({ ...r, [id]: e instanceof Error ? e.message : t('app.error') }))
    }
  }

  // accept pins exactly the reviewed key; reject just dismisses the prompt
  const acceptKey = async (id: number, key: string) => {
    try {
      await api.post(`/api/servers/${id}/trust-hostkey`, { key })
      await test(id)
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: e instanceof Error ? e.message : t('app.error') }))
    }
  }

  const rejectKey = (id: number) => {
    setKeyConflict((m) => ({ ...m, [id]: undefined }))
    setTestResult((r) => ({ ...r, [id]: t('servers.hostKeyRejected') }))
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('servers.title')}</h2>
          <span className="t-label mt-1">{t('servers.sub')}</span>
        </div>
        <button className="t-btn t-btn--primary t-cut" onClick={() => openDialog(null)}>
          <Plus aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('servers.add')}
        </button>
      </header>

      {servers.length === 0 && <div className="t-panel p-8 text-center text-t-muted">{t('servers.none')}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <div key={s.id} className="t-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="t-label t-label--accent">
                {s.protocol === 'ftp' ? <LockOpen aria-hidden size="1em" /> : <Lock aria-hidden size="1em" />}
                {s.protocol}
              </span>
              <h3 className="min-w-0 flex-1 truncate font-display font-semibold">{s.name}</h3>
            </div>
            <p className="font-mono text-xs text-t-muted">
              {s.username}@{s.host}:{s.port}
            </p>
            <p className="mb-3 font-mono text-xs text-t-muted">root: {s.rootPath}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="t-btn t-btn--sm" onClick={() => test(s.id)}>
                <PlugZap aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('servers.test')}
              </button>
              <button className="t-btn t-btn--sm" onClick={() => openDialog(s)}>
                <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('servers.edit')}
              </button>
              <button
                className="t-btn t-btn--sm t-btn--danger"
                onClick={async () => {
                  if (await confirm({ message: t('servers.confirmDelete', { name: s.name }), destructive: true }))
                    del.mutate(s.id)
                }}
              >
                <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('servers.delete')}
              </button>
              {testResult[s.id] && (
                <span
                  className={`t-label ${testResult[s.id] === 'ok' ? 't-label--ok' : testResult[s.id] === '…' ? '' : 't-label--err'}`}
                >
                  {testResult[s.id] === 'ok' ? t('servers.connected') : testResult[s.id] === '…' ? t('servers.testing') : t('servers.failed')}
                </span>
              )}
            </div>
            {testResult[s.id] && testResult[s.id] !== 'ok' && testResult[s.id] !== '…' && !keyConflict[s.id] && (
              <p className="mt-2 break-all text-xs text-err" role="alert">
                {testResult[s.id]}
              </p>
            )}
            {keyConflict[s.id] && (
              <div className="mt-2 border border-err/40 p-3">
                <p className="mb-2 text-xs text-t-muted">
                  {t(keyConflict[s.id]!.code === 'host_key_unknown' ? 'servers.hostKeyUnknown' : 'servers.hostKeyChanged')}
                </p>
                {keyConflict[s.id]!.oldFingerprint && (
                  <p className="break-all font-mono text-xs">
                    <span className="text-t-muted">{t('servers.hostKeyOld')}: </span>
                    {keyConflict[s.id]!.oldFingerprint}
                  </p>
                )}
                <p className="mb-2 break-all font-mono text-xs">
                  <span className="text-t-muted">{t('servers.hostKeyNew')}: </span>
                  {keyConflict[s.id]!.newFingerprint}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="t-btn t-btn--sm t-btn--danger"
                    onClick={() => acceptKey(s.id, keyConflict[s.id]!.newKey)}
                  >
                    <ShieldCheck aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('servers.hostKeyAccept')}
                  </button>
                  <button className="t-btn t-btn--sm" onClick={() => rejectKey(s.id)}>
                    {t('servers.hostKeyReject')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <ServerDialog ref={dialogRef} editing={editing} />
    </div>
  )
}

function ServerDialog({ ref, editing }: { ref: React.RefObject<HTMLDialogElement | null>; editing: ServerInfo | null }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  const qc = useQueryClient()
  const [error, setError] = useState('')
  // uncontrolled form: any input change marks it dirty for the close guard
  const [dirty, setDirty] = useState(false)
  const guardedClose = async () => {
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
      return
    ref.current?.close()
    setDirty(false)
  }
  // reopening the dialog (same or different server) starts clean
  useEffect(() => setDirty(false), [editing])
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
    }
    setError('')
    try {
      if (editing) await api.put(`/api/servers/${editing.id}`, body)
      else await api.post('/api/servers', body)
      qc.invalidateQueries({ queryKey: ['servers'] })
      ref.current?.close()
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  return (
    <dialog ref={ref} className="w-full max-w-md" onCancel={(e) => { e.preventDefault(); guardedClose() }} onPointerDown={(e) => (backdropDown.current = e.target === ref.current)} onClick={(e) => e.target === ref.current && backdropDown.current && guardedClose()} aria-label={editing ? t('servers.dialogEdit') : t('servers.dialogNew')}>
      {/* key remounts the form so defaultValues follow the edited server */}
      <form key={editing?.id ?? 'new'} onSubmit={submit} onChange={() => setDirty(true)} className="p-6">
        <h3 className="mb-4 font-display text-lg font-semibold tracking-wider">
          {editing ? t('servers.editTitle') : t('servers.newTitle')}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs text-t-muted">
            {t('servers.name')}
            <input name="name" className="t-input mt-1" required defaultValue={editing?.name} />
          </label>
          <label className="text-xs text-t-muted">
            {t('servers.protocol')}
            <span className="t-select-wrap mt-1">
              <select name="protocol" className="t-select" defaultValue={editing?.protocol ?? 'sftp'}>
                <option value="sftp">SFTP (SSH)</option>
                <option value="ftps">FTPS (TLS)</option>
                <option value="ftp">FTP</option>
              </select>
            </span>
          </label>
          <label className="text-xs text-t-muted">
            {t('servers.port')}
            <input
              name="port"
              className="t-input mt-1 font-mono"
              type="number"
              min={1}
              max={65535}
              placeholder="22 / 21"
              defaultValue={editing?.port || ''}
            />
          </label>
          <label className="col-span-2 text-xs text-t-muted">
            {t('servers.host')}
            <input name="host" className="t-input mt-1 font-mono" required defaultValue={editing?.host} />
          </label>
          <label className="text-xs text-t-muted">
            {t('servers.user')}
            <input name="username" className="t-input mt-1 font-mono" required defaultValue={editing?.username} />
          </label>
          <label className="text-xs text-t-muted">
            {t('servers.password')}
            <input
              name="password"
              className="t-input mt-1"
              type="password"
              placeholder={editing ? t('servers.unchanged') : ''}
              required={!editing}
              autoComplete="new-password"
            />
          </label>
          <label className="col-span-2 text-xs text-t-muted">
            {t('servers.rootPath')}
            <input name="rootPath" className="t-input mt-1 font-mono" defaultValue={editing?.rootPath ?? '/'} />
          </label>
          <label className="col-span-2 text-xs text-t-muted">
            {t('servers.maxConnections')}
            <input
              name="maxConnections"
              type="number"
              min={1}
              max={10}
              className="t-input mt-1 w-24"
              defaultValue={editing?.maxConnections ?? 3}
            />
            <span className="mt-1 block text-[11px] text-t-muted">{t('servers.maxConnectionsHint')}</span>
          </label>
        </div>
        {error && (
          <p className="mt-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="t-btn" onClick={guardedClose}>
            {t('servers.cancel')}
          </button>
          <button className="t-btn t-btn--primary t-cut">{t('servers.save')}</button>
        </div>
      </form>
    </dialog>
  )
}
