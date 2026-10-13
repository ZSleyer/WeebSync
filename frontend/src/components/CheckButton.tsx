import { useQuery } from '@tanstack/react-query'
import { Button, Slot } from 'fluid-lycoris'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
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
  const { data: downloads = [] } = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<Download[]>('/api/downloads'),
    enabled: phase.k === 'follow',
  })
  const mine = phase.k === 'follow' ? downloads.filter((d) => phase.ids.includes(d.id)) : []
  const ended = (d: Download) => d.status === 'done' || d.status === 'error' || d.status === 'canceled'
  const finished = mine.filter(ended).length
  const all = phase.k === 'follow' && mine.length > 0 && finished === mine.length
  const size = mine.reduce((s, d) => s + d.size, 0)
  const got = mine.reduce((s, d) => s + (ended(d) ? d.size : d.transferred), 0)
  const frac = all ? 1 : size > 0 ? got / size : 0
  useEffect(() => {
    if (!all) return
    const id = setTimeout(() => setPhase({ k: 'idle' }), SETTLE_MS)
    return () => clearTimeout(id)
  }, [all])

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
            : t('watch.checkLoading', { k: Math.min(finished + 1, phase.ids.length), n: phase.ids.length })
          : (idleLabel ?? t('watch.checkNow'))
  // the roll steps with every change of what the button says
  const step =
    phase.k === 'idle' ? 0 : phase.k === 'checking' ? 1 : phase.k === 'none' ? 2 : 3 + finished + (all ? 1 : 0)
  if (variant === 'sync') {
    const state = all ? 'done' : phase.k === 'checking' || phase.k === 'follow' ? 'run' : 'idle'
    return (
      <button
        type="button"
        className="ws-syncbtn"
        data-state={state}
        onClick={run}
        aria-busy={state === 'run'}
        style={{ '--p': frac } as CSSProperties}
      >
        <span aria-hidden className="ws-syncbtn-fill" />
        <span role="status">
          <Slot step={step}>{all ? t('series.sync.allHere') : label}</Slot>
        </span>
      </button>
    )
  }
  return (
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
      <span className="relative" role="status">
        <Slot step={step}>{label}</Slot>
      </span>
    </Button>
  )
}
