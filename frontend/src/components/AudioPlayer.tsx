import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Music, Pause, Play, SkipBack, SkipForward, Square, X } from 'lucide-react'
import { Dialog, IconButton, Select } from 'fluid-lycoris'
import type { Entry } from '../api'
import { useStored } from '../hooks/useStored'
import { streamUrl, viewHref } from './playLinks'
import './audio.css'

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
  /** the playback panel the mini player opens */
  panel: boolean
  setPanel: (open: boolean) => void
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
  const [panel, setPanel] = useState(false)
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
    setPanel(false)
  }

  // the root knows a track is loaded: the shell makes room for the mini player
  const loaded = !!queue
  useEffect(() => {
    if (!loaded) return
    const root = document.documentElement
    root.classList.add('has-audio')
    return () => root.classList.remove('has-audio')
  }, [loaded])

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
    panel,
    setPanel,
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
      {panel && queue && <AudioSheet onClose={() => setPanel(false)} />}
    </Ctx.Provider>
  )
}

const trackTitle = (e: Entry) => e.name.replace(/\.[^.]+$/, '')

/**
 * What plays, in reach from every page: a card above the tabs on a phone, in
 * the sidebar's foot on a desktop. Tapping it opens the playback panel; the
 * track's own page has it all and shows none. A thin line along its foot
 * runs with the track.
 */
export function MiniPlayer({ variant }: { variant: 'rail' | 'pill' }) {
  const { t } = useTranslation()
  const a = useAudio()
  const { pathname, search } = useLocation()
  if (!a.queue || !a.track || onPageOf(pathname, search, a.track.path)) return null
  const q = a.queue
  const share = a.duration > 0 ? Math.min(1, a.time / a.duration) : 0
  return (
    <div
      role="region"
      aria-label={t('viewer.nowPlaying')}
      className={`ws-mini ${variant === 'pill' ? 'lg:hidden' : ''}`}
      data-variant={variant}
    >
      <button type="button" className="ws-mini-open" aria-label={t('audio.open')} onClick={() => a.setPanel(true)}>
        {q.cover ? (
          <img src={q.cover} alt="" className="ws-mini-art" />
        ) : (
          <span className="ws-mini-art" aria-hidden>
            <Music size="1.1em" />
          </span>
        )}
        <span className="t">
          <strong>{trackTitle(a.track)}</strong>
          {q.album && <span>{q.album}</span>}
        </span>
      </button>
      <IconButton aria-label={a.paused ? t('player.play') : t('player.pause')} onClick={a.toggle}>
        {a.paused ? <Play aria-hidden fill="currentColor" /> : <Pause aria-hidden fill="currentColor" />}
      </IconButton>
      {q.at + 1 < q.tracks.length && (
        <IconButton className="ws-mini-next" aria-label={t('viewer.nextTrack')} onClick={() => a.go(q.at + 1)}>
          <SkipForward aria-hidden />
        </IconButton>
      )}
      <span aria-hidden className="ws-mini-prog" style={{ '--p': share } as CSSProperties} />
    </div>
  )
}

/** The panel the mini player opens: a bottom sheet on a phone, a dialog on a desktop. */
function AudioSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const a = useAudio()
  return (
    <Dialog width="max-w-lg" sheet aria-labelledby="ws-au-h" onClose={onClose}>
      <div className="dialog-body w-full bg-bg-card">
        <div className="ws-au-hd">
          <h2 id="ws-au-h">{t('audio.title')}</h2>
          <IconButton
            aria-label={t('viewer.stop')}
            title={t('viewer.stop')}
            onClick={() => {
              a.stop()
              onClose()
            }}
          >
            <Square aria-hidden size="1em" />
          </IconButton>
          <IconButton aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
            <X aria-hidden size="1.1em" />
          </IconButton>
        </div>
        <div className="ws-au-sheet min-h-0 overflow-y-auto">
          <AudioPanel />
        </div>
      </div>
    </Dialog>
  )
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
const REPEAT_NEXT: Record<Repeat, Repeat> = { off: 'all', all: 'one', one: 'off' }

/**
 * Playback of the queue: cover, title, position, the controls (back to the
 * start or the track before, 15 s back, play, 30 s on, the next track),
 * tempo, sleep timer, repeat, and the folder's tracks.
 */
export function AudioPanel({ heading }: { heading?: boolean }) {
  const { t, i18n } = useTranslation()
  const a = useAudio()
  const q = a.queue
  if (!q || !a.track) return null
  const at = q.at
  const num = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 })
  const sleepValue = a.sleep === null ? '' : String(a.sleep)
  const max = a.duration || 0
  const share = max > 0 ? Math.min(1, a.time / max) : 0
  const Title = heading ? 'h2' : 'h3'
  return (
    <div className="ws-au">
      {q.cover ? (
        <img className="ws-au-cover" src={q.cover} alt="" />
      ) : (
        <span className="ws-au-cover ws-au-cover--none" aria-hidden>
          <Music />
        </span>
      )}
      <div className="ws-au-meta">
        <Title>{trackTitle(a.track)}</Title>
        {q.album && <p>{q.album}</p>}
      </div>
      <input
        type="range"
        className="ws-au-scrub"
        min={0}
        max={max}
        step={1}
        value={Math.min(a.time, max)}
        style={{ '--p': share } as CSSProperties}
        onChange={(e) => a.seek(Number(e.target.value))}
        onKeyDown={(e) => {
          // the arrows step five seconds, as in the video player
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          a.seek(Math.min(max, Math.max(0, a.time + (e.key === 'ArrowRight' ? 5 : -5))))
        }}
        aria-label={t('viewer.position')}
        aria-valuetext={`${clock(a.time)} / ${clock(a.duration)}`}
      />
      <div className="ws-au-times" aria-hidden>
        <span>{clock(a.time)}</span>
        <span>{a.duration > 0 ? clock(a.duration) : ''}</span>
      </div>
      <div className="ws-au-ctl">
        <IconButton
          aria-label={t('viewer.prevTrack')}
          disabled={at <= 0 && a.time <= 3}
          // a few seconds in, back means the start of this one
          onClick={() => (a.time > 3 || at <= 0 ? a.seek(0) : a.go(at - 1))}
        >
          <SkipBack aria-hidden />
        </IconButton>
        <IconButton aria-label={t('audio.back15')} onClick={() => a.seek(Math.max(0, a.time - 15))}>
          <span className="ws-au-sk" aria-hidden>
            −15
          </span>
        </IconButton>
        <button
          type="button"
          className="ws-au-play"
          aria-label={a.paused ? t('player.play') : t('player.pause')}
          onClick={a.toggle}
        >
          {a.paused ? <Play aria-hidden fill="currentColor" /> : <Pause aria-hidden fill="currentColor" />}
        </button>
        <IconButton aria-label={t('audio.fwd30')} onClick={() => a.seek(Math.min(max, a.time + 30))}>
          <span className="ws-au-sk" aria-hidden>
            +30
          </span>
        </IconButton>
        <IconButton
          aria-label={t('viewer.nextTrack')}
          disabled={at >= q.tracks.length - 1}
          onClick={() => a.go(at + 1)}
        >
          <SkipForward aria-hidden />
        </IconButton>
      </div>
      <div className="ws-au-opts">
        <div>
          <label htmlFor="ws-au-rate">{t('viewer.speed')}</label>
          <Select id="ws-au-rate" size="sm" value={a.rate} onChange={(e) => a.setRate(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {num.format(r)}×
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="ws-au-sleep">{t('viewer.sleep')}</label>
          <Select
            id="ws-au-sleep"
            size="sm"
            value={sleepValue}
            onChange={(e) => {
              const v = e.target.value
              a.setSleep(v === '' ? null : v === 'track' ? 'track' : Number(v))
            }}
          >
            <option value="">{t('audio.sleepOff')}</option>
            {[15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {t('audio.minutes', { n: m })}
              </option>
            ))}
            <option value="track">{t('audio.sleepEnd')}</option>
          </Select>
        </div>
        <button
          type="button"
          className="t-link"
          aria-pressed={a.repeat !== 'off'}
          onClick={() => a.setRepeat(REPEAT_NEXT[a.repeat])}
        >
          {t('audio.repeat', { mode: t(`audio.repeat_${a.repeat}`) })}
        </button>
      </div>
      {q.tracks.length > 1 && (
        <>
          <h3 className="ws-au-h" id="ws-au-list">
            {t('audio.inFolder')}
          </h3>
          <ol className="ws-au-list" aria-labelledby="ws-au-list">
            {q.tracks.map((e, n) => (
              <li key={e.path}>
                <button type="button" aria-current={n === at ? 'true' : undefined} onClick={() => a.go(n)}>
                  <span className="n">{n + 1}</span>
                  <strong>{trackTitle(e)}</strong>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
