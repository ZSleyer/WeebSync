import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Pause, PictureInPicture2, Play, X } from 'lucide-react'
import { IconButton, useMediaQuery } from 'fluid-lycoris'
import { useAudio } from './AudioPlayer'
import { WIDE_MQ } from './PageActions'
import { playHref } from './playLinks'
import './video.css'

/** What plays: a file on a server (0 is the local library). */
export interface VideoItem {
  server: number
  path: string
}

/** What the mini player shows of the file, as the player names it. */
export interface VideoLabel {
  title: string
  sub: string
}

interface Video {
  item: VideoItem | null
  /** plays a file, or keeps playing it when it is the one already playing */
  start: (item: VideoItem) => void
  /** stops and lets go of the file; the player keeps its position */
  close: () => void
  /** the one video element of the app: made once, moved, never remounted */
  video: HTMLVideoElement
  /**
   * The box around the player, the element that goes fullscreen. It moves
   * between the player page and the mini player; React renders into it
   * wherever it stands.
   */
  host: HTMLDivElement
  /** puts the player into an element until the returned call gives it back */
  claim: (slot: HTMLElement) => () => void
  /** on the player page: the mini player stays away, the page has it all */
  onPage: boolean
  paused: boolean
  /** the picture floats in its own window */
  inPip: boolean
  label: VideoLabel
  setLabel: (l: VideoLabel) => void
  /** the player's own picture-in-picture switch */
  togglePip: () => void
  /** the player hands its switch in (and null as it goes) */
  setPip: (fn: (() => void) | null) => void
}

const Ctx = createContext<Video | null>(null)

export const useVideo = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useVideo outside VideoProvider')
  return v
}

// hls.js, libass and the controls are megabytes: they come in with the first
// video, as the player page always did
const PlayerSession = lazy(() => import('../pages/Player').then((m) => ({ default: m.PlayerSession })))

// a move inside the document keeps the element's state (focus, a running
// transition) where the browser can (Element.moveBefore, Chrome 133); a
// plain append is the fallback, and a playing video survives either
function move(to: Element, el: Element) {
  const m = (to as Element & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore
  if (m && to.isConnected && el.isConnected) {
    try {
      m.call(to, el, null)
      return
    } catch {
      // a node from another document, or one the browser will not move
    }
  }
  to.appendChild(el)
}

/**
 * The one video element of the app, above the routes, so an episode plays on
 * while the pages change. The player page shows it with all its controls; off
 * that page the same player shrinks into the mini player (sidebar foot on a
 * desktop, above the tabs on a phone), and the picture-in-picture window,
 * whose element never leaves the document, stays open across both.
 */
export function VideoProvider({ children }: { children: ReactNode }) {
  const [video] = useState(() => {
    const v = document.createElement('video')
    v.setAttribute('slot', 'media')
    return v
  })
  const [host] = useState(() => {
    const d = document.createElement('div')
    d.className = 't-player-page'
    // the video waits here while no player holds it (a file still loading)
    d.appendChild(video)
    return d
  })
  const park = useRef<HTMLDivElement>(null)
  const slots = useRef<HTMLElement[]>([])
  // the player stands in the latest slot that claimed it, else out of sight
  const place = useCallback(() => {
    const to = slots.current.at(-1) ?? park.current
    if (to && host.parentNode !== to) move(to, host)
  }, [host])
  const claim = useCallback(
    (slot: HTMLElement) => {
      slots.current.push(slot)
      place()
      return () => {
        slots.current = slots.current.filter((s) => s !== slot)
        place()
      }
    },
    [place],
  )
  useLayoutEffect(() => place(), [place])

  const [item, setItem] = useState<VideoItem | null>(null)
  const start = useCallback(
    (next: VideoItem) =>
      setItem((cur) => (cur && cur.server === next.server && cur.path === next.path ? cur : { ...next })),
    [],
  )
  const close = useCallback(() => {
    // the player saves the position as it goes, then lets go of the source
    video.pause()
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {})
    setItem(null)
  }, [video])

  const { pathname } = useLocation()
  const onPage = pathname === '/play'
  // off the page only the picture shows: nothing in it takes focus or a click
  useLayoutEffect(() => {
    host.toggleAttribute('data-mini', !onPage)
    host.toggleAttribute('inert', !onPage)
  }, [host, onPage])

  const [paused, setPaused] = useState(true)
  const [inPip, setInPip] = useState(false)
  useEffect(() => {
    const on = () => {
      setPaused(video.paused)
      setInPip(document.pictureInPictureElement === video)
    }
    const events = ['play', 'pause', 'emptied', 'ended', 'enterpictureinpicture', 'leavepictureinpicture']
    for (const e of events) video.addEventListener(e, on)
    return () => {
      for (const e of events) video.removeEventListener(e, on)
    }
  }, [video])

  // one thing plays at a time: a video stops the music, a track the video
  const audio = useAudio()
  const pauseAudio = useEffectEvent(() => {
    if (!audio.paused) audio.pause()
  })
  useEffect(() => {
    const onPlay = (e: Event) => {
      if (e.target === video) pauseAudio()
      else if (e.target instanceof HTMLMediaElement && !video.paused) video.pause()
    }
    // media events do not bubble; the capture phase sees them all (the video
    // never leaves the document: it waits in the hidden box when not shown)
    document.addEventListener('play', onPlay, true)
    return () => {
      document.removeEventListener('play', onPlay, true)
    }
  }, [video])

  // a file playing when the app goes (sign-out): it stops with it
  useEffect(
    () => () => {
      if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {})
    },
    [video],
  )

  const [label, setLabel] = useState<VideoLabel>({ title: '', sub: '' })
  const pip = useRef<(() => void) | null>(null)
  const setPip = useCallback((fn: (() => void) | null) => void (pip.current = fn), [])
  const togglePip = useCallback(() => pip.current?.(), [])
  const value = useMemo<Video>(
    () => ({ item, start, close, video, host, claim, onPage, paused, inPip, label, setLabel, togglePip, setPip }),
    [item, start, close, video, host, claim, onPage, paused, inPip, label, togglePip, setPip],
  )
  return (
    <Ctx.Provider value={value}>
      {children}
      <div ref={park} hidden className="t-player-park" />
      {item &&
        createPortal(
          <Suspense fallback={null}>
            <PlayerSession key={`${item.server}:${item.path}`} server={item.server} path={item.path} />
          </Suspense>,
          host,
        )}
    </Ctx.Provider>
  )
}

/**
 * The video playing, in reach from every page but its own: the picture with
 * its title in the sidebar's foot on a desktop, a card above the tabs on a
 * phone. Both sit in the page's flow, so nothing they hold covers the page
 * (WCAG 2.4.11). Only one of the two is ever drawn: the picture can stand in
 * one place only.
 */
export function VideoMini({ variant }: { variant: 'rail' | 'pill' }) {
  const { t } = useTranslation()
  const v = useVideo()
  const wide = useMediaQuery(WIDE_MQ)
  const navigate = useNavigate()
  const shown = !!v.item && !v.onPage && wide === (variant === 'rail')
  const slot = useRef<HTMLDivElement>(null)
  const { claim } = v
  useLayoutEffect(() => (shown && slot.current ? claim(slot.current) : undefined), [shown, claim])
  if (!shown || !v.item) return null
  const item = v.item
  const title = v.label.title || item.path.split('/').pop() || item.path
  const toggle = () => {
    if (v.video.paused) v.video.play().catch(() => {})
    else v.video.pause()
  }
  return (
    <div role="region" aria-label={t('video.nowPlaying')} className="ws-vmini" data-variant={variant}>
      {/* only a picture here: the player in it is inert, its region and
          controls are not for a screen reader to find in the card */}
      <div ref={slot} className="ws-vmini-pic" aria-hidden data-pip={v.inPip || undefined}>
        {/* Chrome paints "Playing in picture-in-picture" into the floated
            video, far too long for this picture: it fades, a mark stands in */}
        {v.inPip && <PictureInPicture2 className="ws-vmini-pipmark" />}
      </div>
      <div className="ws-vmini-row">
        {/* the whole card leads back to the player (the button stretches
            over the picture too); the source keeps playing on the way */}
        <button
          type="button"
          className="ws-vmini-open"
          aria-label={`${t('video.open')}: ${title}`}
          onClick={() => navigate(playHref(item.server, item.path))}
        >
          <span className="t">
            <strong>{title}</strong>
            {v.label.sub && <span>{v.label.sub}</span>}
          </span>
        </button>
        <IconButton
          size="sm"
          aria-label={v.paused ? t('player.play') : t('player.pause')}
          title={v.paused ? t('player.play') : t('player.pause')}
          onClick={toggle}
        >
          {v.paused ? <Play aria-hidden fill="currentColor" /> : <Pause aria-hidden fill="currentColor" />}
        </IconButton>
        {document.pictureInPictureEnabled && (
          <IconButton
            size="sm"
            aria-pressed={v.inPip}
            aria-label={t('player.pip')}
            title={t('player.pip')}
            onClick={v.togglePip}
          >
            <PictureInPicture2 aria-hidden />
          </IconButton>
        )}
        <IconButton size="sm" aria-label={t('video.close')} title={t('video.close')} onClick={v.close}>
          <X aria-hidden />
        </IconButton>
      </div>
    </div>
  )
}
