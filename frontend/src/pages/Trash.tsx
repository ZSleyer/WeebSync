import { useState } from 'react'
import { Link } from 'react-router'
import { File, Folder, Trash2, Undo2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Row, Rows } from 'fluid-lycoris'
import { api, fmtBytes, type TrashEntry } from '../api'
import { useAuth } from '../hooks'
import { useConfirm } from '../components/confirm'
import Loading from '../components/Loading'
import { useToast } from '../components/toast'
import './trash.css'

const trashQuery = { queryKey: ['trash'], queryFn: () => api.get<TrashEntry[]>('/api/trash'), staleTime: 60_000 }

/** The trash button for the files page: opens its page, shows how much waits. */
export function TrashButton() {
  const { t } = useTranslation()
  const { data: entries = [] } = useQuery(trashQuery)
  return (
    // a round icon button in the bar, the count as a small red badge on it
    <Link
      to="/files/trash"
      aria-label={t('trash.open', { count: entries.length })}
      title={t('trash.label')}
      className="ws-trash-btn"
      data-count={entries.length > 0 ? entries.length : undefined}
    >
      <Trash2 aria-hidden size={22} />
    </Link>
  )
}

/**
 * What waits in the trash folders, and the way out: back to where it came
 * from, or gone now rather than after the grace period. Actions are admin
 * only, like every other write to the shared library. A page stacked on
 * Files rather than a dialog: a list to work through, with an address and
 * the back gesture as a real way back.
 */
export default function TrashPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: user } = useAuth()
  const admin = !!user?.isAdmin
  // refetch on opening: the button on Files keeps the cache fresh for a minute
  const { data: entries, isPending, error } = useQuery({ ...trashQuery, refetchOnMount: 'always' })
  const [actionError, setActionError] = useState('')
  const done = () => {
    setActionError('')
    void qc.invalidateQueries({ queryKey: ['trash'] })
    void qc.invalidateQueries({ queryKey: ['local'] })
  }
  const fail = (e: unknown) => setActionError(e instanceof Error ? e.message : String(e))
  const toast = useToast()
  const restore = useMutation({
    mutationFn: (e: TrashEntry) => api.post('/api/trash/restore', { path: e.path }),
    onSuccess: (_, e) => {
      done()
      toast({ message: t('trash.restored', { name: e.name }) })
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (path: string) => api.del('/api/trash', { path }),
    onSuccess: done,
    onError: fail,
  })
  const empty = useMutation({ mutationFn: () => api.del('/api/trash'), onSuccess: done, onError: fail })
  const busy = restore.isPending || remove.isPending || empty.isPending
  const [now] = useState(() => Date.now() / 1000) // once per opening: the list is short-lived
  const daysLeft = (e: TrashEntry) => Math.max(0, Math.ceil((e.expiresAt - now) / 86_400))
  const total = (entries ?? []).reduce((n, e) => n + e.size, 0)

  const del = async (e: TrashEntry) => {
    if (
      await confirm({
        title: t('files.deleteTitle', { name: e.name }),
        message: t('trash.deleteConfirm', { name: e.name }),
        confirmLabel: t('trash.delete'),
        destructive: true,
      })
    )
      remove.mutate(e.path)
  }
  const emptyAll = async () => {
    // the server empties everything, so the question must name what is there now
    let fresh = entries ?? []
    try {
      fresh = await qc.fetchQuery({ ...trashQuery, staleTime: 0 })
    } catch (e) {
      return fail(e)
    }
    if (fresh.length === 0) return
    if (
      await confirm({
        message: t('trash.emptyConfirm', { count: fresh.length, size: fmtBytes(fresh.reduce((n, e) => n + e.size, 0)) }),
        confirmLabel: t('trash.empty'),
        destructive: true,
      })
    )
      empty.mutate()
  }

  return (
    <div className="ws-trash">
      <p className="ws-trash-hint">{t('trash.hint')}</p>
      {isPending ? (
        <Loading page />
      ) : error ? (
        <p className="py-4 text-sm text-err">{error.message}</p>
      ) : entries!.length === 0 ? (
        <div className="ws-empty">
          <b>{t('trash.empty0')}</b>
        </div>
      ) : (
        <Rows>
          {entries!.map((e) => (
            <Row
              key={e.path}
              leading={e.isDir || e.files > 1 ? <Folder size={20} /> : <File size={20} />}
              title={<span className="wrap-anywhere">{e.name}</span>}
              sub={
                <>
                  <span className="block font-mono text-xs wrap-anywhere">{e.dir}</span>
                  <span className="block">
                    {fmtBytes(e.size)}
                    {e.files > 1 && ` · ${t('trash.files', { count: e.files })}`}
                    {' · '}
                    {t('trash.expires', { count: daysLeft(e) })}
                    {e.reason === 'upgrade' &&
                      ` · ${e.replacedBy ? t('trash.reasonUpgradeBy', { name: e.replacedBy }) : t('trash.reasonUpgrade')}`}
                    {e.reason === 'duplicate' && ` · ${t('trash.reasonDuplicate')}`}
                  </span>
                </>
              }
              trailing={
                admin && (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" disabled={busy} onClick={() => restore.mutate(e)}>
                      <Undo2 aria-hidden size={18} className="mr-1.5 inline align-[-0.2em]" />
                      <span className="max-sm:sr-only">{t('trash.restore')}</span>
                    </Button>
                    <IconButton
                      aria-label={t('trash.deleteItem', { name: e.name })}
                      title={t('trash.delete')}
                      disabled={busy}
                      onClick={() => void del(e)}
                    >
                      <Trash2 aria-hidden size={20} />
                    </IconButton>
                  </span>
                )
              }
            />
          ))}
        </Rows>
      )}
      {actionError && (
        <p className="py-2 text-sm text-err" role="alert">
          {actionError}
        </p>
      )}
      {entries && (
        <div className="ws-trash-foot">
          <span>{t('trash.total', { count: entries.length, size: fmtBytes(total) })}</span>
          {admin && (
            <Button variant="danger" disabled={busy || entries.length === 0} onClick={() => void emptyAll()}>
              {t('trash.empty')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
