import { useQuery } from '@tanstack/react-query'
import { Button, Slot } from 'fluid-lycoris'
import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Download } from '../api'
import type { useWatchActions } from './watchActions'

// how long "nothing new" or "all downloaded" stays before the button is a
// button again
const SETTLE_MS = 3000

type Phase = { k: 'idle' } | { k: 'checking' } | { k: 'none' } | { k: 'follow'; ids: number[] }

/**
 * "Check now" that turns into the progress of what it started: it says it is
 * asking the server, then fills with the downloads the check queued and rolls
 * "episode 2 of 3" along, and settles on "all downloaded". A check that finds
 * nothing says so for a moment. The downloads come from the shared query the
 * event stream patches, so following costs no request.
 */
export function CheckButton({
  watchId,
  act,
  variant,
  label: idleLabel,
}: {
  watchId: number
  act: ReturnType<typeof useWatchActions>
  /** the series page's full-width teal "load the missing episodes" button */
  variant?: 'sync'
  /** what the button says at rest, instead of "Check now" */
  label?: string
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const {
    data: downloads = [],
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<Download[]>('/api/downloads'),
    enabled: phase.k === 'follow',
  })
  const mine = phase.k === 'follow' ? downloads.filter((d) => phase.ids.includes(d.id)) : []
  const finished = mine.filter((d) => d.status === 'done' || d.status === 'error' || d.status === 'canceled').length
  const failed = mine.filter((d) => d.status === 'error' || d.status === 'canceled').length
  const ended = phase.k === 'follow' && mine.length > 0 && finished === mine.length
  // "all here" is for downloads that arrived; a failed one ends the run in its own state
  const all = ended && failed === 0
  const bad = ended && failed > 0
  const size = mine.reduce((s, d) => s + d.size, 0)
  const got = mine.reduce((s, d) => s + (d.status === 'done' ? d.size : d.transferred), 0)
  const frac = all ? 1 : size > 0 ? got / size : 0
  useEffect(() => {
    if (!ended) return
    const id = setTimeout(() => setPhase({ k: 'idle' }), bad ? SETTLE_MS * 2 : SETTLE_MS)
    return () => clearTimeout(id)
  }, [ended, bad])

  // rows the user removed while following: once the list is fresh and none of
  // ours is left, there is nothing to follow - the button is a button again
  const since = useRef(0)
  const seen = useRef(false)
  useEffect(() => {
    if (phase.k !== 'follow') {
      since.current = Date.now()
      seen.current = false
      return
    }
    if (mine.length > 0) seen.current = true
    else if (!isFetching && (seen.current || dataUpdatedAt >= since.current)) setPhase({ k: 'idle' })
  }, [phase.k, mine.length, isFetching, dataUpdatedAt])

  const run = async () => {
    if (phase.k !== 'idle') return
    setPhase({ k: 'checking' })
    const out = await act.check(watchId)
    // only an answered check can say "nothing new": a queued one ("checking")
    // or a failed one leaves the button as it was
    const answered = out?.status === 'checked' && !out.error
    if (!answered || !out.queued?.length) {
      setPhase(answered ? { k: 'none' } : { k: 'idle' })
      if (answered) setTimeout(() => setPhase({ k: 'idle' }), SETTLE_MS)
      return
    }
    setPhase({ k: 'follow', ids: out.queued })
  }
  const label =
    phase.k === 'checking'
      ? t('watch.checking')
      : phase.k === 'none'
        ? t('watch.checkNothing')
        : phase.k === 'follow'
          ? all
            ? t('watch.checkDone', { count: mine.length })
            : bad
              ? t('watch.checkFailedDl', { count: failed })
              : t('watch.checkLoading', {
                  k: Math.min(finished + 1, mine.length || 1),
                  n: mine.length || phase.ids.length,
                })
          : (idleLabel ?? t('watch.checkNow'))
  // the roll steps with every change of what the button says
  const step =
    phase.k === 'idle' ? 0 : phase.k === 'checking' ? 1 : phase.k === 'none' ? 2 : 3 + finished + (ended ? 1 : 0)
  // a button's children are presentational, so a live region inside it is not
  // announced: the progress is spoken from a region beside it (nothing at rest)
  const spoken = phase.k === 'idle' ? '' : all && variant === 'sync' ? t('series.sync.allHere') : label
  const live = (
    <span role="status" className="sr-only">
      {spoken}
    </span>
  )
  if (variant === 'sync') {
    const state = all ? 'done' : bad ? 'error' : phase.k === 'checking' || phase.k === 'follow' ? 'run' : 'idle'
    return (
      <>
        <button
          type="button"
          className="ws-syncbtn"
          data-state={state}
          onClick={run}
          aria-busy={state === 'run'}
          style={{ '--p': frac } as CSSProperties}
        >
          <span aria-hidden className="ws-syncbtn-fill" />
          <span>
            <Slot step={step}>{all ? t('series.sync.allHere') : label}</Slot>
          </span>
        </button>
        {live}
      </>
    )
  }
  return (
    <>
      <Button
        size="sm"
        onClick={run}
        aria-busy={phase.k === 'checking' || (phase.k === 'follow' && !all)}
        className="relative overflow-hidden"
      >
        {phase.k === 'follow' && (
          <span
            aria-hidden
            className="t-check-fill absolute inset-0 origin-left bg-accent/20"
            style={{ transform: `scaleX(${frac})` }}
          />
        )}
        <RefreshCw
          aria-hidden
          size="1em"
          className={`relative mr-1 inline align-[-0.125em] ${phase.k === 'checking' ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
        <span className="relative">
          <Slot step={step}>{label}</Slot>
        </span>
      </Button>
      {live}
    </>
  )
}
