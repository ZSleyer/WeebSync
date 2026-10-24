import { useState } from 'react'

/** Reads a storage key; null when it is unset or the storage is blocked (SecurityError). */
export function safeGet(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}

// a remembered setting; storage can be off (private windows), so every read
// and write may fail and the default stands
export function useStored<T extends string | number>(key: string, init: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      if (s !== null) return (typeof init === 'number' ? Number(s) : s) as T
    } catch {
      // the default stands
    }
    return init
  })
  const set = (x: T) => {
    setV(x)
    try {
      localStorage.setItem(key, String(x))
    } catch {
      // kept for this visit only
    }
  }
  return [v, set] as const
}
