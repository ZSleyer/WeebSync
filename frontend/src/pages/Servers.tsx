import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ServerInfo } from '../api'

export default function Servers() {
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

  const test = async (id: number) => {
    setTestResult((r) => ({ ...r, [id]: '…' }))
    try {
      await api.post(`/api/servers/${id}/test`)
      setTestResult((r) => ({ ...r, [id]: 'ok' }))
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: e instanceof Error ? e.message : 'Fehler' }))
    }
  }

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">SERVER</h2>
          <span className="t-label mt-1">remote sources</span>
        </div>
        <button className="t-btn t-btn--primary t-cut" onClick={() => openDialog(null)}>
          + Server hinzufügen
        </button>
      </header>

      {servers.length === 0 && (
        <div className="t-panel p-8 text-center text-t-muted">Noch keine Server konfiguriert.</div>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <div key={s.id} className="t-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="t-label t-label--accent">{s.protocol}</span>
              <h3 className="min-w-0 flex-1 truncate font-display font-semibold">{s.name}</h3>
            </div>
            <p className="font-mono text-xs text-t-muted">
              {s.username}@{s.host}:{s.port}
            </p>
            <p className="mb-3 font-mono text-xs text-t-faint">root: {s.rootPath}</p>
            <div className="flex items-center gap-2">
              <button className="t-btn t-btn--sm" onClick={() => test(s.id)}>
                Test
              </button>
              <button className="t-btn t-btn--sm" onClick={() => openDialog(s)}>
                Edit
              </button>
              <button
                className="t-btn t-btn--sm t-btn--danger"
                onClick={() => {
                  if (confirm(`Server "${s.name}" löschen?`)) del.mutate(s.id)
                }}
              >
                Löschen
              </button>
              {testResult[s.id] && (
                <span
                  className={`t-label ${testResult[s.id] === 'ok' ? 't-label--ok' : testResult[s.id] === '…' ? '' : 't-label--err'}`}
                  title={testResult[s.id]}
                >
                  {testResult[s.id] === 'ok' ? 'verbunden' : testResult[s.id] === '…' ? 'teste…' : 'fehler'}
                </span>
              )}
            </div>
            {testResult[s.id] && testResult[s.id] !== 'ok' && testResult[s.id] !== '…' && (
              <p className="mt-2 break-all text-xs text-err">{testResult[s.id]}</p>
            )}
          </div>
        ))}
      </div>

      <ServerDialog ref={dialogRef} editing={editing} />
    </div>
  )
}

function ServerDialog({ ref, editing }: { ref: React.RefObject<HTMLDialogElement | null>; editing: ServerInfo | null }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')

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
    }
    setError('')
    try {
      if (editing) await api.put(`/api/servers/${editing.id}`, body)
      else await api.post('/api/servers', body)
      qc.invalidateQueries({ queryKey: ['servers'] })
      ref.current?.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler')
    }
  }

  return (
    <dialog ref={ref} className="w-full max-w-md" aria-label={editing ? 'Server bearbeiten' : 'Server hinzufügen'}>
      {/* key remounts the form so defaultValues follow the edited server */}
      <form key={editing?.id ?? 'new'} onSubmit={submit} className="p-6">
        <h3 className="mb-4 font-display text-lg font-semibold tracking-wider">
          {editing ? 'SERVER BEARBEITEN' : 'NEUER SERVER'}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs text-t-muted">
            Name
            <input name="name" className="t-input mt-1" required defaultValue={editing?.name} />
          </label>
          <label className="text-xs text-t-muted">
            Protokoll
            <span className="t-select-wrap mt-1">
              <select name="protocol" className="t-select" defaultValue={editing?.protocol ?? 'sftp'}>
                <option value="sftp">SFTP (SSH)</option>
                <option value="ftps">FTPS (TLS)</option>
                <option value="ftp">FTP</option>
              </select>
            </span>
          </label>
          <label className="text-xs text-t-muted">
            Port
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
            Host
            <input name="host" className="t-input mt-1 font-mono" required defaultValue={editing?.host} />
          </label>
          <label className="text-xs text-t-muted">
            Benutzer
            <input name="username" className="t-input mt-1 font-mono" required defaultValue={editing?.username} />
          </label>
          <label className="text-xs text-t-muted">
            Passwort
            <input
              name="password"
              className="t-input mt-1"
              type="password"
              placeholder={editing ? '(unverändert)' : ''}
              required={!editing}
              autoComplete="new-password"
            />
          </label>
          <label className="col-span-2 text-xs text-t-muted">
            Root-Pfad
            <input name="rootPath" className="t-input mt-1 font-mono" defaultValue={editing?.rootPath ?? '/'} />
          </label>
        </div>
        {error && (
          <p className="mt-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="t-btn" onClick={() => ref.current?.close()}>
            Abbrechen
          </button>
          <button className="t-btn t-btn--primary t-cut">Speichern</button>
        </div>
      </form>
    </dialog>
  )
}
