import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clock, ExternalLink, Pause, Play, Radio, Star, X, type LucideIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ButtonLink } from '@weebsync/design-system'
import { api, mediaTitle, type Media, type Review } from '../api'

// icon per AniList airing status, shown inside the t-label chip
const MEDIA_STATUS_ICON: Record<string, LucideIcon> = {
  RELEASING: Radio,
  FINISHED: Check,
  NOT_YET_RELEASED: Clock,
  CANCELLED: X,
  HIATUS: Pause,
}

// source-dependent external link (AniList for anime, TMDB for marked folders)
const mediaLink = (source: string | undefined, id: number) =>
  source?.startsWith('tmdb:')
    ? { href: `https://www.themoviedb.org/${source.slice(5)}/${id}`, label: 'TMDB' }
    : { href: `https://anilist.co/anime/${id}`, label: 'AniList' }

// MediaDetail is a title's full card: banner, cover, chips, genres, provider
// link, description, trailer and community reviews. The catalog's detail
// dialog appends its folder versions as children; the assistant shows it as
// is. Reviews load lazily with the component, never with a grid.
export default function MediaDetail({ media: m, source, children }: { media: Media; source?: string; children?: ReactNode }) {
  const { t } = useTranslation()
  const MediaStatusIcon = m.status ? MEDIA_STATUS_ICON[m.status] : undefined
  const [allReviews, setAllReviews] = useState(false)
  const { data: rev } = useQuery<{ reviews: Review[] }>({
    queryKey: ['reviews', source ?? 'anilist', m.id],
    queryFn: () => api.get(`/api/media/reviews?source=${source ?? 'anilist'}&id=${m.id}`),
    staleTime: 5 * 60_000,
  })
  return (
    <>
      {m.bannerImage && <img src={m.bannerImage} alt="" className="max-h-36 w-full object-cover" />}
      <div className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          {m.coverImage?.large && <img src={m.coverImage.large} alt="" className="h-40 w-28 shrink-0 object-cover" />}
          <div className="min-w-0">
            <h3 className="font-display font-semibold tracking-wider">{mediaTitle(m)}</h3>
            {m.title.english &&
              mediaTitle({ title: { english: m.title.english } }) === m.title.english &&
              m.title.english !== mediaTitle(m) && (
                <p className="text-sm text-t-muted">{m.title.english}</p>
              )}
            <div className="mt-2 flex flex-wrap gap-1">
              {m.seasonYear > 0 && <Badge>{m.seasonYear}</Badge>}
              {m.format && <Badge>{m.format}</Badge>}
              {m.episodes > 0 && <Badge>{m.episodes} EP</Badge>}
              {m.status && (
                <Badge>
                  {MediaStatusIcon && <MediaStatusIcon aria-hidden size="1em" />}
                  {t(`remote.status.${m.status}`, m.status)}
                </Badge>
              )}
              {m.averageScore > 0 && <Badge tone="accent"><Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />{m.averageScore}</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {m.genres?.map((g) => (
                <Badge key={g}>{g}</Badge>
              ))}
            </div>
            {(() => {
              const l = mediaLink(source, m.id)
              return (
                <ButtonLink
                  size="sm"
                  className="mt-3 inline-flex items-center gap-1.5"
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.label} #{m.id}
                  <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
                </ButtonLink>
              )
            })()}
          </div>
        </div>
        {m.description && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">{t('remote.description')}</h4>
            <p className="text-sm whitespace-pre-line text-t-secondary">
              {/* AniList descriptions still carry some inline HTML; strip via
                  the browser's own parser (rendered as a text node, never HTML) */}
              {new DOMParser()
                .parseFromString(m.description.replace(/<br\s*\/?>/gi, '\n'), 'text/html')
                .body.textContent}
            </p>
          </section>
        )}
        {(m.trailer?.site === 'youtube' || m.trailer?.site === 'dailymotion') && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">{t('remote.trailer')}</h4>
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
          </section>
        )}
        {rev && (
          <section className="mt-4 border-t border-border-subtle pt-4">
            <h4 className="t-label mb-2">
              {t('remote.reviews')} ({rev.reviews.length})
            </h4>
            {rev.reviews.length === 0 && <p className="text-sm text-t-muted">{t('remote.noReviews')}</p>}
            {/* chat-bubble layout: avatar beside a bordered bubble per review */}
            <ul className="mt-3 grid gap-3">
              {(allReviews ? rev.reviews : rev.reviews.slice(0, 5)).map((r, i) => (
                <li key={i} className="flex items-start gap-3">
                  {r.user.avatar?.medium ? (
                    <img src={r.user.avatar.medium} alt="" className="h-9 w-9 shrink-0 object-cover" />
                  ) : (
                    <div aria-hidden className="t-hatch flex h-9 w-9 shrink-0 items-center justify-center font-display text-xs text-t-muted">
                      {r.user.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 border border-border-subtle bg-bg-secondary p-3 text-sm text-t-secondary">
                    <p className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge>{r.user.name}</Badge>
                      {r.score > 0 && <Badge tone="accent"><Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />{r.score}</Badge>}
                    </p>
                    <p className="whitespace-pre-line">{r.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
            {!allReviews && rev.reviews.length > 5 && (
              <Button size="sm" className="mt-3" onClick={() => setAllReviews(true)}>
                <ChevronDown aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('remote.moreReviews', { count: rev.reviews.length - 5 })}
              </Button>
            )}
          </section>
        )}

        {children}
      </div>
    </>
  )
}
