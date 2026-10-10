import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import HlsPlayer from 'hls.js'
import JASSUB from 'jassub'
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'
import { addTranslation, setLanguage } from 'media-chrome/dist/utils/i18n.js'
import { De } from 'media-chrome/dist/lang/de.js'
import { api, keyConflictOf } from '../api'
import PillSelect from '../components/PillSelect'
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

  // source: the raw file, or the transcoded playlist through hls.js
  useEffect(() => {
    const v = videoRef.current
    if (!v || !data) return
    const start = resumeAt.current
    const onMeta = () => {
      if (start > 0) v.currentTime = start
      v.play().catch(() => {})
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

  // text subtitles: ASS from the server, rendered by libass with the file's fonts
  const [subError, setSubError] = useState('')
  useEffect(() => {
    const v = videoRef.current
    if (!v || !data || !subTrack || subTrack.image) return
    let renderer: JASSUB | null = null
    let dead = false
    setSubError('')
    const url = subTrack.file
      ? `/api/play/sub?server=${server}&path=${encodeURIComponent(subTrack.file)}`
      : `/api/play/sub?${src}&track=${subTrack.index}`
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((content) => {
        if (dead) return
        renderer = new JASSUB({
          video: v,
          subContent: content,
          fonts: data.fonts.map((i) => new URL(`/api/play/font?${src}&index=${i}`, location.href).href),
        })
      })
      .catch(() => !dead && setSubError(t('player.subError')))
    return () => {
      dead = true
      renderer?.destroy()
    }
  }, [data, subTrack, server, src, t])

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

  return (
    <div className="flex flex-col gap-3">
      <MediaController
        lang={i18n.language}
        className="aspect-video w-full overflow-hidden rounded-[var(--r-md)] bg-black [&:fullscreen]:aspect-auto"
      >
        {/* captions are libass on a canvas over the picture: a <track> cannot
            carry ASS styling, positioning or the file's fonts */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} slot="media" playsInline />
        <MediaLoadingIndicator slot="centered-chrome" noAutohide />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={10} />
          <MediaSeekForwardButton seekOffset={10} />
          <MediaTimeRange />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaPipButton />
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-t-secondary" title={path}>
          {name}
        </span>
        {data.audio.length > 1 && (
          <PillSelect
            label={t('player.audio')}
            value={String(audioIdx)}
            options={data.audio.map((a, i) => ({ value: String(a.index), label: trackLabel(a, i) }))}
            onChange={(v) => {
              resumeAt.current = videoRef.current?.currentTime ?? 0
              setAudio(Number(v))
            }}
          />
        )}
        {data.subs.length > 0 && (
          <PillSelect
            label={t('player.subtitles')}
            value={subKey}
            options={[
              { value: 'none', label: t('player.subOff') },
              ...data.subs.map((s, i) => ({ value: subValue(s), label: trackLabel(s, i) })),
            ]}
            onChange={(v) => {
              resumeAt.current = videoRef.current?.currentTime ?? 0
              setSub(v)
            }}
          />
        )}
      </div>
      {hls && <p className="text-xs text-t-muted">{t('player.transcoding')}</p>}
      {subError && (
        <p className="text-xs text-err" role="alert">
          {subError}
        </p>
      )}
    </div>
  )
}

function subValue(s: PlayTrack): string {
  return s.file ? `f:${s.file}` : `t:${s.index}`
}
