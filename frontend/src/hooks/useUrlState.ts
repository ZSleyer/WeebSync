import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

// Writes of one tick are applied together: two refinements set in one handler
// (clearing a search and its filter) must not overwrite each other, and the
// router's own location only moves after the first write has been handled.
let batch: URLSearchParams | null = null

function write(navigate: ReturnType<typeof useNavigate>, apply: (p: URLSearchParams) => void) {
  if (!batch) {
    batch = new URLSearchParams(window.location.search)
    queueMicrotask(() => {
      const search = batch?.toString() ?? ''
      batch = null
      // the same entry, not a new one: a refinement is no place to go back to
      navigate({ search: search ? `?${search}` : '', hash: window.location.hash }, { replace: true })
    })
  }
  apply(batch)
}

/**
 * A page's search text or filter, kept in the address so a reload, a shared
 * link and the way back from another page find it again. The URL wins on
 * arrival; a change writes it by replacement, so typing never adds history
 * entries. Nothing is written on mount (a new location key would cost the
 * scroll position ScrollMemory restores). The fallback leaves no parameter
 * behind.
 */
export function useUrlState(param: string, fallback = '') {
  const navigate = useNavigate()
  const [value, setState] = useState(() => new URLSearchParams(window.location.search).get(param) ?? fallback)
  const set = useCallback(
    (next: string) => {
      setState(next)
      write(navigate, (p) => (next === fallback ? p.delete(param) : p.set(param, next)))
    },
    [navigate, param, fallback],
  )
  return [value, set] as const
}

/**
 * Takes its parameters off the address again when the component goes while
 * the page stays (a sheet that closes): they belong to the sheet, not to the
 * page under it. A route change leaves the new address alone.
 */
export function useLeaveParams(params: readonly string[]) {
  const navigate = useNavigate()
  const keys = params.join('\n')
  useEffect(() => {
    const path = window.location.pathname
    return () => {
      if (window.location.pathname !== path) return
      const mine = keys.split('\n')
      if (!mine.some((k) => new URLSearchParams(window.location.search).has(k))) return
      write(navigate, (p) => mine.forEach((k) => p.delete(k)))
    }
  }, [keys, navigate])
}
