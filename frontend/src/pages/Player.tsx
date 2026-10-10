import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import HlsPlayer from 'hls.js'
import JASSUB from 'jassub'
import { Captions } from 'lucide-react'
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlayButton,
  MediaPreviewTimeDisplay,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'
import {
  MediaChromeMenu,
  MediaChromeMenuItem,
  MediaPlaybackRateMenu,
  MediaSettingsMenu,
  MediaSettingsMenuButton,
  MediaSettingsMenuItem,
} from 'media-chrome/react/menu'
import type { MediaChromeMenu as ChromeMenuElement } from 'media-chrome/menu'
import type { MediaController as MediaControllerElement } from 'media-chrome'
import { addTranslation, setLanguage } from 'media-chrome/dist/utils/i18n.js'
import { De } from 'media-chrome/dist/lang/de.js'
import { api, keyConflictOf } from '../api'
import HostKeyPrompt from '../components/HostKeyPrompt'
import Loading from '../components/Loading'

interface PlayTrack {
  index: number
  codec: string
  lang?: string
  title?: string
  default?: boolean
  forced?: boolean
  channels?: number
  image?: boolean
  file?: string
}

interface PlayInfo {
  duration: number
  video?: { codec: string; profile?: string; pixFmt?: string; width: number; height: number }
  audio: PlayTrack[]
  subs: PlayTrack[]
  fonts: number[]
}

// the controls speak the app's language; media-chrome ships the German labels
// but only registers English itself
addTranslation('de', De)

// what the browser decodes on its own. canPlayType is only the first opinion:
// Firefox and Chrome both say "probably" about HEVC on machines that then decode
// no frame, so the watchdog below has the last word.
const DIRECT_CONTAINERS = new Set(['mkv', 'mp4', 'm4v', 'webm', 'mov'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

function canDecodeVideo(v: PlayInfo['video']): boolean {
  if (!v) return true // audio-only
  const tenBit = v.pixFmt?.includes('10') || v.pixFmt?.includes('12')
  const probe = document.createElement('video')
  switch (v.codec) {
    case 'h264':
      return !tenBit // Hi10P: no browser decodes it
    case 'vp8':
    case 'vp9':
    case 'av1':
      return true
    case 'hevc':
      return probe.canPlayType(`video/mp4; codecs="hvc1.${tenBit ? '2.4' : '1.6'}.L120.B0"`) !== ''
    default:
      return false
  }
}

// ffmpeg's codec names, as people know the formats
const CODEC_NAMES: Record<string, string> = {
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  subrip: 'SRT',
  mov_text: 'Text',
  webvtt: 'VTT',
  eac3: 'E-AC3',
  truehd: 'TrueHD',
}

function trackLabel(tr: PlayTrack, i: number): string {
  const codec = CODEC_NAMES[tr.codec] ?? tr.codec.toUpperCase()
  const bits = [tr.lang, tr.title && tr.title !== tr.lang ? tr.title : '', codec]
  return bits.filter(Boolean).join(' · ') || `#${i + 1}`
}

export default function Player() {
  const { t, i18n } = useTranslation()
  setLanguage(i18n.language)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const server = Number(params.get('server') || 0)
  const path = params.get('path') || ''
  const name = path.split('/').pop() || path
  const src = `server=${server}&path=${encodeURIComponent(path)}`

  const info = useQuery({
    queryKey: ['play-info', server, path],
    queryFn: () => api.get<PlayInfo>(`/api/play/info?${src}`),
    enabled: !!path,
    retry: false,
  })

  const [audio, setAudio] = useState<number | null>(null)
  const [sub, setSub] = useState<string | null>(null)
  // the watchdog saw the browser fail at a file it claimed it could play
  const [forceHls, setForceHls] = useState(false)

  const data = info.data
  const audioIdx = audio ?? (data?.audio.find((a) => a.default) ?? data?.audio[0])?.index ?? -1
  const subKey =
    sub ??
    (() => {
      // a full track in the default's language, never signs-only on its own
      const pick =
        data?.subs.find((s) => s.default && !s.forced && !s.image) ?? data?.subs.find((s) => !s.forced && !s.image)
      return pick ? subValue(pick) : 'none'
    })()
  const subTrack = data?.subs.find((s) => subValue(s) === subKey)
  const burn = subTrack?.image ? subTrack.index : -1

  const hls = useMemo(() => {
    if (!data) return false
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const a = data.audio.find((x) => x.index === audioIdx)
    return (
      forceHls ||
      !DIRECT_CONTAINERS.has(ext) ||
      !canDecodeVideo(data.video) ||
      (a && !DIRECT_AUDIO.has(a.codec)) ||
      // a browser plays the first audio track of a file and offers no other
      (a && a.index !== data.audio[0].index) ||
      burn >= 0
    )
  }, [data, path, audioIdx, burn, forceHls])

  const videoRef = useRef<HTMLVideoElement>(null)
  const resumeAt = useRef(0)
  const [mutedStart, setMutedStart] = useState(false)
  // the muted start ends with the first unmute, whichever control did it
  useEffect(() => {
    const v = videoRef.current
    if (!v || !mutedStart) return
    const heard = () => !v.muted && setMutedStart(false)
    v.addEventListener('volumechange', heard)
    return () => v.removeEventListener('volumechange', heard)
  }, [mutedStart])

  // source: the raw file, or the transcoded playlist through hls.js
  useEffect(() => {
    const v = videoRef.current
    if (!v || !data) return
    const start = resumeAt.current
    const onMeta = () => {
      if (start > 0) v.currentTime = start
      // a browser refuses sound until the page was clicked (or, in Firefox, a
      // click a few seconds ago): then the picture starts muted and the title
      // row offers the sound back
      v.play().catch((e: DOMException) => {
        if (e.name !== 'NotAllowedError') return
        v.muted = true
        setMutedStart(true)
        v.play().catch(() => {})
      })
    }
    v.addEventListener('loadedmetadata', onMeta, { once: true })
    if (!hls) {
      v.src = `/api/play/stream?${src}`
      return () => {
        resumeAt.current = v.currentTime
        v.removeEventListener('loadedmetadata', onMeta)
        v.removeAttribute('src')
        v.load()
      }
    }
    const url = `/api/play/hls/index.m3u8?${src}&audio=${audioIdx}&burn=${burn}`
    if (!HlsPlayer.isSupported()) {
      v.src = url // Safari plays HLS itself
      return () => {
        resumeAt.current = v.currentTime
        v.removeAttribute('src')
      }
    }
    const h = new HlsPlayer({ startPosition: start })
    h.loadSource(url)
    h.attachMedia(v)
    return () => {
      resumeAt.current = v.currentTime
      v.removeEventListener('loadedmetadata', onMeta)
      h.destroy()
    }
  }, [data, hls, src, audioIdx, burn])

  // watchdog: playing, but no picture - the browser cannot decode this codec
  // after all, so the server transcodes it
  useEffect(() => {
    const v = videoRef.current
    if (!v || hls || !data?.video) return
    let timer = 0
    const check = () => {
      timer = window.setTimeout(() => {
        if (v.videoWidth === 0 || v.getVideoPlaybackQuality().totalVideoFrames === 0) {
          resumeAt.current = v.currentTime
          setForceHls(true)
        }
      }, 3000)
    }
    const fail = () => setForceHls(true)
    v.addEventListener('playing', check, { once: true })
    v.addEventListener('error', fail)
    return () => {
      clearTimeout(timer)
      v.removeEventListener('playing', check)
      v.removeEventListener('error', fail)
    }
  }, [hls, data])

  // the dock's real height (it differs per viewport and pointer): the
  // settings menu opens above it
  const playerRef = useRef<MediaControllerElement>(null)
  useEffect(() => {
    const player = playerRef.current
    const dock = player?.querySelector<HTMLElement>('.t-player-dock')
    if (!player || !dock) return
    const ro = new ResizeObserver(() => {
      const gap = parseFloat(getComputedStyle(dock).marginBottom) || 0
      player.style.setProperty('--pl-dock-h', `${dock.offsetHeight + gap}px`)
    })
    ro.observe(dock)
    return () => ro.disconnect()
  }, [data])

  // a phone in fullscreen turns to landscape, where a 16:9 picture fills the
  // screen; browsers without orientation lock (iOS) simply stay as they are
  useEffect(() => {
    const turn = () => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      if (!matchMedia('(pointer: coarse)').matches || !o?.lock) return
      if (document.fullscreenElement) o.lock('landscape').catch(() => {})
      else o.unlock?.()
    }
    document.addEventListener('fullscreenchange', turn)
    return () => document.removeEventListener('fullscreenchange', turn)
  }, [])

  // text subtitles: ASS from the server, rendered by libass with the file's
  // fonts. An embedded track comes out of a pass over the whole file that the
  // server runs on the first request; until it is through the answer is 202
  // and this asks again. Switching tracks aborts the wait for the old one.
  const [subError, setSubError] = useState('')
  const [subPending, setSubPending] = useState(false)
  // whether the picture has played at all: only the very first subtitle
  // request waits for it, a later switch - paused or not - goes right out
  const played = useRef(false)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const mark = () => {
      played.current = true
    }
    v.addEventListener('playing', mark)
    return () => v.removeEventListener('playing', mark)
  }, [data])
  useEffect(() => {
    const v = videoRef.current
    if (!v || !data || !subTrack || subTrack.image) return
    let renderer: JASSUB | null = null
    let canvas: HTMLCanvasElement | null = null
    const abort = new AbortController()
    setSubError('')
    const url = subTrack.file
      ? `/api/play/sub?server=${server}&path=${encodeURIComponent(subTrack.file)}`
      : `/api/play/sub?${src}&track=${subTrack.index}`
    const load = async () => {
      // the first request starts the server's pass over the whole file: let
      // the picture have the connection to itself until it plays
      if (!played.current) {
        await new Promise<void>((ok) => v.addEventListener('playing', () => ok(), { once: true, signal: abort.signal }))
      }
      for (;;) {
        const r = await fetch(url, { signal: abort.signal })
        if (r.status !== 202) {
          if (!r.ok) throw new Error(r.statusText)
          return r.text()
        }
        setSubPending(true)
        await new Promise((ok) => setTimeout(ok, 2000))
      }
    }
    load()
      .then((content) => {
        if (abort.signal.aborted) return
        setSubPending(false)
        // our own canvas: media-chrome fades every overlay out with the
        // controls unless it is marked noautohide, and the subtitles must stay
        canvas = document.createElement('canvas')
        canvas.className = 't-player-subs'
        canvas.setAttribute('noautohide', '')
        v.after(canvas)
        renderer = new JASSUB({
          video: v,
          canvas,
          subContent: content,
          fonts: data.fonts.map((i) => new URL(`/api/play/font?${src}&index=${i}`, location.href).href),
        })
        // libass draws on each new video frame; a paused video sends none, so
        // a track picked while paused stayed blank until play. Drawing the
        // frame that is on screen fixes that.
        const r = renderer
        r.ready.then(() => {
          if (abort.signal.aborted || renderer !== r || !v.paused) return
          r.manualRender(
            {
              expectedDisplayTime: performance.now(),
              mediaTime: v.currentTime,
              width: v.videoWidth,
              height: v.videoHeight,
            },
            true,
          )
        })
      })
      .catch(() => {
        if (abort.signal.aborted) return
        setSubPending(false)
        setSubError(t('player.subError'))
      })
    return () => {
      abort.abort()
      setSubPending(false)
      renderer?.destroy()
      canvas?.remove()
    }
  }, [data, subTrack, server, src, t])

  // touch: a double tap on the left or right third of the picture seeks 10 s,
  // and taps that keep coming add up (the flash shows the running total). A
  // single tap is left to media-chrome, which shows or hides the controls.
  const lastTap = useRef({ at: 0, side: '' })
  const [flash, setFlash] = useState<{ side: 'back' | 'fwd'; secs: number } | null>(null)
  const flashTimer = useRef(0)
  const tapSeek = (e: PointerEvent<HTMLElement>) => {
    const vid = videoRef.current
    if (e.pointerType !== 'touch' || !vid) return
    if ((e.target as HTMLElement).closest('.t-player-dock, .t-player-menu, .t-player-top')) return
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / box.width
    const side = x < 1 / 3 ? 'back' : x > 2 / 3 ? 'fwd' : ''
    const now = performance.now()
    const prev = lastTap.current
    lastTap.current = { at: now, side }
    if (!side || prev.side !== side || now - prev.at > 300) return
    vid.currentTime = Math.min(Math.max(vid.currentTime + (side === 'fwd' ? 10 : -10), 0), vid.duration || Infinity)
    setFlash((f) => ({ side, secs: (f?.side === side ? f.secs : 0) + 10 }))
    clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 700)
  }

  if (!path) return <p className="p-6 text-sm text-t-muted">{t('player.noFile')}</p>
  if (info.isPending) return <Loading />
  const conflict = keyConflictOf(info.error)
  if (conflict)
    return (
      <HostKeyPrompt
        className="m-6"
        serverId={server}
        conflict={conflict}
        onAccepted={() => info.refetch()}
        onRejected={() => navigate(-1)}
      />
    )
  if (info.error || !data)
    return (
      <p className="p-6 text-sm text-err" role="alert">
        {info.error?.message}
      </p>
    )

  const subLabel = subTrack ? trackLabel(subTrack, 0) : t('player.subOff')
  const v = data.video
  const facts = [
    v && `${CODEC_NAMES[v.codec] ?? v.codec.toUpperCase()}${v.pixFmt?.includes('10') ? ' 10-bit' : ''}`,
    v && v.height > 0 && `${v.height}p`,
  ].filter(Boolean)

  return (
    <MediaController
      ref={playerRef}
      lang={i18n.language}
      className="t-player"
      // media-chrome's hotkeys (space, k, f, m, arrows) act only while focus is
      // inside the player, never page-wide (WCAG 2.1.4)
      onPointerUp={tapSeek}
    >
      {/* captions are libass on a canvas over the picture: a <track> cannot
          carry ASS styling, positioning or the file's fonts */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} slot="media" playsInline />

      <div slot="top-chrome" className="t-player-top">
        <span className="t-player-title" title={path}>
          {name}
        </span>
        {facts.map((f) => (
          <span key={f as string} className="t-player-chip">
            {f}
          </span>
        ))}
        {hls && (
          <span className="t-player-chip t-player-chip--accent" title={t('player.transcoding')}>
            {t('player.transcode')}
          </span>
        )}
        {mutedStart && (
          <button
            type="button"
            className="t-player-chip t-player-chip--accent t-player-chip--button"
            onClick={() => {
              const v = videoRef.current
              if (v) v.muted = false
            }}
          >
            {t('player.unmute')}
          </button>
        )}
        {subPending && (
          <span className="t-player-chip" role="status">
            {t('player.subLoading')}
          </span>
        )}
        {subError && (
          <span className="t-player-chip t-player-chip--err" role="alert">
            {subError}
          </span>
        )}
      </div>

      {/* noautohide: a double-tap flash must show while the controls are away;
          the big play button has its own paused-only rule */}
      <div slot="centered-chrome" className="t-player-center" {...{ noautohide: '' }}>
        <span className="t-player-flash" data-side="back" data-on={flash?.side === 'back' || undefined} aria-hidden>
          {flash?.side === 'back' && `- ${flash.secs} s`}
        </span>
        <MediaLoadingIndicator noAutohide className="t-player-spinner" />
        <MediaPlayButton className="t-player-bigplay" />
        <span className="t-player-flash" data-side="fwd" data-on={flash?.side === 'fwd' || undefined} aria-hidden>
          {flash?.side === 'fwd' && `+ ${flash.secs} s`}
        </span>
      </div>

      <MediaSettingsMenu hidden anchor="auto" className="t-player-menu">
        <MediaSettingsMenuItem>
          {t('player.subtitles')}
          <TrackMenu
            title={t('player.subtitles')}
            value={subKey}
            options={[
              { value: 'none', label: t('player.subOff') },
              ...data.subs.map((s, i) => ({ value: subValue(s), label: trackLabel(s, i) })),
            ]}
            onChange={(val) => {
              resumeAt.current = videoRef.current?.currentTime ?? 0
              setSub(val)
            }}
          />
        </MediaSettingsMenuItem>
        {data.audio.length > 1 && (
          <MediaSettingsMenuItem>
            {t('player.audio')}
            <TrackMenu
              title={t('player.audio')}
              value={String(audioIdx)}
              options={data.audio.map((a, i) => ({ value: String(a.index), label: trackLabel(a, i) }))}
              onChange={(val) => {
                resumeAt.current = videoRef.current?.currentTime ?? 0
                setAudio(Number(val))
              }}
            />
          </MediaSettingsMenuItem>
        )}
        <MediaSettingsMenuItem>
          {t('player.speed')}
          <MediaPlaybackRateMenu slot="submenu" hidden rates={[0.5, 0.75, 1, 1.25, 1.5, 2]}>
            <div slot="title">{t('player.speed')}</div>
          </MediaPlaybackRateMenu>
        </MediaSettingsMenuItem>
      </MediaSettingsMenu>

      <div className="t-player-dock">
        <MediaControlBar className="t-player-scrub">
          <MediaTimeRange>
            <MediaPreviewTimeDisplay slot="preview" />
          </MediaTimeRange>
        </MediaControlBar>
        <MediaControlBar className="t-player-bar">
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={10} />
          <MediaSeekForwardButton seekOffset={10} />
          <span className="t-player-volume">
            <MediaMuteButton />
            <MediaVolumeRange />
          </span>
          <MediaTimeDisplay showDuration className="t-player-time" />
          <span className="flex-1" />
          <button
            type="button"
            className="t-player-cc"
            aria-pressed={subKey !== 'none'}
            aria-label={`${t('player.subtitles')}: ${subLabel}`}
            title={`${t('player.subtitles')}: ${subLabel}`}
            disabled={data.subs.length === 0}
            onClick={() => {
              const first = data.subs.find((s) => !s.forced) ?? data.subs[0]
              setSub(subKey === 'none' && first ? subValue(first) : 'none')
            }}
          >
            <Captions aria-hidden size={20} />
          </button>
          <MediaSettingsMenuButton />
          <MediaPipButton />
          <MediaFullscreenButton />
        </MediaControlBar>
      </div>
    </MediaController>
  )
}

// TrackMenu is a submenu of the settings menu that picks one of a list: the
// audio or subtitle track. media-chrome draws, positions and keyboard-drives
// it; the choice comes back as the menu's change event.
function TrackMenu({
  title,
  value,
  options,
  onChange,
}: {
  title: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const ref = useRef<ChromeMenuElement>(null)
  const pick = useEffectEvent(() => ref.current && onChange(ref.current.value))
  useEffect(() => {
    const el = ref.current
    el?.addEventListener('change', pick)
    return () => el?.removeEventListener('change', pick)
  }, [])
  return (
    <MediaChromeMenu ref={ref} slot="submenu" hidden>
      <div slot="title">{title}</div>
      {options.map((o) => (
        <MediaChromeMenuItem
          key={o.value}
          type="radio"
          value={o.value}
          aria-checked={o.value === value ? 'true' : 'false'}
        >
          {o.label}
        </MediaChromeMenuItem>
      ))}
    </MediaChromeMenu>
  )
}

function subValue(s: PlayTrack): string {
  return s.file ? `f:${s.file}` : `t:${s.index}`
}
