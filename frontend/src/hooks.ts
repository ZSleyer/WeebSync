import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type AiModels, type AiStatus, type Download, type User } from './api'
import i18n, { syncLocale } from './locales'

let localeSynced = false

/**
 * Signs out and reloads at the root: a full reload re-gates the app on a
 * fresh /api/auth/me (now 401) and drops every cached query of the previous
 * user (a plain cache reset raced the data router's re-render and left stale
 * content). `?loggedout`: in auto-redirect mode the login page would
 * otherwise send the user straight back to the provider, which signs them in
 * again.
 */
export async function logout() {
  try {
    await api.post('/api/auth/logout')
  } catch {
    // drop to the login screen either way: the user wants out
  }
  window.location.href = '/?loggedout=1'
}

export function useAuth() {
  return useQuery<User | null>({
    queryKey: ['me'],
    // who is signed in changes on login and logout, which reset this query;
    // a refetch on focus mid-wizard swapped the wizard for a fresh one at a
    // later step and lost what was typed. A session that ended elsewhere
    // shows through the 401 of the next request.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      try {
        const me = await api.get<User>('/api/auth/me')
        // one sync per app load, so the backend knows the language even if
        // the user never touches the switcher; only when it differs, not a
        // write on every page load
        if (!localeSynced) {
          localeSynced = true
          if (me.locale !== i18n.language) syncLocale(i18n.language)
        }
        return me
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
  })
}

// useProviders: which metadata providers have keys, for the source and
// ordering options. From the user query, since the settings are admin-only:
// for everyone else the options were always hidden behind a 403.
export function useProviders() {
  const { data } = useAuth()
  return { tvdbApiKeySet: !!data?.tvdbApiKeySet, tmdbApiKeySet: !!data?.tmdbApiKeySet }
}

// useWholeSave: a setting saved whole (the full list or object in one PUT)
// for a query key. Built from the rendered data, two quick toggles both sent
// the old state with one change each, and the later PUT undid the earlier.
// Here every change applies to the latest cached value at once, the PUTs run
// one after another, and once the last one settles the server's state is
// refetched, which also rolls a failed save back. Errors toast globally.
export function useWholeSave<T>(key: string, save: (next: T) => Promise<unknown>, onSettled?: () => void) {
  const qc = useQueryClient()
  const mutationKey = [key, 'save']
  const m = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(':') },
    mutationFn: save,
    onSettled: () => {
      // the settling save still counts as pending here
      if (qc.isMutating({ mutationKey }) > 1) return
      void qc.invalidateQueries({ queryKey: [key] })
      onSettled?.()
    },
  })
  return (change: (cur: T) => T) => {
    const cur = qc.getQueryData<T>([key])
    if (cur === undefined) return
    const next = change(cur)
    // a refetch already on its way would paint the old state over this one
    void qc.cancelQueries({ queryKey: [key] })
    qc.setQueryData([key], next)
    m.mutate(next)
  }
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

// updateText says what is out: the release by its number, a build by its
// channel and commit - "a new build" alone left open which one, and where.
export function updateText(t: (key: string, opts?: Record<string, unknown>) => string, v: VersionInfo): string {
  if (v.channel === 'stable') return t('about.updateStable', { version: v.latest })
  return t('about.updateBuild', { channel: t(`about.channel.${v.channel}`), sha: v.latest })
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
      id = window.setTimeout(
        () => {
          setNow(Date.now())
          arm()
        },
        stepMs - (Date.now() % stepMs),
      )
    }
    arm()
    return () => clearTimeout(id)
  }, [stepMs])
  return now
}

// fields that bring up the on-screen keyboard (pickers, toggles and sliders do not)
const TYPED =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="color"], [type="image"], [type="date"], [type="time"], [type="datetime-local"], [type="month"], [type="week"])'

/**
 * Whether a touch screen's keyboard is up. On Android the viewport resizes
 * with it (interactive-widget=resizes-content), so it is up while a text field
 * has focus and the viewport has lost a good part of its tallest height. Focus
 * alone is not enough: the back gesture closes the keyboard and leaves the
 * field focused. iOS does not resize the layout viewport, so this stays false
 * there.
 */
export function useKeyboardUp() {
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return
    let tall = innerHeight
    const check = () => {
      tall = Math.max(tall, innerHeight)
      setUp(innerHeight < tall * 0.8 && !!document.activeElement?.matches(TYPED))
    }
    // turning the phone changes what "tall" is
    const turned = () => (tall = 0)
    addEventListener('resize', check)
    addEventListener('focusin', check)
    addEventListener('focusout', check)
    screen.orientation?.addEventListener('change', turned)
    return () => {
      removeEventListener('resize', check)
      removeEventListener('focusin', check)
      removeEventListener('focusout', check)
      screen.orientation?.removeEventListener('change', turned)
    }
  }, [])
  return up
}
