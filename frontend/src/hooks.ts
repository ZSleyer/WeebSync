import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Download, type User } from './api'

export function useAuth() {
  return useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<User>('/api/auth/me')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
  })
}

// useEvents subscribes to the SSE progress stream and patches the
// downloads query cache in place.
export function useEvents(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const es = new EventSource('/api/events')
    es.onmessage = (ev) => {
      let d: Download
      try {
        d = JSON.parse(ev.data)
      } catch {
        return // ignore malformed/keepalive frames
      }
      qc.setQueryData<Download[]>(['downloads'], (old) => {
        if (!old) return old
        const idx = old.findIndex((x) => x.id === d.id)
        if (idx === -1) return [d, ...old]
        const next = [...old]
        next[idx] = d
        return next
      })
    }
    return () => es.close()
  }, [enabled, qc])
}
