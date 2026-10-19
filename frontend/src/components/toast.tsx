import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { Toast, toastDuration, ToastRegion } from 'fluid-lycoris'

declare module '@tanstack/react-query' {
  interface Register {
    /** `silent`: the mutation shows its own error, the app-wide line stays out of it */
    mutationMeta: { silent?: boolean }
  }
}

// One place for short feedback across the app: a line at the bottom that says
// what just happened, with "Undo" where that can be taken back. A removal
// does not ask first. The row goes at once, the server is only told when the
// line runs out; undo puts the row back without the server ever knowing.
// A plain message takes a line of its own above that one, so a failure that
// is reported while a removal still waits neither sends the removal early
// nor takes its Undo away.
// Each line stays as long as it takes to read (toastDuration: by its words,
// longer with an undo), held while hovered, focused or the tab is hidden; the
// toast keeps that time itself and says when it ran out.

interface ToastOptions {
  message: string
  /** shown as a button; runs instead of `commit` */
  undo?: () => void
  /** what the line holds back until it runs out (or another line replaces it) */
  commit?: () => Promise<unknown> | void
  /** a failure: announced assertively */
  error?: boolean
}

type ToastFn = (opts: ToastOptions) => void

const ToastCtx = createContext<ToastFn>(() => {})

interface Live extends ToastOptions {
  id: number
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [live, setLive] = useState<Live | null>(null)
  const [notice, setNotice] = useState<Live | null>(null)
  const pending = useRef<{ id: number; commit?: ToastOptions['commit'] } | null>(null)
  const seq = useRef(0)

  // the held-back action goes through exactly once: when the line runs out or
  // is closed, when the next line replaces this one, or when the page is left
  const flush = useCallback(() => {
    const p = pending.current
    pending.current = null
    void p?.commit?.()
  }, [])

  const toast = useCallback<ToastFn>(
    (opts) => {
      const id = ++seq.current
      if (!opts.undo && !opts.commit) {
        setNotice({ ...opts, id })
        return
      }
      flush()
      pending.current = { id, commit: opts.commit }
      setLive({ ...opts, id })
    },
    [flush],
  )

  // Every failed mutation says so, unless it handles its own error (onError
  // on the mutation) or shows it itself (meta.silent). Before this a failed
  // pause, delete or toggle looked exactly like one that worked.
  const qc = useQueryClient()
  useEffect(
    () =>
      qc.getMutationCache().subscribe((e) => {
        if (e.type !== 'updated' || e.action.type !== 'error') return
        const m = e.mutation
        if (m.options.onError || m.meta?.silent) return
        const err = e.action.error
        toast({
          message: t('common.actionFailed', { msg: err instanceof Error ? err.message : String(err) }),
          error: true,
        })
      }),
    [qc, toast, t],
  )

  useEffect(() => {
    addEventListener('pagehide', flush)
    return () => removeEventListener('pagehide', flush)
  }, [flush])

  const undo = () => {
    pending.current = null
    live?.undo?.()
    setLive(null)
  }

  // run out or closed: a held-back removal goes through now
  const closeLive = useCallback(() => {
    flush()
    setLive(null)
  }, [flush])
  const closeNotice = useCallback(() => setNotice(null), [])

  const noticeLine = notice && (
    <Toast
      key={notice.id}
      message={notice.message}
      duration={toastDuration(notice.message)}
      onClose={closeNotice}
      closeLabel={t('common.close')}
    />
  )

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {/* the region sits in the top layer and is raised again per line, so a
          line raised from inside an open sheet lands on top of it */}
      <ToastRegion raise={`${live?.id}-${notice?.id}`} alerts={notice?.error && noticeLine}>
        {notice && !notice.error && noticeLine}
        {live && (
          <Toast
            key={live.id}
            message={live.message}
            action={live.undo ? { label: t('common.undo'), onClick: undo } : undefined}
            duration={toastDuration(live.message, !!live.undo)}
            onClose={closeLive}
            closeLabel={t('common.close')}
          />
        )}
      </ToastRegion>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/** For a direct api call outside a mutation: report its failure like a failed mutation. */
export function useFailToast() {
  const toast = useToast()
  const { t } = useTranslation()
  return (err: unknown) =>
    toast({
      message: t('common.actionFailed', { msg: err instanceof Error ? err.message : String(err) }),
      error: true,
    })
}

/**
 * Remove something from a cached list at once and send the removal only when
 * the undo line runs out. While it waits, a refetch of that list (polling,
 * the event stream) would bring the row back, so it is filtered out of every
 * update until the removal has gone through or been undone.
 */
export function useUndoableRemove() {
  const qc = useQueryClient()
  const toast = useToast()
  const { t } = useTranslation()
  return <T,>({
    key,
    match,
    message,
    remove,
  }: {
    key: QueryKey
    match: (item: T) => boolean
    message: string
    remove: () => Promise<unknown>
  }) => {
    // only where the row is still there: writing a list back unchanged
    // would report another update and come straight back here
    const hide = () =>
      qc.getQueriesData<T[]>({ queryKey: key }).forEach(([k, list]) => {
        if (Array.isArray(list) && list.some(match))
          qc.setQueryData<T[]>(
            k,
            list.filter((x) => !match(x)),
          )
      })
    hide()
    // a refetch lands as a non-manual success; our own writes are manual
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'success' && !e.action.manual) hide()
    })
    const settle = () => {
      unsub()
      return qc.invalidateQueries({ queryKey: key })
    }
    toast({
      message,
      undo: () => void settle(),
      commit: () =>
        remove().then(settle, () => {
          void settle()
          toast({ message: t('common.undoFailed'), error: true })
        }),
    })
  }
}
