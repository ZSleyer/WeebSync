import { useState } from 'react'

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
