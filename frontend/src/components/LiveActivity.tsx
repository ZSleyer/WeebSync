import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, fmtSpeed, type Download } from '../api'
import { countdown } from '../countdown'
import { useTransfers } from './transfers'

// how long the finished state stays up before the activity folds away
const DONE_MS = 4000
// ring geometry, in px: Firefox ignores a unitless stroke-dashoffset
const R = 16
const C = 2 * Math.PI * R

/**
 * What is transferring right now, wherever the user is: a pill riding the
 * bottom edge of the page on a phone, a block at the foot of the sidebar on a
 * desktop (shell.css). A ring
 * fills with the bytes of the whole queue, the line says how many and how
 * fast. When the queue runs dry the ring closes into a check for a moment,
 * then the activity leaves. Both open the transfers: the pill grows into
 * their sheet, the sidebar's block opens their panel.
 * Reads the shared ['downloads'] query, so it costs no request of its own.
 */
export function LiveActivity({ variant }: { variant: 'pill' | 'rail' }) {
  const { t } = useTranslation()
  const transfers = useTransfers()
  const q = useQuery({ queryKey: ['downloads'], queryFn: () => api.get<Download[]>('/api/downloads') })
  const all = q.data ?? []
  const active = all.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
  const running = active.filter((d) => d.status === 'running')
  // the finished moment: the queue had something and now has nothing. It
  // counts what of that queue actually landed; a queue that was canceled
  // away just leaves, without a check it did not earn
  const seen = useRef(new Set<number>())
  const [landed, setLanded] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    const now = q.data ?? []
    const live = now.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
    if (live.length > 0) {
      live.forEach((d) => seen.current.add(d.id))
      return
    }
    if (seen.current.size === 0) return
    const count = now.filter((d) => seen.current.has(d.id) && d.status === 'done').length
    seen.current = new Set()
    if (count === 0) return
    setLanded(count)
    // not cleared by the next poll: the list refreshes every second
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setLanded(0), DONE_MS)
  }, [q.data])
  useEffect(() => () => clearTimeout(timer.current), [])
  // the check only while the queue stays empty: a new download ends it
  const done = active.length === 0 ? landed : 0
  if (active.length === 0 && !done) return null

  const size = active.reduce((s, d) => s + d.size, 0)
  const got = active.reduce((s, d) => s + d.transferred, 0)
  const frac = done ? 1 : size > 0 ? Math.min(1, got / size) : 0
  const rate = running.reduce((s, d) => s + (d.bytesPerSec ?? 0), 0)
  const left = rate > 0 ? (size - got) / rate : 0
  const line = done
    ? t('live.done', { count: done })
    : running.length > 0
      ? t('live.loading', { count: active.length })
      : t('live.waiting', { count: active.length })
  const sub = done
    ? t('live.doneSub')
    : rate > 0
      ? `${fmtSpeed(rate)} · ${countdown(t, q.dataUpdatedAt / 1000 + left, left < 60, q.dataUpdatedAt)}`
      : t('live.paused')

  const ring = (
    <span className="relative inline-grid size-10 shrink-0 place-items-center" aria-hidden>
      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90">
        <circle cx="20" cy="20" r={R} fill="none" strokeWidth="3" className="stroke-border-subtle" />
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${C}px`}
          strokeDashoffset={`${C * (1 - frac)}px`}
          className={`t-live-ring ${done ? 'stroke-ok' : 'stroke-accent'}`}
        />
      </svg>
      {done ? (
        <Check size="1em" className="t-live-check text-ok" />
      ) : (
        <span className="t-live-count">{active.length}</span>
      )}
    </span>
  )
  // the label first, the ring at the end: the eye reads what, then how far
  return (
    <button
      type="button"
      aria-label={`${line}, ${sub}`}
      aria-haspopup="dialog"
      aria-expanded={variant === 'rail' ? transfers.shown : undefined}
      onClick={(e) => transfers.open(e.currentTarget)}
      className={`t-live t-live--${variant}`}
    >
      <span className="t-live-lbl">
        <span className="t-live-line">{line}</span>
        <span className="t-live-rate">{sub}</span>
      </span>
      {ring}
    </button>
  )
}
