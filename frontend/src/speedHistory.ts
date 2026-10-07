import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Download } from './api'

// The last ten minutes of total download speed, one sample per second, kept
// at module level so the dashboard's chart is full the moment the page is
// opened rather than starting over on every visit. The server keeps the same
// window, and the sampler starts from it, so a reload or another device does
// not start from an empty line either. Fed by the root layout, read by the
// one panel that draws it.

export const SPEED_SPAN = 600

let samples: number[] = []
let lastAt = 0 // wall-clock second of the newest sample
const listeners = new Set<() => void>()

/** Newest sample last. A new array per push, so a store snapshot stays stable between pushes. */
export function speedSamples() {
  return samples
}

/**
 * Append one second's speed. A gap since the last sample - a background tab
 * throttles the timer to about once a minute - is filled with zeros, so the
 * strip is always a true 60 seconds and never a squeezed history.
 */
export function pushSpeedSample(bps: number, now = Date.now()) {
  const sec = Math.floor(now / 1000)
  if (lastAt && sec <= lastAt) return
  const gap = lastAt ? Math.min(sec - lastAt - 1, SPEED_SPAN) : 0
  samples = [...samples, ...Array.from({ length: gap }, () => 0), bps].slice(-SPEED_SPAN)
  lastAt = sec
  listeners.forEach((l) => l())
}

/**
 * Take the server's history as the base: it was sampled while this page
 * was closed or in the background. Samples recorded here after the
 * server's last second stay on top, so a slow response loses nothing.
 */
export function seedSpeedHistory(server: number[], end: number) {
  const newer = lastAt > end ? samples.slice(-(lastAt - end)) : []
  samples = [...server, ...newer].slice(-SPEED_SPAN)
  lastAt = Math.max(lastAt, end)
  listeners.forEach((l) => l())
}

/** Mean of the newest n samples, 0 before there are any: the ETA's speed. */
export function avgSpeed(n = 10) {
  const tail = samples.slice(-n)
  return tail.length ? tail.reduce((s, v) => s + v, 0) / tail.length : 0
}

/** For tests. */
export function resetSpeedHistory() {
  samples = []
  lastAt = 0
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useSpeedHistory() {
  return useSyncExternalStore(subscribe, speedSamples, speedSamples)
}

/**
 * The sampler, mounted once in the root layout. It observes the downloads
 * query itself rather than peeking at the cache: away from the dashboard
 * nothing else does, and an unobserved query stops polling, drops the
 * event stream's patches and is collected after a few minutes - which would
 * record a dip that never happened. Samples every second, zeros included,
 * so an idle minute reads as a flat line and not as a frozen one.
 */
export function useSpeedSampler(enabled: boolean) {
  const { data } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
    enabled,
  })
  // the server's window as the base, again whenever the page comes back
  // into focus: a background tab samples about once a minute
  const { data: history } = useQuery<{ samples: number[]; end: number }>({
    queryKey: ['speed-history'],
    queryFn: () => api.get('/api/downloads/speed'),
    enabled,
    staleTime: 30_000,
  })
  useEffect(() => {
    if (history) seedSpeedHistory(history.samples, history.end)
  }, [history])
  const total = (data ?? []).reduce((s, d) => s + (d.status === 'running' ? (d.bytesPerSec ?? 0) : 0), 0)
  // the interval reads the newest total through a ref, so it is not torn
  // down and set up again on every progress tick
  const latest = useRef(total)
  useEffect(() => {
    latest.current = total
  }, [total])
  useEffect(() => {
    if (!enabled) return
    const tick = () => pushSpeedSample(latest.current)
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [enabled])
}
