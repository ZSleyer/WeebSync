import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Download } from '../api'
import type { SeriesTarget } from './SeriesModal'

// how long the finished state stays up before the activity folds away
export const DONE_MS = 4000

const isActive = (d: Download) => d.status === 'running' || d.status === 'queued' || d.status === 'paused'

/** The queue that just ran dry: how many of it landed, and the last one. */
export interface Landed {
  count: number
  last: Download
}

interface Live {
  landed: Landed | null
  /** opens a series page, where the shell has one (the done state's tap) */
  openSeries?: (target: SeriesTarget) => void
}

const LiveCtx = createContext<Live>({ landed: null })

/**
 * Watches the shared ['downloads'] query for the moment the queue runs dry
 * and keeps what landed for DONE_MS. It lives in the shell, outside the
 * <main> that remounts with every page, so the finished state survives a
 * page change. A queue that was canceled away leaves without a check it did
 * not earn: only downloads that reached done count.
 */
export function LiveProvider({
  children,
  openSeries,
}: {
  children: ReactNode
  openSeries?: (target: SeriesTarget) => void
}) {
  const q = useQuery({ queryKey: ['downloads'], queryFn: () => api.get<Download[]>('/api/downloads') })
  const seen = useRef(new Set<number>())
  const [landed, setLanded] = useState<Landed | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    const now = q.data ?? []
    const live = now.filter(isActive)
    if (live.length > 0) {
      // a new download hides the finished moment (the activity derives
      // that from the queue); the moment's own timer still ends it
      live.forEach((d) => seen.current.add(d.id))
      return
    }
    if (seen.current.size === 0) return
    const done = now.filter((d) => seen.current.has(d.id) && d.status === 'done')
    seen.current = new Set()
    if (done.length === 0) return
    const last = done.reduce((a, b) => ((b.finishedAt ?? '') > (a.finishedAt ?? '') ? b : a))
    setLanded({ count: done.length, last })
    // not cleared by the next poll: the list refreshes every second
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setLanded(null), DONE_MS)
  }, [q.data])
  useEffect(() => () => clearTimeout(timer.current), [])
  const value = useMemo(() => ({ landed, openSeries }), [landed, openSeries])
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
}

/** What landed last, and the way into its series. */
export const useLive = () => useContext(LiveCtx)
