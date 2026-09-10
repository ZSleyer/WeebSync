import { useEffect, useState } from 'react'
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

export interface VersionInfo {
  version: string
  channel: string
  commit: string
  repo: string
  updateCheck: boolean
  updateAvailable: boolean
  latest: string
  url: string
}

// How often an open tab asks again. The backend caches its upstream lookup for
// six hours, so this is not what decides how fresh the answer is - it decides
// how long a tab that nobody reloads keeps showing yesterday's answer. Half an
// hour costs one request against our own cache.
const VERSION_POLL_MS = 30 * 60 * 1000

// useVersion feeds the About panel and the update hint in the rail. Fresh for
// six hours, and asked again on that interval: a dashboard left open for days
// used to learn about a new build only when someone reloaded the page.
export function useVersion(enabled = true) {
  return useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: () => api.get('/api/version'),
    enabled,
    staleTime: 6 * 60 * 60 * 1000,
    refetchInterval: VERSION_POLL_MS,
    refetchIntervalInBackground: false, // a hidden tab has nobody to tell
    refetchOnWindowFocus: true, // coming back to the tab is a good moment
    retry: false,
  })
}

// useUpdateHint is the version info while a newer build is out, for admins
// only: they are the ones who deploy, everyone else can do nothing with it.
export function useUpdateHint() {
  const { data: user } = useAuth()
  const { data } = useVersion(!!user?.isAdmin)
  return data?.updateAvailable ? data : undefined
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

// A clock for countdowns: re-renders at every full step, a minute by default,
// aligned to the step so "in 24 min" turns over on the minute and never a
// reload away. A second for the entries whose countdown shows seconds.
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let id = 0
    const arm = () => {
      id = window.setTimeout(() => {
        setNow(Date.now())
        arm()
      }, stepMs - (Date.now() % stepMs))
    }
    arm()
    return () => clearTimeout(id)
  }, [stepMs])
  return now
}
