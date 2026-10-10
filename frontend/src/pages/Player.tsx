import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import HlsPlayer from 'hls.js'
import JASSUB from 'jassub'
import { Captions, PictureInPicture2, SkipBack, SkipForward, X } from 'lucide-react'
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
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
import { api, keyConflictOf, type ServerInfo } from '../api'
import HostKeyPrompt from '../components/HostKeyPrompt'
import { listFolder, playHref, videosIn } from '../components/playLinks'
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

// A Bluray picture track inside the file: the browser draws it itself (libpgs),
// the server only copies it out. DVD and DVB pictures are still burned in.
const isPgs = (s: PlayTrack) => s.image && !s.file && s.codec === 'hdmv_pgs_subtitle'

// the controls speak the app's language; media-chrome ships the German labels
// but only registers English itself
addTranslation('de', De)

// what the browser decodes on its own. canPlayType is only the first opinion:
// Firefox and Chrome both say "probably" about HEVC on machines that then decode
// no frame, so the watchdog below has the last word.
const DIRECT_CONTAINERS = new Set(['mkv', 'mp4', 'm4v', 'webm', 'mov'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

// The codec string for a picture: profile and bit depth matter, a phone that
// decodes HEVC Main may not decode Main 10.
function codecString(v: NonNullable<PlayInfo['video']>): string {
  const ten = !!(v.pixFmt?.includes('10') || v.pixFmt?.includes('12'))
  switch (v.codec) {
    case 'h264':
      return `video/mp4; codecs="${ten ? 'avc1.6E0028' : 'avc1.640028'}"`
    case 'hevc':
      return `video/mp4; codecs="${ten ? 'hvc1.2.4.L120.B0' : 'hvc1.1.6.L120.B0'}"`
    case 'vp9':
      return `video/webm; codecs="${ten ? 'vp09.02.40.10' : 'vp09.00.40.08'}"`
    case 'av1':
      return `video/mp4; codecs="${ten ? 'av01.0.08M.10' : 'av01.0.08M.08'}"`
    case 'vp8':
      return 'video/webm; codecs="vp8"'
    default:
      return ''
  }
}

// Whether this device decodes the picture. MediaCapabilities knows the
// hardware decoders too (HEVC on a phone); canPlayType is the fallback, and
// the watchdog below the last word for either.
async function canDecodeVideo(v: PlayInfo['video']): Promise<boolean> {
  if (!v) return true // audio-only
  const type = codecString(v)
  if (!type) return false
  if (navigator.mediaCapabilities?.decodingInfo) {
    try {
      const r = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType: type,
          width: v.width || 1920,
          height: v.height || 1080,
          bitrate: 8_000_000,
          framerate: 24,
        },
      })
      return r.supported
    } catch {
      // an engine that rejects the question answers through canPlayType
    }
  }
  return document.createElement('video').canPlayType(type) !== ''
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

// the route: every file gets a fresh player, so the tracks, the transcode
// fallback and the subtitles of one episode never leak into the next
export default function Player() {
  const [params] = useSearchParams()
  const server = Number(params.get('server') || 0)
  const path = params.get('path') || ''
  return <PlayerView key={`${server}:${path}`} server={server} path={path} />
}

function PlayerView({ server, path }: { server: number; path: string }) {
  const { t, i18n } = useTranslation()
  setLanguage(i18n.language)
  const navigate = useNavigate()
  const name = path.split('/').pop() || path
  const src = `server=${server}&path=${encodeURIComponent(path)}`

  const servers = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
    enabled: server > 0,
  })
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
        data?.subs.find((s) => s.default && !s.forced && (!s.image || isPgs(s))) ??
        data?.subs.find((s) => !s.forced && (!s.image || isPgs(s)))
      return pick ? subValue(pick) : 'none'
    })()
  const subTrack = data?.subs.find((s) => subValue(s) === subKey)
  const burn = subTrack?.image && !isPgs(subTrack) ? subTrack.index : -1

  // the device's answer for this picture; nothing plays before it is in
  const decode = useQuery({
    queryKey: ['decodable', data?.video?.codec, data?.video?.pixFmt, data?.video?.width, data?.video?.height],
    queryFn: () => canDecodeVideo(data?.video),
    enabled: !!data,
    staleTime: Infinity,
  })
  const videoOk = decode.data
  const hls = useMemo(() => {
    if (!data) return false
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const a = data.audio.find((x) => x.index === audioIdx)
    return (
      forceHls ||
      !DIRECT_CONTAINERS.has(ext) ||
      !videoOk ||
      (a && !DIRECT_AUDIO.has(a.codec)) ||
      // a browser plays the first audio track of a file and offers no other
      (a && a.index !== data.audio[0].index) ||
      burn >= 0
    )
  }, [data, path, audioIdx, burn, forceHls, videoOk])
  // Most of what needs the server does not need a new picture: Bluray sound,
  // the second audio track. The picture is then copied and only repackaged
  // (copy), the sound too where the browser plays it (acopy). The server
  // falls back to transcoding a file it cannot cut at keyframes.
  // ponytail: H.264 in 8 bit only - HEVC in the TS segments is not reliable
  // across hls.js; widen once it is.
  const copy =
    hls &&
    !forceHls &&
    burn < 0 &&
    path.toLowerCase().endsWith('.mkv') &&
    data?.video?.codec === 'h264' &&
    !data.video.pixFmt?.includes('10')
  const acopy = ['aac', 'mp3'].includes(data?.audio.find((x) => x.index === audioIdx)?.codec ?? '')

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
    if (!v || !data || videoOk === undefined) return
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
    const url = `/api/play/hls/index.m3u8?${src}&audio=${audioIdx}&burn=${burn}${copy ? '&copy=1' : ''}${copy && acopy ? '&acopy=1' : ''}`
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
  }, [data, hls, src, audioIdx, burn, copy, acopy, videoOk])

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

  // Picture in picture through our own button. The video keeps
  // disablePictureInPicture so no browser lays its own button over it (Firefox
  // does); the attribute also blocks the request, so it is lifted for the
  // moment of asking and set again once the window closes.
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled
  const [inPip, setInPip] = useState(false)
  const togglePip = async () => {
    const v = videoRef.current
    if (!v) return
    if (document.pictureInPictureElement) return void document.exitPictureInPicture().catch(() => {})
    v.disablePictureInPicture = false
    try {
      await v.requestPictureInPicture()
    } catch {
      v.disablePictureInPicture = true
    }
  }
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const enter = () => setInPip(true)
    const leave = () => {
      setInPip(false)
      v.disablePictureInPicture = true
    }
    v.addEventListener('enterpictureinpicture', enter)
    v.addEventListener('leavepictureinpicture', leave)
    return () => {
      v.removeEventListener('enterpictureinpicture', enter)
      v.removeEventListener('leavepictureinpicture', leave)
    }
  }, [data])

  // the dock's real height (it differs per viewport and pointer): the
  // settings menu opens above it
  // the episodes beside this one: the folder's videos in order, for the
  // previous/next buttons, the episodes menu and going on at the end
  const parent = path.slice(0, path.lastIndexOf('/')) || '/'
  const folder = useQuery({
    queryKey: ['play-folder', server, parent],
    queryFn: async () => videosIn(await listFolder(server, parent)),
    enabled: !!path,
    staleTime: 60_000,
  })
  const episodes = folder.data ?? []
  const at = episodes.findIndex((e) => e.path === path || e.name === name)
  const prev = at > 0 ? episodes[at - 1] : undefined
  const next = at >= 0 && at < episodes.length - 1 ? episodes[at + 1] : undefined
  const goTo = (e: { path: string }) => navigate(playHref(server, e.path), { replace: true })
  // at the end of an episode the next one starts after a short count, which
  // the title row shows and lets the user skip or call off
  const [nextIn, setNextIn] = useState<number | null>(null)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !next) return
    const ended = () => setNextIn(8)
    v.addEventListener('ended', ended)
    return () => v.removeEventListener('ended', ended)
  }, [next, data])
  const goNext = useEffectEvent(() => next && goTo(next))
  useEffect(() => {
    if (nextIn === null) return
    if (nextIn <= 0) {
      goNext()
      return
    }
    const id = window.setTimeout(() => setNextIn(nextIn - 1), 1000)
    return () => clearTimeout(id)
  }, [nextIn])

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
    if (!v || !data || !subTrack || burn >= 0) return
    const pgs = isPgs(subTrack)
    let renderer: { destroy(): void } | null = null
    let canvas: HTMLCanvasElement | null = null
    const abort = new AbortController()
    setSubError('')
    const url = subTrack.file
      ? `/api/play/sub?server=${server}&path=${encodeURIComponent(subTrack.file)}`
      : `/api/play/sub?${src}&track=${subTrack.index}${pgs ? '&format=sup' : ''}`
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
          return pgs ? r.arrayBuffer() : r.text()
        }
        setSubPending(true)
        await new Promise((ok) => setTimeout(ok, 2000))
      }
    }
    load()
      .then(async (content) => {
        if (abort.signal.aborted) return
        setSubPending(false)
        // our own canvas: media-chrome fades every overlay out with the
        // controls unless it is marked noautohide, and the subtitles must stay
        canvas = document.createElement('canvas')
        canvas.className = pgs ? 't-player-subs t-player-subs-pgs' : 't-player-subs'
        canvas.setAttribute('noautohide', '')
        v.after(canvas)
        if (typeof content !== 'string') {
          // libpgs comes in only for a Bluray track
          const [{ PgsRenderer }, { default: workerUrl }] = await Promise.all([
            import('libpgs'),
            import('libpgs/dist/libpgs.worker.js?url'),
          ])
          if (abort.signal.aborted) return
          const p = new PgsRenderer({ video: v, canvas, workerUrl, aspectRatio: 'contain' })
          renderer = { destroy: () => p.dispose() }
          await p.loadFromBuffer(content)
          // like libass, it draws on time updates only: show the paused frame's picture
          if (!abort.signal.aborted) p.renderAtTimestamp(v.currentTime)
          return
        }
        const r = new JASSUB({
          video: v,
          canvas,
          subContent: content,
          fonts: data.fonts.map((i) => new URL(`/api/play/font?${src}&index=${i}`, location.href).href),
        })
        renderer = r
        // libass draws on each new video frame; a paused video sends none, so
        // a track picked while paused stayed blank until play. Drawing the
        // frame that is on screen fixes that.
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
  }, [data, subTrack, burn, server, src, t])

  // touch: a tap on the picture shows hidden controls and hides shown ones; a
  // double tap on the left or right third seeks 10 s, and taps that keep coming
  // add up (the flash shows the running total).
  //
  // media-chrome hides on a tap but never shows: it only wakes the controls on
  // a pointer that moves for longer than a tap, so once they had faded a finger
  // could not get them back. Whether they were hidden is read when the finger
  // lands, before media-chrome's own pointerup handling changes it.
  const lastTap = useRef({ at: 0, side: '' })
  const wasHidden = useRef(false)
  // after a touch the browser plays a mouse along (enter, move, click) and then
  // has it leave; media-chrome reads that leave as the pointer going away and
  // hides the controls the tap just showed. A leave right after a touch is
  // not one, so it never reaches media-chrome.
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    let touched = 0
    const touch = (e: globalThis.PointerEvent) => {
      if (e.pointerType === 'touch') touched = e.timeStamp
    }
    const leave = (e: MouseEvent) => {
      if (e.timeStamp - touched < 1000) e.stopImmediatePropagation()
    }
    player.addEventListener('pointerdown', touch, true)
    player.addEventListener('mouseleave', leave, true)
    return () => {
      player.removeEventListener('pointerdown', touch, true)
      player.removeEventListener('mouseleave', leave, true)
    }
  }, [data])
  const noteHidden = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch') wasHidden.current = e.currentTarget.hasAttribute('userinactive')
  }
  const [flash, setFlash] = useState<{ side: 'back' | 'fwd'; secs: number } | null>(null)
  const flashTimer = useRef(0)
  const tapSeek = (e: PointerEvent<HTMLElement>) => {
    const vid = videoRef.current
    if (e.pointerType !== 'touch' || !vid) return
    if ((e.target as HTMLElement).closest('.t-player-dock, .t-player-menu, .t-player-top')) return
    if (wasHidden.current) {
      // the way media-chrome itself wakes the controls: activity over the
      // media, which also schedules their fading again
      vid.dispatchEvent(
        new globalThis.PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true, composed: true }),
      )
    }
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
      onPointerDown={noteHidden}
      onPointerUp={tapSeek}
    >
      {/* captions are libass on a canvas over the picture: a <track> cannot
          carry ASS styling, positioning or the file's fonts */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        slot="media"
        playsInline
        // Chrome on Android lays a cast button over every video, and keeps it
        // there: the player has its own controls and no cast target
        // and Firefox one for picture in picture; ours is in the dock (it
        // lifts this for the moment it asks, see togglePip)
        {...{ disableRemotePlayback: true, disablePictureInPicture: true }}
      />

      <div slot="top-chrome" className="t-player-top">
        <span className="t-player-title" title={path}>
          {name}
        </span>
        <span className="t-player-chip" title={server ? t('player.fromServer') : t('player.fromLocal')}>
          {server ? (servers.data?.find((x) => x.id === server)?.name ?? t('player.remote')) : t('player.local')}
        </span>
        {facts.map((f) => (
          <span key={f as string} className="t-player-chip">
            {f}
          </span>
        ))}
        {hls && !copy && (
          <span className="t-player-chip t-player-chip--accent" title={t('player.transcoding')}>
            {t('player.transcode')}
          </span>
        )}
        {nextIn !== null && next && (
          <span className="t-player-next" role="status">
            <button
              type="button"
              className="t-player-chip t-player-chip--accent t-player-chip--button"
              onClick={() => goTo(next)}
            >
              {t('player.nextIn', { secs: nextIn })}
            </button>
            <button
              type="button"
              className="t-player-chip t-player-chip--button"
              aria-label={t('player.nextCancel')}
              onClick={() => setNextIn(null)}
            >
              <X aria-hidden size="1em" />
            </button>
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
        {episodes.length > 1 && (
          <MediaSettingsMenuItem>
            {t('player.episodes')}
            <TrackMenu
              title={t('player.episodes')}
              value={at >= 0 ? episodes[at].path : ''}
              options={episodes.map((e) => ({ value: e.path, label: e.name.replace(/\.[^.]+$/, '') }))}
              onChange={(p) => goTo({ path: p })}
            />
          </MediaSettingsMenuItem>
        )}
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
          {episodes.length > 1 && (
            <>
              <button
                type="button"
                className="t-player-btn t-player-prev"
                aria-label={t('player.prevEpisode')}
                title={prev ? `${t('player.prevEpisode')}: ${prev.name}` : t('player.prevEpisode')}
                disabled={!prev}
                onClick={() => prev && goTo(prev)}
              >
                <SkipBack aria-hidden size={20} />
              </button>
              <button
                type="button"
                className="t-player-btn"
                aria-label={t('player.nextEpisode')}
                title={next ? `${t('player.nextEpisode')}: ${next.name}` : t('player.nextEpisode')}
                disabled={!next}
                onClick={() => next && goTo(next)}
              >
                <SkipForward aria-hidden size={20} />
              </button>
            </>
          )}
          <button
            type="button"
            className="t-player-btn t-player-cc"
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
          {pipSupported && (
            <button
              type="button"
              className="t-player-btn t-player-pip"
              aria-pressed={inPip}
              aria-label={t('player.pip')}
              title={t('player.pip')}
              onClick={togglePip}
            >
              <PictureInPicture2 aria-hidden size={20} />
            </button>
          )}
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
