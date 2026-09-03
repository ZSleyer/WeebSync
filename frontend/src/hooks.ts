import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type AiModels, type AiStatus, type Download, type User } from './api'
import i18n, { syncLocale } from './locales'

let localeSynced = false

export function useAuth() {
  return useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api.get<User>('/api/auth/me')
        // one sync per app load, so the backend knows the language even if
        // the user never touches the switcher
        if (!localeSynced) {
          localeSynced = true
          syncLocale(i18n.language)
        }
        return me
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
  })
}

// usePersistedQuery: useQuery + localStorage snapshot. The last result shows
// instantly (marked stale, so a live refetch starts right away and entries
// may disappear after it) instead of a skeleton on every page load. The
// storage key is scoped per user id, so accounts never see each other's data.
export function usePersistedQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  opts?: { refetchInterval?: (q: { state: { data?: T } }) => number | false },
) {
  const { data: user } = useAuth()
  const storageKey = `weebsync.cache.${user?.id ?? 0}.${key}`
  const q = useQuery<T>({
    queryKey: [key],
    queryFn,
    ...opts,
    initialData: () => {
      try {
        const v = localStorage.getItem(storageKey)
        return v ? (JSON.parse(v) as T) : undefined
      } catch {
        return undefined
      }
    },
    initialDataUpdatedAt: 0, // always stale → refetch immediately
  })
  useEffect(() => {
    if (q.data === undefined) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(q.data))
    } catch {
      /* storage full/blocked - cache is best effort */
    }
  }, [q.data, storageKey])
  return q
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
    // on stream error re-check auth: a 401 (expired session) otherwise makes
    // EventSource reconnect-loop forever. If the session is gone, ['me'] flips
    // to null → the app unmounts this (enabled=false) and the stream closes.
    es.onerror = () => qc.invalidateQueries({ queryKey: ['me'] })
    return () => es.close()
  }, [enabled, qc])
}

// useAiStatus gates the assistant: the nav entry and the page only show when
// an endpoint is configured. No network call behind it (that is force=1 on
// the settings page), so a dead endpoint never slows the shell down.
export function useAiStatus(enabled = true) {
  return useQuery<AiStatus>({
    queryKey: ['ai-status'],
    queryFn: () => api.get('/api/ai/status'),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// useAiModels asks the endpoint for its model list (a live call, so only
// while a picker is on screen). Never throws: an unreachable endpoint comes
// back as an empty list plus error text.
export function useAiModels(enabled = true) {
  return useQuery<AiModels>({
    queryKey: ['ai-models'],
    queryFn: () => api.get('/api/ai/models'),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
