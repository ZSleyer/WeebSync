import { type ReactNode } from 'react'
import { ExternalLink, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, ButtonLink } from '@weebsync/design-system'
import type { Airing, Media, MediaExtras } from '../api'
import { countdown } from '../countdown'

// source-dependent external link (AniList for anime, TMDB for marked folders)
export const mediaLink = (source: string | undefined, id: number) =>
  source?.startsWith('tmdb:')
    ? { href: `https://www.themoviedb.org/${source.slice(5)}/${id}`, label: 'TMDB' }
    : { href: `https://anilist.co/anime/${id}`, label: 'AniList' }

// AniList's YYYYMMDD, rendered in the reader's locale; 0 or a bare year stay short
const fuzzyDate = (d?: number) => {
  if (!d) return ''
  const y = Math.floor(d / 10000)
  const m = Math.floor((d % 10000) / 100)
  const day = d % 100
  if (!m) return String(y)
  return new Date(y, m - 1, day || 1).toLocaleDateString([], day ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { year: 'numeric', month: 'long' })
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-border-subtle pt-4 first:mt-0 first:border-0 first:pt-0">
      <h4 className="t-label mb-2">{title}</h4>
      {children}
    </section>
  )
}

/**
 * The overview of a title: description, studios and dates, the next
 * releases, the outbound links, the trailer, then whatever the caller adds
 * (the catalog's folder versions). The head of the card lives in the dialog.
 */
export default function MediaDetail({
  media: m,
  source,
  airings,
  links,
  now,
  children,
}: {
  media: Media
  source?: string
  /** the upcoming releases the watch behind the title knows of */
  airings?: Airing[]
  links?: MediaExtras['links']
  /** the clock behind the countdowns, from useNow */
  now: number
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const l = mediaLink(source, m.id)
  const upcoming = (airings ?? []).filter((a) => a.at * 1000 > now).slice(0, 5)
  const next = upcoming.length === 0 && m.nextAiringEpisode ? [{ at: m.nextAiringEpisode.airingAt, episode: m.nextAiringEpisode.episode }] : upcoming
  const facts = [
    m.studios?.length ? [t('series.studios'), m.studios.join(', ')] : null,
    m.startDate ? [t('series.aired'), [fuzzyDate(m.startDate), fuzzyDate(m.endDate)].filter(Boolean).join(' bis ')] : null,
  ].filter((f): f is string[] => !!f)
  // streaming first: that is the link a reader is after; the rest stays a
  // muted second row
  const streaming = (links ?? []).filter((x) => x.type === 'STREAMING')
  const other = (links ?? []).filter((x) => x.type !== 'STREAMING')
  return (
    <div className="p-5">
      {m.description && (
        <Section title={t('remote.description')}>
          <p className="text-sm whitespace-pre-line text-t-secondary">
            {/* AniList descriptions still carry some inline HTML; strip via
                the browser's own parser (rendered as a text node, never HTML) */}
            {new DOMParser()
              .parseFromString(m.description.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
              .body.textContent}
          </p>
        </Section>
      )}
      {facts.length > 0 && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border-subtle pt-4 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-t-muted">{k}</dt>
              <dd className="min-w-0 text-t-secondary">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {next.length > 0 && (
        <Section title={t('series.upcoming')}>
          <ul className="grid gap-1 text-sm">
            {next.map((a) => (
              <li key={`${a.episode}-${a.at}`} className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-t-primary">{t('watch.chipEp', { n: a.episode })}</span>
                <span className="font-mono text-xs text-t-secondary">
                  {new Date(a.at * 1000).toLocaleString([], { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-xs text-accent">{countdown(t, a.at, false, now)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t('series.links')}>
        <div className="flex flex-wrap gap-1.5">
          <ButtonLink size="sm" className="inline-flex items-center gap-1.5" href={l.href} target="_blank" rel="noreferrer">
            {l.label} #{m.id}
            <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
          </ButtonLink>
          {streaming.map((x) => (
            <ButtonLink key={x.url} size="sm" className="inline-flex items-center gap-1.5" href={x.url} target="_blank" rel="noreferrer">
              <Play aria-hidden size="1em" fill="currentColor" strokeWidth={0} />
              {x.site}
              {x.language && <span className="text-t-muted">{x.language}</span>}
            </ButtonLink>
          ))}
        </div>
        {other.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-x-3 text-xs">
            {/* min-h-6: a text link is 18px tall, the target floor is 24 (WCAG 2.5.8) */}
            {other.map((x) => (
              <a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center text-t-secondary underline decoration-border-input hover:text-t-primary">
                {x.site}
              </a>
            ))}
          </p>
        )}
      </Section>
      {(m.trailer?.site === 'youtube' || m.trailer?.site === 'dailymotion') && (
        <Section title={t('remote.trailer')}>
          {m.trailer?.site === 'youtube' && (
            <iframe
              className="aspect-video w-full"
              title={t('remote.trailer')}
              src={`https://www.youtube-nocookie.com/embed/${m.trailer.id}`}
              // the page sends no referrer at all, which the player rejects
              // with "error 153"; this hands it the bare origin, no path
              referrerPolicy="strict-origin"
              allow="encrypted-media; fullscreen"
              allowFullScreen
            />
          )}
          {m.trailer?.site === 'dailymotion' && (
            <ButtonLink
              size="sm"
              className="inline-flex items-center gap-2"
              href={`https://www.dailymotion.com/video/${m.trailer.id}`}
              target="_blank"
              rel="noreferrer"
            >
              <Play aria-hidden size="1em" className="inline align-[-0.125em]" fill="currentColor" strokeWidth={0} /> {t('remote.trailer')}
              {m.trailer.thumbnail && <img src={m.trailer.thumbnail} alt="" className="h-6 object-cover" />}
              <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
            </ButtonLink>
          )}
        </Section>
      )}
      {children}
    </div>
  )
}

/** The genre chips, for the card head. */
export function GenreChips({ genres }: { genres?: string[] }) {
  if (!genres?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {genres.map((g) => (
        <Badge key={g}>{g}</Badge>
      ))}
    </div>
  )
}
