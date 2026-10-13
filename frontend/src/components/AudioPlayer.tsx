import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Music, Pause, Play, SkipForward, X } from 'lucide-react'
import { IconButton } from '@weebsync/design-system'
import type { Entry } from '../api'
import { useStored } from '../hooks/useStored'
import { streamUrl, viewHref } from './playLinks'

/** What plays: a folder's tracks in order, one of them now. */
export interface Queue {
  server: number
  tracks: Entry[]
  at: number
  album: string
  cover?: string
}
export type Repeat = 'off' | 'all' | 'one'
/** minutes from when it was set, or the end of the track playing */
export type Sleep = number | 'track' | null

interface Audio {
  queue: Queue | null
  track: Entry | null
  paused: boolean
  time: number
  duration: number
  rate: number
  repeat: Repeat
  sleep: Sleep
  start: (q: Queue) => void
  go: (at: number) => void
  toggle: () => void
  seek: (s: number) => void
  stop: () => void
  setRate: (r: number) => void
  setRepeat: (r: Repeat) => void
  setSleep: (s: Sleep) => void
}

const Ctx = createContext<Audio | null>(null)

export const useAudio = () => {
  const a = useContext(Ctx)
  if (!a) throw new Error('useAudio outside AudioProvider')
  return a
}

const pad = (n: number) => String(n).padStart(2, '0')
export const clock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${pad(m)}` : m}:${pad(Math.floor(s % 60))}`
}

// a long file (an audiobook) resumes where it was left; a song starts at the start
const LONG = 20 * 60
const posKey = (server: number, path: string) => `viewer.pos:${server}:${path}`

// the track page of what plays, open right now
const onPageOf = (pathname: string, search: string, path: string) =>
  pathname === '/view' && new URLSearchParams(search).get('path') === path

/**
 * The one audio element of the app, above the routes, so a track plays on
 * while the pages change. The track page drives it, the mini player keeps it
 * in reach everywhere else, and the lock screen and headset buttons reach it
 * through the Media Session.
 */
export function AudioProvider({ children }: { children: ReactNode }) {
  const el = useRef<HTMLAudioElement>(null)
  const [queue, setQueue] = useState<Queue | null>(null)
  const [paused, setPaused] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useStored<number>('viewer.rate', 1)
  const [repeat, setRepeat] = useStored<Repeat>('viewer.repeat', 'off')
  const [sleep, setSleep] = useState<Sleep>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const track = queue ? queue.tracks[queue.at] : null

  const go = (at: number) => {
    if (!queue || at < 0 || at >= queue.tracks.length) return
    // the track page follows the queue, in place of the track before
    if (track && onPageOf(location.pathname, location.search, track.path))
      navigate(viewHref(queue.server, queue.tracks[at].path), { replace: true })
    setQueue({ ...queue, at })
  }
  const toggle = () => {
    const a = el.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }
  const stop = () => {
    el.current?.pause()
    setQueue(null)
    setSleep(null)
  }

  // the sleep timer: a while from now, or when the track ends (onEnded)
  useEffect(() => {
    if (typeof sleep !== 'number') return
    const id = setTimeout(() => {
      el.current?.pause()
      setSleep(null)
    }, sleep * 60_000)
    return () => clearTimeout(id)
  }, [sleep])

  useEffect(() => {
    if (el.current) el.current.playbackRate = rate
  }, [rate, track])

  const lastSave = useRef(0)
  const onTime = () => {
    const a = el.current
    if (!a || !queue || !track) return
    setTime(a.currentTime)
    if (a.duration < LONG || Date.now() - lastSave.current < 5000) return
    lastSave.current = Date.now()
    try {
      localStorage.setItem(posKey(queue.server, track.path), String(Math.floor(a.currentTime)))
    } catch {
      // not remembered
    }
  }
  const onMeta = () => {
    const a = el.current
    if (!a || !queue || !track) return
    setDuration(a.duration)
    a.playbackRate = rate
    if (a.duration < LONG) return
    try {
      const s = Number(localStorage.getItem(posKey(queue.server, track.path)))
      if (s > 0 && s < a.duration - 5) a.currentTime = s
    } catch {
      // from the start
    }
  }
  const onEnded = () => {
    const a = el.current
    if (!a || !queue) return
    if (sleep === 'track') {
      setSleep(null)
      return
    }
    if (repeat === 'one') {
      a.currentTime = 0
      a.play().catch(() => {})
    } else if (queue.at + 1 < queue.tracks.length) go(queue.at + 1)
    else if (repeat === 'all') go(0)
  }

  // the lock screen and the headset buttons
  const actions = useEffectEvent((action: MediaSessionAction, d: MediaSessionActionDetails) => {
    if (action === 'play' || action === 'pause') toggle()
    else if (action === 'previoustrack' && queue) go(queue.at - 1)
    else if (action === 'nexttrack' && queue) go(queue.at + 1)
    else if (action === 'seekto' && el.current && d.seekTime !== undefined) el.current.currentTime = d.seekTime
  })
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (!queue || !track) {
      ms.metadata = null
      return
    }
    ms.metadata = new MediaMetadata({
      title: track.name.replace(/\.[^.]+$/, ''),
      album: queue.album,
      artwork: queue.cover ? [{ src: queue.cover }] : [],
    })
    const all: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']
    for (const a of all) {
      try {
        ms.setActionHandler(a, (d) => actions(a, d))
      } catch {
        // an action this browser does not know
      }
    }
  }, [queue, track])

  const audio: Audio = {
    queue,
    track,
    paused,
    time,
    duration,
    rate,
    repeat,
    sleep,
    start: (q) => {
      setTime(0)
      setDuration(0)
      setQueue(q)
    },
    go,
    toggle,
    seek: (s) => {
      if (el.current) el.current.currentTime = s
    },
    stop,
    setRate,
    setRepeat,
    setSleep,
  }
  return (
    // the value moves with the clock several times a second anyway, so a memo
    // would only add a list of deps
    // eslint-disable-next-line react/jsx-no-constructed-context-values
    <Ctx.Provider value={audio}>
      {children}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- music and audiobooks carry no captions */}
      <audio
        ref={el}
        src={queue && track ? streamUrl(queue.server, track.path) : undefined}
        // a track only gets here because it was asked for
        autoPlay
        preload="metadata"
        hidden
        onLoadedMetadata={onMeta}
        onTimeUpdate={onTime}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={onEnded}
      />
    </Ctx.Provider>
  )
}

/**
 * What plays, in reach from every page: in the sidebar on a desktop, above
 * the tabs on a phone. Gone on the track's own page, which has it all.
 */
export function MiniPlayer({ variant }: { variant: 'rail' | 'pill' }) {
  const { t } = useTranslation()
  const a = useAudio()
  const { pathname, search } = useLocation()
  if (!a.queue || !a.track || onPageOf(pathname, search, a.track.path)) return null
  const q = a.queue
  const title = a.track.name.replace(/\.[^.]+$/, '')
  const pill = variant === 'pill'
  const link = (
    <Link
      to={viewHref(q.server, a.track.path)}
      className={`flex min-w-0 flex-1 items-center gap-2 ${pill ? 'rounded-full' : 'rounded-sm'}`}
    >
      {q.cover ? (
        <img src={q.cover} alt="" className={`size-9 shrink-0 object-cover ${pill ? 'rounded-full' : 'rounded-sm'}`} />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center text-t-muted" aria-hidden>
          <Music size="1.1em" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block max-w-48 truncate text-sm font-medium">{title}</span>
        <span className="block max-w-48 truncate text-ctl-sm tabular-nums text-t-secondary">
          {clock(a.time)}
          {a.duration > 0 && ` / ${clock(a.duration)}`}
        </span>
      </span>
    </Link>
  )
  const controls = (
    <>
      <IconButton aria-label={a.paused ? t('player.play') : t('player.pause')} onClick={a.toggle}>
        {a.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
      </IconButton>
      {!pill && q.at + 1 < q.tracks.length && (
        <IconButton aria-label={t('viewer.nextTrack')} onClick={() => a.go(q.at + 1)}>
          <SkipForward aria-hidden />
        </IconButton>
      )}
      <IconButton aria-label={t('viewer.stop')} onClick={a.stop}>
        <X aria-hidden />
      </IconButton>
    </>
  )
  // the sidebar is narrow: the title gets the row, the buttons the one below
  return pill ? (
    <div
      role="region"
      aria-label={t('viewer.nowPlaying')}
      className="mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-border-subtle bg-bg-card p-1 lg:hidden"
    >
      {link}
      {controls}
    </div>
  ) : (
    <div
      role="region"
      aria-label={t('viewer.nowPlaying')}
      className="mx-3 mb-2 grid gap-1 rounded-md border border-border-subtle bg-bg-card p-2"
    >
      {link}
      <div className="flex justify-end gap-1">{controls}</div>
    </div>
  )
}
