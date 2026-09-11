import { useState } from 'react'
import { File, Folder, Trash2, Undo2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Count, Dialog, IconButton } from '@weebsync/design-system'
import { api, fmtBytes, type TrashEntry } from '../api'
import { useAuth } from '../hooks'
import { useConfirm } from './confirm'
import Loading from './Loading'

const trashQuery = { queryKey: ['trash'], queryFn: () => api.get<TrashEntry[]>('/api/trash'), staleTime: 60_000 }

/** The trash button for the files page: opens the list, shows how much waits. */
export function TrashButton() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data: entries = [] } = useQuery(trashQuery)
  return (
    <span className="inline-flex items-center gap-1">
      <IconButton aria-label={t('trash.open', { count: entries.length })} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden size="1.2em" />
      </IconButton>
      {entries.length > 0 && <Count aria-hidden>{entries.length}</Count>}
      {open && <TrashDialog onClose={() => setOpen(false)} />}
    </span>
  )
}

/**
 * What waits in the trash folders, and the way out: back to where it came
 * from, or gone now rather than after the grace period. Actions are admin
 * only, like every other write to the shared library.
 */
function TrashDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: user } = useAuth()
  const admin = !!user?.isAdmin
  const { data: entries, isPending, error } = useQuery(trashQuery)
  const [actionError, setActionError] = useState('')
  const done = () => {
    setActionError('')
    void qc.invalidateQueries({ queryKey: ['trash'] })
    void qc.invalidateQueries({ queryKey: ['local'] })
  }
  const fail = (e: unknown) => setActionError(e instanceof Error ? e.message : String(e))
  const restore = useMutation({ mutationFn: (path: string) => api.post('/api/trash/restore', { path }), onSuccess: done, onError: fail })
  const remove = useMutation({ mutationFn: (path: string) => api.del('/api/trash', { path }), onSuccess: done, onError: fail })
  const empty = useMutation({ mutationFn: () => api.del('/api/trash'), onSuccess: done, onError: fail })
  const busy = restore.isPending || remove.isPending || empty.isPending
  const [now] = useState(() => Date.now() / 1000) // once per opening: the list is short-lived
  const daysLeft = (e: TrashEntry) => Math.max(0, Math.ceil((e.expiresAt - now) / 86_400))
  const total = (entries ?? []).reduce((n, e) => n + e.size, 0)

  const del = async (e: TrashEntry) => {
    if (await confirm({ message: t('trash.deleteConfirm', { name: e.name }), confirmLabel: t('trash.delete'), destructive: true })) remove.mutate(e.path)
  }
  const emptyAll = async () => {
    if (await confirm({ message: t('trash.emptyConfirm', { count: entries?.length ?? 0, size: fmtBytes(total) }), confirmLabel: t('trash.empty'), destructive: true })) empty.mutate()
  }

  return (
    <Dialog width="max-w-2xl" aria-labelledby="trash-title" onClose={onClose}>
      <div className="dialog-body">
        <header className="shrink-0 border-b border-border-subtle px-5 py-3">
          <h3 id="trash-title" className="font-display font-semibold tracking-wider">
            {t('trash.title')}
          </h3>
          <p className="text-xs text-t-muted">{t('trash.hint')}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isPending ? (
            <Loading />
          ) : error ? (
            <p className="px-5 py-4 text-sm text-err">{error.message}</p>
          ) : entries!.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-t-muted">{t('trash.empty0')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {entries!.map((e) => (
                <li key={e.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2">
                  {e.isDir ? <Folder aria-hidden size="1.2em" className="shrink-0 text-t-muted" /> : <File aria-hidden size="1.2em" className="shrink-0 text-t-muted" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-t-primary" title={e.name}>
                      {e.name}
                    </p>
                    <p className="truncate font-mono text-[11px] text-t-muted" title={e.dir}>
                      {e.dir}
                    </p>
                    <p className="text-[11px] text-t-muted">
                      {fmtBytes(e.size)}
                      {e.files > 1 && ` · ${t('trash.files', { count: e.files })}`}
                      {' · '}
                      {t('trash.expires', { count: daysLeft(e) })}
                    </p>
                  </div>
                  {admin && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" disabled={busy} onClick={() => restore.mutate(e.path)}>
                        <Undo2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                        {t('trash.restore')}
                      </Button>
                      <IconButton aria-label={t('trash.deleteItem', { name: e.name })} disabled={busy} onClick={() => void del(e)}>
                        <Trash2 aria-hidden size="1.1em" />
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {actionError && (
            <p className="px-5 py-2 text-sm text-err" role="alert">
              {actionError}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          {entries && entries.length > 0 && <span className="mr-auto text-xs text-t-muted">{t('trash.total', { count: entries.length, size: fmtBytes(total) })}</span>}
          {admin && entries && entries.length > 0 && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void emptyAll()}>
              {t('trash.empty')}
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}
