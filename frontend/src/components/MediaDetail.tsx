import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ExternalLink, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mediaDescription, providerName, type Airing, type Media, type MediaExtras } from '../api'
import { countdown } from '../countdown'
import { focusPosition } from './bannerFocus'
import type { Schemas } from '../api.gen'
import SourceLine from './SourceLine'
import anilistMark from '../assets/providers/anilist.svg'
import tmdbMark from '../assets/providers/tmdb.svg'
import tvdbMark from '../assets/providers/tvdb.png'

// source-dependent external link: the provider the match came from
export const mediaLink = (source: string | undefined, id: number) =>
  source?.startsWith('tmdb:')
    ? {
        href: `https://www.themoviedb.org/${source.slice(5)}/${id}`,
        label: 'TMDB',
        icon: tmdbMark,
        color: '#0d253f',
        wide: true,
      }
    : source?.startsWith('tvdb')
      ? {
          // TVDB's own pages are slugs; the by-id address redirects there
          href: `https://thetvdb.com/dereferrer/${source === 'tvdb:movie' ? 'movie' : 'series'}/${id}`,
          label: 'TVDB',
          icon: tvdbMark,
          color: '#fff',
          wide: true,
        }
      : { href: `https://anilist.co/anime/${id}`, label: 'AniList', icon: anilistMark, color: '#0b1622' }

// AniList's YYYYMMDD as "12. Oktober 2026"; a month or a bare year stay short
export const fuzzyDate = (d?: number) => {
  if (!d) return ''
  const y = Math.floor(d / 10000)
  const m = Math.floor((d % 10000) / 100)
  const day = d % 100
  if (!m) return String(y)
  return new Date(y, m - 1, day || 1).toLocaleDateString(
    [],
    day ? { year: 'numeric', month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long' },
  )
}

// a description longer than this folds to a few lines behind "read more"
const LONG = 320

/** AniList descriptions still carry some inline HTML: the browser's parser makes it text. */
export const plainText = (html: string) =>
  new DOMParser()
    .parseFromString(html.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
    .body.textContent?.replace(/\n\s*\n(\s*\n)+/g, '\n\n')
    .trim() ?? ''

/** "heute", "morgen" or the weekday with the date, for a release time. */
export function dayWord(t: (k: string) => string, ms: number, now: number) {
  const day = (x: number) => new Date(x).setHours(0, 0, 0, 0)
  const diff = Math.round((day(ms) - day(now)) / 86_400_000)
  if (diff === 0) return t('series.day.today')
  if (diff === 1) return t('series.day.tomorrow')
  return new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric' })
}

/**
 * The overview of a title: the description (folded when long), the facts,
 * the next releases, the outbound links and the trailer, then whatever the
 * caller adds (the catalog's folder versions). The head of the page lives in
 * the detail itself.
 */
export default function MediaDetail({
  media: m,
  source,
  airings,
  links,
  now,
  bannerFocus,
  dubDates,
  mappedBy,
  failed,
  children,
}: {
  media: Media
  source?: string
  /** the upcoming releases the watch behind the title knows of */
  airings?: Airing[]
  links?: MediaExtras['links']
  /** the clock behind the countdowns, from useNow */
  now: number
  /** where the banner's detail lies, to cut the trailer's picture by */
  bannerFocus?: Schemas['api.bannerFocus']
  /** the watch's dub slots (Crunchyroll's) */
  dubDates?: boolean
  /** tvdb or tmdb: what the watch numbers its episodes by */
  mappedBy?: string
  /** the full record could not be fetched: no description is not the same as none known */
  failed?: boolean
  children?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const src = providerName(source)
  const text = mediaDescription(m, i18n.language)
  const desc = text ? plainText(text) : ''
  const long = desc.length > LONG
  // the title's own schedule: the dub slots a watch adds belong to the calendar
  const upcoming = (airings ?? []).filter((a) => a.at * 1000 > now && !a.dub).slice(0, 3)
  const next =
    upcoming.length === 0 && m.nextAiringEpisode
      ? [{ at: m.nextAiringEpisode.airingAt, episode: m.nextAiringEpisode.episode }]
      : upcoming
  const start = fuzzyDate(m.startDate)
  const end = fuzzyDate(m.endDate)
  const format = m.format ? t(`series.format.${m.format}`, m.format) : ''
  const facts: [string, string][] = (
    [
      [t('series.fact.studio'), m.studios?.join(', ') ?? ''],
      [
        t('series.fact.period'),
        start
          ? end
            ? t('series.period.range', { a: start, b: end })
            : m.status === 'RELEASING'
              ? t('series.period.running', { a: start })
              : start
          : '',
      ],
      [
        t('series.fact.format'),
        format && m.episodes > 1 ? t('series.formatEps', { format, count: m.episodes }) : format,
      ],
      [
        t('series.fact.score'),
        m.averageScore > 0
          ? m.popularity
            ? t('series.scoreLine', { s: m.averageScore, n: m.popularity.toLocaleString(), source: src })
            : t('series.scoreOnly', { s: m.averageScore })
          : '',
      ],
      [t('series.fact.genres'), m.genres?.join(', ') ?? ''],
    ] as [string, string][]
  ).filter(([, v]) => v)
  // streaming first: that is the link a reader is after
  const streaming = (links ?? []).filter((x) => x.type === 'STREAMING')
  const other = (links ?? []).filter((x) => x.type !== 'STREAMING')
  const own = mediaLink(source, m.id)
  return (
    <>
      <p className="ws-d-desc" data-long={long} data-open={open || undefined} id={`ws-desc-${m.id}`}>
        {desc || (failed ? t('series.unavailable', { source: src }) : t('series.noDesc', { source: src }))}
      </p>
      {long && (
        <button
          type="button"
          className="t-link"
          aria-expanded={open}
          aria-controls={`ws-desc-${m.id}`}
          onClick={() => setOpen(!open)}
        >
          {open ? t('series.desc.less') : t('series.desc.more')}
        </button>
      )}
      {facts.length > 0 && (
        <dl className="ws-d-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {next.length > 0 && (
        <>
          <h3 className="ws-d-h3">{t('series.upcoming')}</h3>
          <ul className="ws-d-sched">
            {next.map((a) => (
              <li key={`${a.episode}-${a.at}`}>
                <span className="ws-mono">F{a.episode}</span>
                <time dateTime={new Date(a.at * 1000).toISOString()}>
                  {dayWord(t, a.at * 1000, now)},{' '}
                  {new Date(a.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
                <span className="ws-d-quiet">{countdown(t, a.at, false, now)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="ws-d-h3">{t('series.watchMore')}</h3>
      <ul className="ws-d-links">
        {m.trailer?.site === 'dailymotion' && (
          <li>
            <a href={`https://www.dailymotion.com/video/${m.trailer.id}`} target="_blank" rel="noreferrer">
              <Play aria-hidden size="1rem" />
              <span>{t('series.link.trailer')}</span>
              <span className="ws-d-quiet">Dailymotion</span>
            </a>
          </li>
        )}
        {streaming.map((x) => (
          <li key={x.url}>
            <a href={x.url} target="_blank" rel="noreferrer">
              <LinkMark link={x} dot />
              <span>{x.site}</span>
              <span className="ws-d-quiet">
                {t('series.link.stream')}
                {x.language ? ` · ${x.language}` : ''}
              </span>
            </a>
          </li>
        ))}
        {other.map((x) => (
          <li key={x.url}>
            <a href={x.url} target="_blank" rel="noreferrer">
              <LinkMark link={x} />
              <span>{x.site}</span>
              <span className="ws-d-quiet">
                {x.type === 'SOCIAL' ? t('series.link.social') : t('series.link.info')}
              </span>
            </a>
          </li>
        ))}
        <li>
          <a href={own.href} target="_blank" rel="noreferrer">
            <LinkMark link={own} wide={own.wide} />
            <span>{own.label}</span>
            <span className="ws-d-quiet">{t('series.link.info')}</span>
          </a>
        </li>
      </ul>
      {m.trailer?.site === 'youtube' && <Trailer id={m.trailer.id} art={m.bannerImage} focus={bannerFocus} />}
      {children}
      <SourceLine primary={own} dubDates={dubDates} mappedBy={mappedBy} />
    </>
  )
}

/**
 * The marker in front of an outbound link: AniList's brand mark (its white
 * glyph on a square in the site's colour) when it has an icon, else a dot for
 * a streaming link and the external-link glyph for the rest. Purely decorative.
 */
function LinkMark({
  link,
  dot,
  wide,
}: {
  link: { icon?: string | null; color?: string | null }
  dot?: boolean
  wide?: boolean
}) {
  const [broken, setBroken] = useState(false)
  if (link.icon && !broken)
    return (
      <span
        aria-hidden
        className="ws-d-mark"
        data-wide={wide || undefined}
        style={{ '--lc': link.color || undefined } as CSSProperties}
      >
        <img src={link.icon} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      </span>
    )
  return dot ? (
    <span aria-hidden className="ws-d-dot" style={{ '--lc': link.color || undefined } as CSSProperties} />
  ) : (
    <ExternalLink aria-hidden size="1rem" />
  )
}

/**
 * The trailer behind a play button: the YouTube player is only built once
 * asked for. On Android the cross-origin frame shares the page's main thread,
 * and the player's scripts held it for hundreds of milliseconds right while
 * the series page opened. Until then nothing is sent to YouTube either.
 */
function Trailer({ id, art, focus }: { id: string; art?: string | null; focus?: Schemas['api.bannerFocus'] }) {
  const { t } = useTranslation()
  const [on, setOn] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  // the button it replaces had the focus: the player takes it over, once
  // (an inline ref callback would pull it back on every render)
  useEffect(() => {
    if (on) frame.current?.focus({ preventScroll: true })
  }, [on])
  // the box is 16:9 whatever the width
  const at = focusPosition(focus, 16, 9)
  if (!on)
    return (
      <button type="button" className="ws-d-trailer ws-d-trailer-btn" onClick={() => setOn(true)}>
        {art && (
          <img
            src={art}
            style={{ objectPosition: `${at.x ?? '50%'} ${at.y ?? '50%'}` }}
            alt=""
            decoding="async"
            loading="lazy"
          />
        )}
        <span className="ws-d-trailer-play">
          <Play aria-hidden size="1.25rem" />
          {t('remote.trailerPlay')}
        </span>
      </button>
    )
  return (
    <iframe
      ref={frame}
      className="ws-d-trailer"
      title={t('remote.trailer')}
      src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
      // the page sends no referrer at all, which the player rejects
      // with "error 153"; this hands it the bare origin, no path
      referrerPolicy="strict-origin"
      // the player needs its scripts and its own origin (without the
      // latter it is a black box); popups are the "watch on YouTube"
      // link, which opens a normal tab, not a sandboxed one. Forms,
      // downloads and navigating the page stay blocked. The rule
      // objects to scripts plus origin together, which for a
      // cross-origin frame is still a sandbox
      // eslint-disable-next-line react/iframe-missing-sandbox
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
      allow="autoplay; encrypted-media; fullscreen"
      allowFullScreen
    />
  )
}
