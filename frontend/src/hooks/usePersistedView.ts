import { useState } from 'react'
import { useSearchParams } from 'react-router'

/**
 * A page's view choice, remembered: the URL wins on arrival (a link into the
 * calendar), then what the reader picked last time, then the default. A
 * change writes both, the URL by replacement so the history stays one entry
 * per page. Nothing is written on mount: a new location key would cost the
 * scroll position ScrollMemory restores on the way back.
 */
export function usePersistedView<T extends string>(key: string, allowed: readonly T[], fallback: T, param = 'view') {
  const [params, setParams] = useSearchParams()
  const ok = (v: string | null): v is T => !!v && (allowed as readonly string[]).includes(v)
  const [view, setState] = useState<T>(() => {
    const fromUrl = params.get(param)
    if (ok(fromUrl)) return fromUrl
    try {
      const saved = localStorage.getItem(key)
      if (ok(saved)) return saved
    } catch {
      // storage can be off; the default is fine
    }
    return fallback
  })
  const setView = (next: T) => {
    setState(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // storage can be off; the URL still carries it
    }
    setParams(
      (p) => {
        if (next === fallback) p.delete(param)
        else p.set(param, next)
        return p
      },
      { replace: true },
    )
  }
  return [view, setView] as const
}
