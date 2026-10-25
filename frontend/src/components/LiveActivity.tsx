import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Slot } from 'fluid-lycoris'
import { api, downloadLabel, fmtSpeed, type Download, type DownloadMeta, type Watch } from '../api'
import { countdown } from '../countdown'
import { useLive } from './liveState'
import { useFailToast } from './toast'
import { useTransfers } from './transfers'

// ring geometry, in px: Firefox ignores a unitless stroke-dashoffset
const R = 16
const C = 2 * Math.PI * R
// how far the page has to scroll down before the pill folds to its ring
const SHRINK_PX = 24

/**
 * What is transferring right now, wherever the user is: a pill riding the
 * bottom edge of the page on a phone, a block at the foot of the sidebar on a
 * desktop (shell.css). A ring fills with the bytes of the whole queue, the
 * line says how many and how fast, and rolls when it changes.
 *
 * - running or waiting: a tap opens the transfers (the pill grows into their
 *   sheet, the sidebar's block opens their panel);
 * - everything paused: a tap resumes the queue;
 * - the queue ran dry: the ring closes into a check and the line names the
 *   episode that landed last; a tap opens its series. Then it leaves. The
 *   finished state lives in the shell (LiveProvider), so it survives a
 *   change of page.
 *
 * On a phone the pill folds to its ring while the page scrolls down and
 * comes back on the way up. Reads the shared ['downloads'] query.
 */
export function LiveActivity({ variant }: { variant: 'pill' | 'rail' }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fail = useFailToast()
  const transfers = useTransfers()
  const { landed, openSeries } = useLive()
  const q = useQuery({ queryKey: ['downloads'], queryFn: () => api.get<Download[]>('/api/downloads') })
  const all = q.data ?? []
  const active = all.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
  const running = active.filter((d) => d.status === 'running')
  const paused = active.length > 0 && active.every((d) => d.status === 'paused')
  // the check only while the queue stays empty: a new download ends it
  const done = active.length === 0 ? landed : null
  // the series and episode of what landed, only asked for once something did
  const { data: meta } = useQuery<DownloadMeta>({
    queryKey: ['downloads', 'meta'],
    queryFn: () => api.get('/api/downloads/meta'),
    staleTime: 60_000,
    enabled: !!done,
  })
  const { data: watches } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    enabled: !!done,
  })

  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  const small = useShrink(button, variant === 'pill')

  const size = active.reduce((s, d) => s + d.size, 0)
  const got = active.reduce((s, d) => s + d.transferred, 0)
  const frac = done ? 1 : size > 0 ? Math.min(1, got / size) : 0
  const rate = running.reduce((s, d) => s + (d.bytesPerSec ?? 0), 0)
  const left = rate > 0 ? (size - got) / rate : 0

  // what landed last, by name, and where its series lives
  const last = done ? downloadLabel(done.last, meta) : undefined
  const watch = last?.group?.watchId ? watches?.find((w) => w.id === last.group!.watchId) : undefined
  const series =
    done && openSeries && watch?.media
      ? () =>
          openSeries({
            source: watch.mediaSource,
            id: watch.media!.id,
            media: watch.media,
            watchId: watch.id,
          })
      : undefined

  let line: string
  let sub: string
  if (done) {
    line =
      done.count === 1 && last?.group?.title && last.ep
        ? t('live.landed', { title: last.group.title, ep: last.ep })
        : t('live.done', { count: done.count })
    sub = series ? t('live.tapToWatch') : t('live.doneSub')
  } else if (paused) {
    line = t('live.pausedAll')
    sub = t('live.tapToResume')
  } else {
    line =
      running.length > 0 ? t('live.loading', { count: active.length }) : t('live.waiting', { count: active.length })
    sub =
      rate > 0
        ? `${fmtSpeed(rate)} · ${countdown(t, q.dataUpdatedAt / 1000 + left, left < 60, q.dataUpdatedAt)}`
        : t('live.paused')
  }
  // the line rolls one step on every change of what it says
  const [roll, setRoll] = useState({ text: line, step: 0 })
  if (roll.text !== line) setRoll({ text: line, step: roll.step + 1 })
  if (active.length === 0 && !done) return null

  const resume = () =>
    api
      .post('/api/downloads/bulk', { action: 'resume', ids: [] })
      .then(() => qc.invalidateQueries({ queryKey: ['downloads'] }), fail)

  const ring = (
    <span className="t-live-ring-box relative inline-grid size-10 shrink-0 place-items-center" aria-hidden>
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
  const opensTransfers = !done && !paused
  // the label first, the ring at the end: the eye reads what, then how far
  return (
    <button
      ref={setButton}
      type="button"
      aria-label={`${line}, ${sub}`}
      aria-haspopup={opensTransfers ? 'dialog' : undefined}
      aria-expanded={variant === 'rail' && opensTransfers ? transfers.shown : undefined}
      data-small={small || undefined}
      data-state={done ? 'done' : paused ? 'paused' : undefined}
      onClick={(e) => {
        if (done) {
          if (series) series()
          else transfers.open(e.currentTarget)
        } else if (paused) void resume()
        else transfers.open(e.currentTarget)
      }}
      className={`t-live t-live--${variant}`}
    >
      <span className="t-live-lbl">
        <Slot step={roll.step} className="t-live-line">
          <span>{line}</span>
        </Slot>
        <span className="t-live-rate">{sub}</span>
      </span>
      {ring}
    </button>
  )
}

/**
 * Folds the pill to its ring while the page scrolls down and brings it back
 * on the way up: the scroller is the <main> around it (a phone's), and only a
 * run of SHRINK_PX in one direction flips it, so a jittering finger does not.
 */
function useShrink(el: HTMLElement | null, on: boolean) {
  const [small, setSmall] = useState(false)
  useEffect(() => {
    const main = el?.closest('main')
    if (!on || !main) return
    let last = main.scrollTop
    let run = 0
    const onScroll = () => {
      const y = main.scrollTop
      const d = y - last
      last = y
      run = Math.sign(d) === Math.sign(run) ? run + d : d
      if (run > SHRINK_PX && y > SHRINK_PX) setSmall(true)
      else if (run < -SHRINK_PX || y <= 0) setSmall(false)
    }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [el, on])
  return small
}
