import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { useBackEntry } from 'fluid-lycoris'
import { usePlayerMenuBack } from './playerMenuBack'
import { attachHold, HOLD_RATE } from './playerHold'
import HlsPlayer from 'hls.js'
import JASSUB from 'jassub'
// Vite turns the query into a URL string; the linter only sees the .ts file
// eslint-disable-next-line import/default
import jassubWorkerUrl from './jassubWorker?worker&url'
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  CaptionsOff,
  Maximize,
  Minimize,
  PictureInPicture2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPlayButton,
  MediaPreviewChapterDisplay,
  MediaPreviewTimeDisplay,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'
import {
  MediaChromeMenu,
  MediaChromeMenuButton,
  MediaChromeMenuItem,
  MediaSettingsMenu,
  MediaSettingsMenuButton,
  MediaSettingsMenuItem,
} from 'media-chrome/react/menu'
import type { MediaChromeMenu as ChromeMenuElement } from 'media-chrome/menu'
import type { MediaController as MediaControllerElement } from 'media-chrome'
import { addTranslation, setLanguage } from 'media-chrome/dist/utils/i18n.js'
import { De } from 'media-chrome/dist/lang/de.js'
import { api, keyConflictOf, mediaTitle, type PlayStatus, type ServerInfo } from '../api'
import HostKeyPrompt from '../components/HostKeyPrompt'
import { filesLink, listFolder, playHref, useBack, videosIn } from '../components/playLinks'
import Logo from '../components/Logo'
import { useToast } from '../components/toast'
import { useImmersive } from '../components/useImmersive'
import PlayerInfo, {
  CODEC_NAMES,
  bareTitle,
  episodeCode,
  trackLabel,
  usePlayTitle,
  type PlayInfo,
  type PlayTrack,
} from './PlayerInfo'
import { renameFamilies, scaleFonts, scriptFamilies } from './assFonts'
import { markSeen, resumeFrom, savedPosition, SEEN_AT, storePosition } from './playPosition'
import { chaptersVtt, useChapterSkip } from './playerChapters'
import './player.css'

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
const RATES = [0.5, 1, 1.25, 1.5, 1.75, 2]
// the subtitle size: a factor on the script's own font sizes, never a CSS
// scale on the drawn layer, so a sign keeps its place
const SUB_SIZES = { s: 0.8, m: 1, l: 1.25 } as const
type SubSize = keyof typeof SUB_SIZES
const SUB_SIZE_KEY = 'weebsync.player.subSize'
const readSubSize = (): SubSize => {
  try {
    const v = localStorage.getItem(SUB_SIZE_KEY)
    return v === 's' || v === 'l' ? v : 'm'
  } catch {
    return 'm'
  }
}
const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${pad2(m)}` : m}:${pad2(Math.floor(s % 60))}`
}
const FIREFOX_ANDROID = /Android.*Firefox\//.test(navigator.userAgent)
// Safari, and every browser on an iPhone (all WebKit), reads no Matroska: a
// direct .mkv loaded forever without a frame
// an iPhone has fullscreen for a bare <video> only: iOS's own player, without
// the subtitles, the menus or the dock. The player covers the screen itself.
const OWN_FULLSCREEN = !document.fullscreenEnabled
const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Android/.test(navigator.userAgent)

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

// a wait in words, with the seconds it has taken once they add up: a number
// that keeps counting shows the player is still at it. The server's own
// numbers (a share, bytes read) take the counter's place once there are any.
// Inside a live region only the words are read out: the number changes every
// second and would be announced every second, so it is hidden from the
// announcement.
function Waited({ text, detail }: { text: string; detail?: string }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setSecs((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const count = detail || (secs < 3 ? '' : `${secs} s`)
  return (
    <>
      {text}
      {count && <span aria-hidden> · {count}</span>}
    </>
  )
}

// the route: every file gets a fresh player, so the tracks, the transcode
// fallback and the subtitles of one episode never leak into the next
export default function Player() {
  const [params] = useSearchParams()
  const server = Number(params.get('server') || 0)
  const path = params.get('path') || ''
  // Whether the focus sat in the player when the last file's view went: the
  // next one takes it back as soon as its picture is there.
  const focusCarry = useRef(false)
  const refocus = useMemo(
    () => ({
      keep: (v: boolean) => void (focusCarry.current = v),
      take: () => {
        const v = focusCarry.current
        focusCarry.current = false
        return v
      },
    }),
    [],
  )
  // The page is the element that goes fullscreen (the controller takes it as
  // its fullscreenElement), and it outlives the key below: the browser leaves
  // fullscreen when its element is removed, which every episode switch used to do.
  return (
    <div className="t-player-page">
      <PlayerView key={`${server}:${path}`} server={server} path={path} refocus={refocus} />
    </div>
  )
}

// seconds from the end of an episode to the start of the next
const NEXT_COUNT = 8

function PlayerView({
  server,
  path,
  refocus,
}: {
  server: number
  path: string
  refocus: { keep: (v: boolean) => void; take: () => boolean }
}) {
  const { t, i18n } = useTranslation()
  setLanguage(i18n.language)
  const navigate = useNavigate()
  // a phone gives the player the whole screen: the shell's bars step aside
  useImmersive('playing')
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
    // a refocus or reconnect must not refetch it while it plays (a failed or
    // changed answer would tear the running video down); a mount still does,
    // so a cached answer with an old AniList progress is not trusted
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const [audio, setAudio] = useState<number | null>(null)
  const [sub, setSub] = useState<string | null>(null)
  const [rate, setRate] = useState(1)
  const [subSize, setSubSizeState] = useState<SubSize>(readSubSize)
  const setSubSize = (v: SubSize) => {
    setSubSizeState(v)
    try {
      localStorage.setItem(SUB_SIZE_KEY, v)
    } catch {
      // storage can be off: the size holds for this file
    }
  }
  // the subtitle track picked before "c" turned them off, for turning them on again
  const [lastSub, setLastSub] = useState<string | null>(null)
  // the watchdog saw the browser fail at a file it claimed it could play
  const [forceHls, setForceHls] = useState(false)

  const data = info.data
  const audioIdx = audio ?? (data?.audio.find((a) => a.default) ?? data?.audio[0])?.index ?? -1
  const autoSub = (() => {
    // a full track in the default's language, never signs-only on its own
    const pick =
      data?.subs.find((s) => s.default && !s.forced && (!s.image || isPgs(s))) ??
      data?.subs.find((s) => !s.forced && (!s.image || isPgs(s)))
    return pick ? subValue(pick) : 'none'
  })()
  const subKey = sub ?? autoSub
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
      // Firefox on Android reads a whole Matroska file before it reports a
      // duration: an episode spun for minutes. The segments start at once.
      (ext === 'mkv' && (FIREFOX_ANDROID || WEBKIT)) ||
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
  // where this file was left last time: offered on a card, never jumped to unasked
  const [resumeOffer, setResumeOffer] = useState<number | null>(() => resumeFrom(savedPosition(server, path), 0))
  const offer = resumeOffer !== null && data ? resumeFrom(resumeOffer, data.duration) : null
  const offerOpen = offer !== null
  const resume = () => {
    const v = videoRef.current
    if (v && offer !== null) v.currentTime = offer
    setResumeOffer(null)
  }
  // the offer steps aside after a while: no answer is "from the start". Not
  // while the focus or the pointer is on the card (WCAG 2.2.1): the time starts
  // again once they leave
  const [offerHeld, setOfferHeld] = useState(false)
  useEffect(() => {
    if (!offerOpen || offerHeld) return
    const id = window.setTimeout(() => setResumeOffer(null), 15_000)
    return () => clearTimeout(id)
  }, [offerOpen, offerHeld])
  // the position is kept once the offer is answered (or there was none): the
  // first seconds from the start would overwrite the place to go on from.
  // Declared before the source effect, so on leaving it reads the position
  // before the source is taken away.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !data || offerOpen) return
    let last = 0
    let seen = false
    const keep = () => {
      if (v.currentTime > 0) storePosition(server, path, v.currentTime, v.duration || data.duration)
    }
    const tick = () => {
      if (!seen && v.duration && v.currentTime / v.duration >= SEEN_AT) {
        seen = true
        markSeen(server, path)
      }
      if (Math.abs(v.currentTime - last) < 5) return
      last = v.currentTime
      keep()
    }
    const end = () => storePosition(server, path, v.duration, v.duration)
    v.addEventListener('timeupdate', tick)
    v.addEventListener('pause', keep)
    v.addEventListener('ended', end)
    addEventListener('pagehide', keep)
    return () => {
      if (!v.ended) keep()
      v.removeEventListener('timeupdate', tick)
      v.removeEventListener('pause', keep)
      v.removeEventListener('ended', end)
      removeEventListener('pagehide', keep)
    }
  }, [data, offerOpen, server, path])
  // what the spinner waits for, in words: a remote file takes a while before
  // the first picture and a bare spinner looked like it would never end
  const [loadStep, setLoadStep] = useState('')
  const [loadError, setLoadError] = useState(false)
  // the server's side of the wait in numbers, asked every second while the
  // words show: a share and the time left for a segment being converted,
  // else what was read from a remote file so far
  const polling = !!path && (info.isPending || loadStep !== '')
  const status = useQuery({
    queryKey: ['play-status', server, path],
    queryFn: () => api.get<PlayStatus>(`/api/play/status?${src}`),
    enabled: polling,
    refetchInterval: 1000,
    gcTime: 0,
  })
  const statusDetail = (() => {
    // a stall after playing shows the words without polling: no stale numbers
    const s = status.data
    if (!s || !polling) return ''
    const num = (x: number, digits = 0) => x.toLocaleString(i18n.language, { maximumFractionDigits: digits })
    // a share once ffmpeg reported a time; before that the bytes say more
    if (s.done > 0 || s.left > 0) {
      const pct = t('player.statusDone', { pct: num(s.done * 100) })
      return s.left >= 1 ? `${pct} · ${t('player.statusLeft', { secs: num(Math.ceil(s.left)) })}` : pct
    }
    if (s.bytes > 0) return t('player.statusRead', { mb: num(s.bytes / 1e6, 1), rate: num(s.rate / 1e6, 1) })
    return ''
  })()
  const [mutedStart, setMutedStart] = useState(false)
  // the muted start ends with the first unmute, whichever control did it
  useEffect(() => {
    const v = videoRef.current
    if (!v || !mutedStart) return
    const heard = () => !v.muted && setMutedStart(false)
    v.addEventListener('volumechange', heard)
    return () => v.removeEventListener('volumechange', heard)
  }, [mutedStart])

  // on the server's side the wait is opening the file (direct) or cutting
  // the next piece out of it (HLS); on ours it is the buffer filling up
  const serverStep = !hls ? 'player.stepBuffer' : copy ? 'player.stepRepack' : 'player.stepTranscode'

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
    const step = (k: string) => () => setLoadStep(k)
    const steps: [string, () => void][] = [
      ['loadstart', step(hls ? serverStep : 'player.stepOpen')],
      ['loadedmetadata', step('player.stepBuffer')],
      ['waiting', step(serverStep)],
      ['canplay', step('')],
      ['playing', step('')],
      ['seeked', step('')],
    ]
    for (const [e, f] of steps) v.addEventListener(e, f)
    const fail = () => hls && setLoadError(true)
    v.addEventListener('error', fail)
    setLoadError(false)
    setLoadStep(hls ? serverStep : 'player.stepOpen')
    const unstep = () => {
      for (const [e, f] of steps) v.removeEventListener(e, f)
      v.removeEventListener('error', fail)
    }
    if (!hls) {
      v.src = `/api/play/stream?${src}`
      return () => {
        unstep()
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
        unstep()
        resumeAt.current = v.currentTime
        v.removeAttribute('src')
      }
    }
    const h = new HlsPlayer({
      startPosition: start,
      // the server holds a segment request until ffmpeg wrote it, up to 90 s
      // for a slow remote; hls.js gave up after 10 s without a byte, four
      // times, and then sat on a fatal error with the spinner going
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 95_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
        },
      },
    })
    h.on(HlsPlayer.Events.ERROR, (_, d) => d.fatal && setLoadError(true))
    h.loadSource(url)
    h.attachMedia(v)
    return () => {
      unstep()
      resumeAt.current = v.currentTime
      v.removeEventListener('loadedmetadata', onMeta)
      h.destroy()
    }
  }, [data, hls, src, audioIdx, burn, copy, acopy, videoOk, serverStep])

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
  const [ownFs, setOwnFs] = useState(false)
  // the CSS fullscreen is a layer: back leaves it, not the page
  useBackEntry(() => setOwnFs(false), undefined, ownFs)
  usePlayerMenuBack()
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
  // switching episodes replaces the entry, so one step back always leaves the player
  const back = useBack(filesLink(server, parent))
  // the title the file belongs to, for the title row and the panel under the picture
  const title = usePlayTitle(server, path, episodes, at)
  // at the end of an episode the next one starts after a short count, which
  // the title row shows and lets the user skip or call off
  const [nextIn, setNextIn] = useState<number | null>(null)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !next) return
    const ended = () => setNextIn(NEXT_COUNT)
    // watching on (play again, a seek back) calls the count off
    const resumed = () => setNextIn(null)
    v.addEventListener('ended', ended)
    v.addEventListener('play', resumed)
    v.addEventListener('seeking', resumed)
    return () => {
      v.removeEventListener('ended', ended)
      v.removeEventListener('play', resumed)
      v.removeEventListener('seeking', resumed)
    }
  }, [next, data])
  // the file's chapters as a track media-chrome reads: the time bar splits
  // into segments, the preview over it names the one under the pointer
  const chapters = useMemo(() => data?.chapters ?? [], [data])
  const chaptersText = useMemo(
    () => (chapters.length ? chaptersVtt(chapters, (n) => t('player.chapterN', { n })) : ''),
    [chapters, t],
  )
  // the cues as a blob of their own per mount (the policy allows blob: media,
  // not data:), let go of when the track goes. A track added after the media
  // is set is off, and media-chrome waits for the load only of the one it
  // found back then: wake the track, then tell media-chrome its cues are in
  const chaptersTrack = useCallback(
    (el: HTMLTrackElement | null) => {
      if (!el) return
      const url = URL.createObjectURL(new Blob([chaptersText], { type: 'text/vtt' }))
      const loaded = () => (el.parentElement as HTMLVideoElement | null)?.textTracks.dispatchEvent(new Event('change'))
      el.addEventListener('load', loaded)
      el.src = url
      if (el.track.mode === 'disabled') el.track.mode = 'hidden'
      return () => {
        el.removeEventListener('load', loaded)
        URL.revokeObjectURL(url)
      }
    },
    [chaptersText],
  )
  const { chapter, skippable, skip: skipChapter, dismiss: dismissSkip } = useChapterSkip(videoRef, chapters)
  // an untitled chapter goes by its number, as in the time bar's preview
  // (none for the moment a new list is in and the chapter still the old one's)
  const chapterIdx = chapter ? chapters.indexOf(chapter) : -1
  const chapterName = chapterIdx < 0 ? undefined : chapter?.title || t('player.chapterN', { n: chapterIdx + 1 })
  const skipOffered = nextIn === null && offer === null ? skippable : undefined
  // a card or pill goes away under the focus (skipped, waved off, chapter
  // over, resume answered, sound on): focus stays in the player, where its keys work, not on the page
  const keepFocusInPlayer = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const video = el.closest('media-controller')?.querySelector('video')
    return () => {
      if (el.contains(document.activeElement)) video?.focus({ preventScroll: true })
    }
  }, [])
  // 90 % of an episode counts as watched: the AniList list moves on by one,
  // never back and never past a gap. The write waits out the toast, whose
  // undo drops it before AniList hears of it
  const toast = useToast()
  const tracked = data?.anilist
  useEffect(() => {
    const v = videoRef.current
    if (!v || !tracked || tracked.episode !== tracked.progress + 1) return
    let done = false
    const tick = () => {
      if (done || !v.duration || v.currentTime / v.duration < 0.9) return
      done = true
      toast({
        message: t('player.seen', { n: tracked.episode }),
        undo: () => {},
        commit: () => api.post('/api/anilist/progress', { mediaId: tracked.mediaId, progress: tracked.episode }),
      })
    }
    v.addEventListener('timeupdate', tick)
    return () => v.removeEventListener('timeupdate', tick)
  }, [tracked, toast, t])
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

  // The notification shade, the lock screen and a headset: what plays (the
  // episode and its title, the series under it, the cover) instead of the
  // page's title, and the buttons for it. Previous and next show only where
  // there is an episode to go to.
  const sessionAction = useEffectEvent((action: MediaSessionAction, d: MediaSessionActionDetails) => {
    const v = videoRef.current
    if (!v) return
    if (action === 'play') void v.play().catch(() => {})
    else if (action === 'pause') v.pause()
    else if (action === 'seekto' && d.seekTime !== undefined) v.currentTime = d.seekTime
    else if (action === 'seekbackward') v.currentTime = Math.max(0, v.currentTime - (d.seekOffset ?? 10))
    else if (action === 'seekforward')
      v.currentTime = Math.min(v.duration || Infinity, v.currentTime + (d.seekOffset ?? 10))
    else if (action === 'previoustrack' && prev) goTo(prev)
    else if (action === 'nexttrack' && next) goTo(next)
  })
  const hasPrev = !!prev
  const hasNext = !!next
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !name) return
    const ms = navigator.mediaSession
    const cur = title.cur
    const cover = title.media?.coverImage
    const meta = new MediaMetadata({
      title: cur ? [episodeCode(cur), cur.title].filter(Boolean).join(' · ') : bareTitle(name),
      artist: title.media ? mediaTitle(title.media) : '',
      artwork: (
        [
          [cover?.large, '230x345'],
          [cover?.extraLarge, '460x690'],
        ] as const
      ).flatMap(([src, sizes]) => (src ? [{ src, sizes }] : [])),
    })
    ms.metadata = meta
    const on: [MediaSessionAction, boolean][] = [
      ['play', true],
      ['pause', true],
      ['seekto', true],
      ['seekbackward', true],
      ['seekforward', true],
      ['previoustrack', hasPrev],
      ['nexttrack', hasNext],
    ]
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, fn)
      } catch {
        // an action this browser does not know
      }
    }
    for (const [a, ok] of on) set(a, ok ? (d) => sessionAction(a, d) : null)
    return () => {
      // the audio player shares the session: leave it alone once it took over
      if (ms.metadata !== meta) return
      ms.metadata = null
      for (const [a] of on) set(a, null)
    }
  }, [name, title.media, title.cur, hasPrev, hasNext])

  // the bar and the times on the lock screen: without a position the system
  // shows the title alone and nothing to scrub
  useEffect(() => {
    const v = videoRef.current
    if (!v || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    const sync = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration: v.duration,
          playbackRate: v.playbackRate || 1,
          position: Math.min(v.currentTime, v.duration),
        })
      } catch {
        // a position past the end while the duration catches up
      }
    }
    const events = ['loadedmetadata', 'durationchange', 'ratechange', 'seeked', 'play', 'pause']
    for (const e of events) v.addEventListener(e, sync)
    sync()
    return () => {
      for (const e of events) v.removeEventListener(e, sync)
    }
  }, [data])

  const playerRef = useRef<MediaControllerElement>(null)
  // fullscreen goes to the page around this view (see Player), not to the
  // controller that is replaced with every file. Set as a property: the
  // attribute is looked up by id before the controller is in the document.
  const ready = !!data
  useEffect(() => {
    const ctl = playerRef.current
    const page = ctl?.closest<HTMLElement>('.t-player-page')
    if (ctl && page) ctl.fullscreenElement = page
  }, [ready])
  // the focus the last file's player had comes back to this one's picture
  // (media-chrome makes the media element focusable the same way)
  useLayoutEffect(
    () => () => {
      refocus.keep(!!document.activeElement?.closest('media-controller'))
    },
    [refocus],
  )
  useEffect(() => {
    const v = videoRef.current
    if (!ready || !v || !refocus.take()) return
    if (!v.hasAttribute('tabindex')) v.tabIndex = -1
    v.focus({ preventScroll: true })
  }, [ready, refocus])
  // media-chrome's keys (space, k, f, m, arrows) plus the player's own (the
  // controller's hotkeys attribute leaves them to us): j and
  // l skip 10 s, c turns the subtitles off and on, Shift+N and Shift+P change
  // the episode, Escape leaves. Only while focus is inside the player, never
  // page-wide (WCAG 2.1.4).
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const at = e.target as HTMLElement
    if (at.closest('input, textarea, select, [contenteditable], media-chrome-menu, media-settings-menu')) return
    const v = videoRef.current
    if (!v) return
    const skip = (d: number) => {
      v.currentTime = Math.min(Math.max(v.currentTime + d, 0), v.duration || Infinity)
    }
    switch (e.key) {
      case 'j':
        skip(-10)
        break
      case 'l':
        skip(10)
        break
      case 'c':
        if (!data?.subs.length) return
        resumeAt.current = v.currentTime
        if (subKey === 'none') setSub(lastSub ?? (autoSub !== 'none' ? autoSub : subValue(data.subs[0])))
        else {
          setLastSub(subKey)
          setSub('none')
        }
        break
      case 'N':
        if (!e.shiftKey || !next) return
        goTo(next)
        break
      case 'P':
        if (!e.shiftKey || !prev) return
        goTo(prev)
        break
      case 'Escape':
        // an open menu takes Escape itself; fullscreen leaves through the browser
        if (document.fullscreenElement || playerRef.current?.querySelector('.t-player-menu:not([hidden])')) return
        back()
        break
      default:
        return
    }
    e.preventDefault()
  })
  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    const handle = (e: KeyboardEvent) => onKey(e)
    el.addEventListener('keydown', handle)
    return () => el.removeEventListener('keydown', handle)
  }, [data])
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

  // a phone in fullscreen turns to landscape, where a wide picture fills the
  // screen; a portrait video stays upright, and browsers without orientation
  // lock (iOS) simply stay as they are
  useEffect(() => {
    let locked = false
    const turn = () => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      if (!o?.lock) return
      if (!document.fullscreenElement) {
        if (locked) {
          locked = false
          try {
            o.unlock?.()
          } catch {
            // nothing was locked after all
          }
        }
        return
      }
      const v = videoRef.current
      const wide = !v?.videoWidth || v.videoWidth >= v.videoHeight
      if (!matchMedia('(pointer: coarse)').matches || !wide) return
      o.lock('landscape').then(
        () => (locked = true),
        () => {},
      )
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
  // a track once loaded stays at hand: a new size or a switch back draws it
  // again without asking the server
  const subCache = useRef(new Map<string, string | ArrayBuffer>())
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
      const cached = subCache.current.get(url)
      if (cached) return cached
      // the first request starts the server's pass over the whole file: let
      // the picture have the connection to itself until it plays
      if (!played.current) {
        await new Promise<void>((ok) => v.addEventListener('playing', () => ok(), { once: true, signal: abort.signal }))
      }
      for (;;) {
        const r = await fetch(url, { signal: abort.signal })
        if (r.status !== 202) {
          if (!r.ok) throw new Error(r.statusText)
          const body = pgs ? await r.arrayBuffer() : await r.text()
          subCache.current.set(url, body)
          return body
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
        const fontUrl = (i: number) => new URL(`/api/play/font?${src}&index=${i}`, location.href).href
        // a family the script names but the file lacks comes from the web: in
        // libass's one default font a sign is wider than it was placed for
        const embedded = new Set(data.fonts.flatMap((f) => f.names ?? []))
        const missing = scriptFamilies(content).filter((f) => !embedded.has(f))
        const web: Record<string, { family: string; regular: string; bold: string }> = missing.length
          ? await api
              .get<typeof web>(`/api/play/webfonts?${new URLSearchParams(missing.map((f) => ['family', f]))}`)
              .catch(() => ({}))
          : {}
        if (abort.signal.aborted) return
        const absolute = (u: string) => new URL(u, location.href).href
        const r = new JASSUB({
          video: v,
          canvas,
          workerUrl: jassubWorkerUrl,
          subContent: renameFamilies(
            scaleFonts(content, SUB_SIZES[subSize]),
            Object.fromEntries(Object.entries(web).map(([f, w]) => [f, w.family])),
          ),
          // a group release carries tens of megabytes of fonts: a named one
          // is fetched when libass asks for its family, the rest up front
          fonts: data.fonts.filter((f) => !f.names?.length).map((f) => fontUrl(f.index)),
          availableFonts: Object.fromEntries([
            ...Object.values(web).flatMap((w) => [
              [w.family.toLowerCase(), absolute(w.regular)],
              [`${w.family.toLowerCase()} bold`, absolute(w.bold)],
            ]),
            // reversed: of two fonts with one name the first wins
            ...data.fonts.flatMap((f) => (f.names ?? []).map((n) => [n, fontUrl(f.index)])).toReversed(),
          ]),
        })
        renderer = r
        // Firefox hands requestVideoFrameCallback a mediaTime up to half a
        // second ahead of the picture on screen, falling back to it now and
        // then: libass drew the next line, this one, the next again, and every
        // line flickered in and out. Its currentTime is right. Chrome's
        // mediaTime is frame-exact and stays.
        const draw = r.manualRender.bind(r)
        r.manualRender = (d, repaint) =>
          draw(Math.abs(d.mediaTime - v.currentTime) > 0.1 ? { ...d, mediaTime: v.currentTime } : d, repaint)
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
  }, [data, subTrack, burn, server, src, t, subSize])

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
  // press and hold on the picture plays at 2x, see playerHold
  const [holding, setHolding] = useState(false)
  useEffect(() => {
    const player = playerRef.current
    return player ? attachHold(player, () => videoRef.current, setHolding) : undefined
  }, [data])
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

  // before the file is read the page already stands: the black frame with
  // the way out, so a phone is never left in an empty overlay
  const frame = (body: ReactNode) => (
    <>
      <div className="t-player-wrap">
        <div className="t-player t-player--idle">
          <div className="t-player-top">
            <button type="button" className="t-pl-ic t-player-back" aria-label={t('nav.back')} onClick={back}>
              <ArrowLeft aria-hidden size={22} />
            </button>
            <span className="t-player-title">
              <b>{bareTitle(name)}</b>
            </span>
          </div>
          <div className="t-player-idle">{body}</div>
        </div>
      </div>
    </>
  )
  if (!path) return frame(<p>{t('player.noFile')}</p>)
  if (info.isPending)
    return frame(
      <>
        <span className="t-player-logo">
          <Logo play={false} active />
        </span>
        <span className="t-player-step" role="status">
          <Waited text={t('player.stepInfo')} detail={statusDetail} />
        </span>
      </>,
    )
  const conflict = data ? undefined : keyConflictOf(info.error)
  if (conflict)
    return frame(
      <HostKeyPrompt
        className="m-4 text-start"
        serverId={server}
        conflict={conflict}
        onAccepted={() => info.refetch()}
        onRejected={() => navigate(-1)}
      />,
    )
  if (!data)
    return frame(
      <p className="t-player-step t-player-step--err" role="alert">
        {info.error?.message}
      </p>,
    )

  const subLabel = subTrack ? trackLabel(subTrack, 0) : t('player.subOff')
  const audioTrack = data?.audio.find((a) => a.index === audioIdx)
  const audioLabel = audioTrack ? trackLabel(audioTrack, 0) : ''
  const v = data.video
  const facts = [
    v && `${CODEC_NAMES[v.codec] ?? v.codec.toUpperCase()}${v.pixFmt?.includes('10') ? ' 10-bit' : ''}`,
    v && v.height > 0 && `${v.height}p`,
  ].filter(Boolean)
  const mode = !hls ? 'direct' : copy ? 'copy' : 'transcode'

  const serverName = server
    ? (servers.data?.find((x) => x.id === server)?.name ?? t('player.remote'))
    : t('player.local')
  // the title row: the series, and under it which episode this is
  const base = bareTitle(name)
  const heading = title.media ? mediaTitle(title.media) : base
  const subline = title.cur ? episodeCode(title.cur) : title.media ? base : ''
  const rateLabel = (r: number) =>
    r === 1 ? t('player.rateNormal') : `${new Intl.NumberFormat(i18n.language).format(r)}×`
  const sizeLabel = (k: SubSize) => t(`player.subSize_${k}`)
  const textSubs = data.subs.some((s) => !s.image)

  return (
    <>
      <div className="t-player-wrap">
        <MediaController
          ref={playerRef}
          lang={i18n.language}
          className="t-player"
          data-fs={ownFs || undefined}
          // media-chrome's hotkeys (space, k, f, m, arrows) act only while focus is
          // inside the player, never page-wide (WCAG 2.1.4). j, l and c it knows
          // as well (seek 10 s, subtitles): they are handled in onKey, so they
          // are switched off there or a press would count twice
          hotkeys="noj nol noc"
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
          >
            {chaptersText && <track key={chaptersText} kind="chapters" default ref={chaptersTrack} />}
          </video>

          <div slot="top-chrome" className="t-player-top">
            {/* the only way out on a phone, where the player has the whole screen */}
            <button type="button" className="t-pl-ic t-player-back" aria-label={t('nav.back')} onClick={back}>
              <ArrowLeft aria-hidden size={22} />
            </button>
            <span className="t-player-title" title={path}>
              <b>{heading}</b>
              {subline && <span>{subline}</span>}
            </span>
            <span className="t-player-chips">
              <span className="t-player-chip" title={server ? t('player.fromServer') : t('player.fromLocal')}>
                {serverName}
              </span>
              {facts.map((f) => (
                <span key={f as string} className="t-player-chip">
                  {f}
                </span>
              ))}
              <span
                className="t-player-chip t-player-mode"
                data-mode={mode}
                title={mode === 'transcode' ? t('player.transcoding') : undefined}
              >
                {t(`player.mode_${mode}`)}
              </span>
            </span>
            {mutedStart && (
              <button
                type="button"
                className="t-player-pill t-player-pill--go"
                ref={keepFocusInPlayer}
                onClick={() => {
                  const v = videoRef.current
                  if (v) v.muted = false
                }}
              >
                {t('player.unmute')}
              </button>
            )}
            {subPending && (
              <span className="t-player-pill" role="status">
                {t('player.subLoading')}
              </span>
            )}
            {subError && (
              <span className="t-player-pill t-player-pill--err" role="alert">
                {subError}
              </span>
            )}
          </div>

          {/* noautohide: a double-tap flash must show while the controls are away;
            the big play button has its own paused-only rule */}
          <div slot="centered-chrome" className="t-player-center" {...{ noautohide: '' }}>
            <span className="t-player-hold" data-on={holding || undefined} role="status">
              {holding && rateLabel(HOLD_RATE)}
            </span>
            <span className="t-player-flash" data-side="back" data-on={flash?.side === 'back' || undefined} aria-hidden>
              {flash?.side === 'back' && `- ${flash.secs} s`}
            </span>
            {/* the mark with its sheen instead of a spinner: the app's own sign
                for "working on it", drawn in CSS, so nothing runs while hidden */}
            {!loadError && (
              <MediaLoadingIndicator noAutohide className="t-player-spinner">
                <span slot="icon" className="t-player-logo">
                  <Logo play={false} active />
                </span>
              </MediaLoadingIndicator>
            )}
            {/* always words under the mark: canplay, playing or a seek clear
                the step while the buffer can still be empty (hls.js jumps a
                gap at the start of a transcode), and the mark alone told
                nothing. CSS hides them once media-chrome is done loading. */}
            <span
              className={`t-player-step${loadError ? ' t-player-step--err' : ''}`}
              role={loadError ? 'alert' : 'status'}
            >
              {loadError ? (
                t('player.loadError')
              ) : (
                <Waited key={loadStep} text={t(loadStep || serverStep)} detail={statusDetail} />
              )}
            </span>
            <MediaPlayButton className="t-player-bigplay" />
            <span className="t-player-flash" data-side="fwd" data-on={flash?.side === 'fwd' || undefined} aria-hidden>
              {flash?.side === 'fwd' && `+ ${flash.secs} s`}
            </span>
          </div>

          {/* the offer to go on, and the count to the next episode, as cards
              over the corner above the dock; they stay while the controls fade */}
          {nextIn !== null && next ? (
            <div className="t-player-card" ref={keepFocusInPlayer} {...{ noautohide: '' }}>
              {/* spoken once by the region below; the count itself is only seen */}
              <span aria-hidden>{t('player.nextIn', { secs: nextIn })}</span>
              <button type="button" className="t-player-card-btn t-player-card-btn--go" onClick={() => goTo(next)}>
                {t('player.nextNow')}
              </button>
              <button
                type="button"
                className="t-pl-ic t-pl-ic--sm"
                aria-label={t('player.nextCancel')}
                onClick={() => setNextIn(null)}
              >
                <X aria-hidden size={18} />
              </button>
            </div>
          ) : (
            offer !== null && (
              <div
                className="t-player-card"
                ref={keepFocusInPlayer}
                onFocus={() => setOfferHeld(true)}
                onBlur={() => setOfferHeld(false)}
                onPointerEnter={() => setOfferHeld(true)}
                onPointerLeave={() => setOfferHeld(false)}
                {...{ noautohide: '' }}
              >
                <span>{t('player.resumeAt', { time: clock(offer) })}</span>
                <button type="button" className="t-player-card-btn t-player-card-btn--go" onClick={resume}>
                  {t('player.resume')}
                </button>
                <button type="button" className="t-player-card-btn" onClick={() => setResumeOffer(null)}>
                  {t('player.restart')}
                </button>
              </div>
            )
          )}
          {/* always there, only its words change: a live region added together
              with its text is often not read out */}
          <span className="sr-only" role="status">
            {nextIn !== null && next
              ? t('player.nextIn', { secs: NEXT_COUNT })
              : offer !== null
                ? t('player.resumeAt', { time: clock(offer) })
                : skipOffered && t(skipOffered.kind === 'op' ? 'player.playingOp' : 'player.playingEd')}
          </span>
          {skipOffered && (
            <div className="t-player-card" ref={keepFocusInPlayer} {...{ noautohide: '' }}>
              <button type="button" className="t-player-card-btn t-player-card-btn--go" onClick={skipChapter}>
                {t(skipOffered.kind === 'op' ? 'player.skipOp' : 'player.skipEd')}
              </button>
              <button
                type="button"
                className="t-pl-ic t-pl-ic--sm"
                aria-label={t('player.skipDismiss')}
                onClick={dismissSkip}
              >
                <X aria-hidden size={18} />
              </button>
            </div>
          )}

          {/* subtitles and audio are a tap away, each its own menu; the rest
              (episodes, speed, subtitle size) stays behind the sliders */}
          <QuickMenu
            id="pl-subs"
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
          {data.audio.length > 1 && (
            <QuickMenu
              id="pl-audio"
              title={t('player.audio')}
              value={String(audioIdx)}
              options={data.audio.map((a, i) => ({ value: String(a.index), label: trackLabel(a, i) }))}
              onChange={(val) => {
                resumeAt.current = videoRef.current?.currentTime ?? 0
                setAudio(Number(val))
              }}
            />
          )}
          <MediaSettingsMenu hidden anchor="auto" className="t-player-menu">
            {episodes.length > 1 && (
              <MediaSettingsMenuItem>
                {t('player.episodes')}
                <span slot="description">{title.cur ? episodeCode(title.cur) : at >= 0 ? at + 1 : ''}</span>
                <TrackMenu
                  title={t('player.episodes')}
                  value={at >= 0 ? episodes[at].path : ''}
                  options={episodes.map((e) => ({ value: e.path, label: bareTitle(e.name) }))}
                  onChange={(p) => goTo({ path: p })}
                />
              </MediaSettingsMenuItem>
            )}
            <MediaSettingsMenuItem>
              {t('player.speed')}
              <span slot="description">{rateLabel(rate)}</span>
              {/* the same menu as the tracks: media-chrome's rate menu draws its
                  items in its own shadow, out of reach of the menu's styling */}
              <TrackMenu
                title={t('player.speed')}
                value={String(rate)}
                options={RATES.map((r) => ({ value: String(r), label: rateLabel(r) }))}
                onChange={(val) => {
                  const v = videoRef.current
                  setRate(Number(val))
                  if (v) v.playbackRate = v.defaultPlaybackRate = Number(val)
                }}
              />
            </MediaSettingsMenuItem>
            {textSubs && (
              <MediaSettingsMenuItem>
                {t('player.subSize')}
                <span slot="description">{sizeLabel(subSize)}</span>
                <TrackMenu
                  title={t('player.subSize')}
                  value={subSize}
                  options={(Object.keys(SUB_SIZES) as SubSize[]).map((k) => ({ value: k, label: sizeLabel(k) }))}
                  onChange={(val) => {
                    resumeAt.current = videoRef.current?.currentTime ?? 0
                    setSubSize(val as SubSize)
                  }}
                />
              </MediaSettingsMenuItem>
            )}
          </MediaSettingsMenu>

          <div className="t-player-dock">
            <MediaControlBar className="t-player-scrub">
              <MediaTimeRange>
                {/* slotting the preview replaces media-chrome's own, chapter title included */}
                <MediaPreviewChapterDisplay slot="preview" />
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
              {/* a narrow player shows the current time only (CSS picks one) */}
              <MediaTimeDisplay showDuration className="t-player-time t-player-time--full" />
              <MediaTimeDisplay className="t-player-time t-player-time--short" />
              {chapterName && (
                <span className="t-player-chapter" title={chapterName}>
                  {chapterName}
                </span>
              )}
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
                    className="t-player-btn t-player-nextep"
                    aria-label={t('player.nextEpisode')}
                    title={next ? `${t('player.nextEpisode')}: ${next.name}` : t('player.nextEpisode')}
                    disabled={!next}
                    onClick={() => next && goTo(next)}
                  >
                    <SkipForward aria-hidden size={20} />
                  </button>
                </>
              )}
              {data.subs.length > 0 && (
                <MediaChromeMenuButton
                  invokeTarget="pl-subs"
                  className="t-player-cc"
                  data-on={subKey !== 'none' || undefined}
                  aria-label={`${t('player.subtitles')}: ${subLabel}`}
                  title={`${t('player.subtitles')}: ${subLabel}`}
                >
                  <span className="t-player-icon t-player-icon--morph" key={subKey === 'none' ? 'off' : 'on'}>
                    {subKey === 'none' ? <CaptionsOff aria-hidden /> : <Captions aria-hidden />}
                  </span>
                </MediaChromeMenuButton>
              )}
              {data.audio.length > 1 && (
                <MediaChromeMenuButton
                  invokeTarget="pl-audio"
                  className="t-player-audio"
                  aria-label={`${t('player.audio')}: ${audioLabel}`}
                  title={`${t('player.audio')}: ${audioLabel}`}
                >
                  <span className="t-player-icon">
                    <AudioLines aria-hidden />
                  </span>
                </MediaChromeMenuButton>
              )}
              <MediaSettingsMenuButton aria-label={t('player.more')} title={t('player.more')}>
                <span slot="icon" className="t-player-icon">
                  <SlidersHorizontal aria-hidden />
                </span>
              </MediaSettingsMenuButton>
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
              {OWN_FULLSCREEN ? (
                <button
                  type="button"
                  className="t-player-btn"
                  aria-pressed={ownFs}
                  aria-label={t(ownFs ? 'viewer.exitFullscreen' : 'viewer.fullscreen')}
                  title={t(ownFs ? 'viewer.exitFullscreen' : 'viewer.fullscreen')}
                  onClick={() => setOwnFs((x) => !x)}
                >
                  {ownFs ? <Minimize aria-hidden size={20} /> : <Maximize aria-hidden size={20} />}
                </button>
              ) : (
                <MediaFullscreenButton />
              )}
            </MediaControlBar>
          </div>
        </MediaController>
      </div>
      <PlayerInfo
        server={server}
        path={path}
        info={data}
        files={episodes}
        at={at}
        title={title}
        onPick={goTo}
        audioIdx={audioIdx}
        sub={subTrack}
        mode={mode}
        burned={burn >= 0}
        serverName={serverName}
      />
    </>
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
          <Check slot="suffix" aria-hidden className="t-pm-check" />
        </MediaChromeMenuItem>
      ))}
    </MediaChromeMenu>
  )
}

// A menu of its own, opened straight from its button in the bar.
function QuickMenu({
  id,
  title,
  value,
  options,
  onChange,
}: {
  id: string
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
    // no anchor: the dock rules of .t-player-menu place it, as the settings
    // menu sits, and not pinned over its button, which runs off a short player
    <MediaChromeMenu ref={ref} id={id} hidden className="t-player-menu">
      <div slot="title">{title}</div>
      {options.map((o) => (
        <MediaChromeMenuItem
          key={o.value}
          type="radio"
          value={o.value}
          aria-checked={o.value === value ? 'true' : 'false'}
        >
          {o.label}
          <Check slot="suffix" aria-hidden className="t-pm-check" />
        </MediaChromeMenuItem>
      ))}
    </MediaChromeMenu>
  )
}

function subValue(s: PlayTrack): string {
  return s.file ? `f:${s.file}` : `t:${s.index}`
}
