import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'

// One place for short feedback across the app: a line at the bottom that says
// what just happened, with "Undo" where that can be taken back. A removal
// does not ask first. The row goes at once, the server is only told when the
// line runs out; undo puts the row back without the server ever knowing.

const UNDO_MS = 5000

interface ToastOptions {
  message: string
  /** shown as a button; runs instead of `commit` */
  undo?: () => void
  /** what the line holds back until it runs out (or another line replaces it) */
  commit?: () => Promise<unknown> | void
}

type ToastFn = (opts: ToastOptions) => void

const ToastCtx = createContext<ToastFn>(() => {})

interface Live extends ToastOptions {
  id: number
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [live, setLive] = useState<Live | null>(null)
  const pending = useRef<{ id: number; commit?: ToastOptions['commit'] } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const seq = useRef(0)

  // the held-back action goes through exactly once: on timeout, when the
  // next line replaces this one, or when the page is left
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const p = pending.current
    pending.current = null
    void p?.commit?.()
  }, [])

  const toast = useCallback<ToastFn>(
    (opts) => {
      flush()
      const id = ++seq.current
      pending.current = { id, commit: opts.commit }
      setLive({ ...opts, id })
      timer.current = setTimeout(() => {
        flush()
        setLive((l) => (l?.id === id ? null : l))
      }, UNDO_MS)
    },
    [flush],
  )

  useEffect(() => {
    addEventListener('pagehide', flush)
    return () => removeEventListener('pagehide', flush)
  }, [flush])

  // the region sits in the top layer, so a line raised from inside an open
  // sheet is not hidden behind it. It stays open (empty, it takes no room)
  // so the live region is there before its text; raised again per line, it
  // lands on top of whatever opened since.
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = region.current
    if (!el?.showPopover) return
    if (el.matches(':popover-open')) el.hidePopover()
    el.showPopover()
  }, [live])

  const undo = () => {
    clearTimeout(timer.current)
    pending.current = null
    live?.undo?.()
    setLive(null)
  }

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div ref={region} popover="manual" role="status" aria-live="polite" className="t-toast-region">
        {live && (
          <div key={live.id} className="t-toast">
            <span className="min-w-0 flex-1">{live.message}</span>
            {live.undo && (
              <button type="button" className="t-toast__undo" onClick={undo}>
                {t('common.undo')}
              </button>
            )}
            <i aria-hidden className="t-toast__time" style={{ animationDuration: `${UNDO_MS}ms` }} />
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

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
          toast({ message: t('common.undoFailed') })
        }),
    })
  }
}
