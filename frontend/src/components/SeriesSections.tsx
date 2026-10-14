import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { Button, Rows, SectionHeading } from 'fluid-lycoris'
import {
  api,
  mediaTitle,
  watchTitle,
  type CatalogExplain,
  type Media,
  type MediaExtras,
  type Review,
  type Watch,
} from '../api'
import { coverSet, personSet } from '../images'
import ActionMenu from './ActionMenu'
import type { SheetAction } from './ActionSheet'
import { CatalogWhy } from './CatalogWhy'
import Loading from './Loading'
import { CoverImg, SmartImg } from './SmartImg'

/** One line, where the source is down: the section is not broken, the provider is. */
export function Unavailable({ when, source }: { when: boolean; source: string }) {
  const { t } = useTranslation()
  if (!when) return null
  return (
    <p className="ws-d-err" role="status">
      {t('series.unavailable', { source: source.startsWith('tmdb') ? 'TMDB' : 'AniList' })}
    </p>
  )
}

type CastMember = MediaExtras['characters'][number] & { imageLarge?: string }

/** Who plays whom: portraits in a snap row on a phone, a wrapping grid on desktop. */
export function Cast({
  extras,
  failed,
  source,
  headingId,
}: {
  extras?: MediaExtras
  failed: boolean
  source: string
  headingId: string
}) {
  const { t } = useTranslation()
  return (
    <>
      <SectionHeading
        id={headingId}
        title={t('series.tab.cast')}
        action={<span className="ws-d-count">{t('series.castNote')}</span>}
      />
      <Unavailable when={failed} source={source} />
      {!extras && !failed && <Loading />}
      {extras && extras.characters.length === 0 && <p className="ws-d-quiet">{t('series.noCast')}</p>}
      {!!extras?.characters.length && (
        <ul className="ws-d-cast">
          {(extras.characters as CastMember[]).map((c) => (
            <li key={`${c.name}-${c.voiceActor ?? ''}`}>
              <span className="ws-d-portrait">
                <SmartImg set={personSet(c.image, c.imageLarge)} sizes="(min-width: 64rem) 7rem, 5.75rem" />
              </span>
              <b>{c.name}</b>
              <span>
                {c.role === 'MAIN' ? t('series.role.MAIN') : t(`series.role.${c.role ?? 'SUPPORTING'}`, c.role ?? '')}
              </span>
              {c.voiceActor && <span className="ws-d-va">{c.voiceActor}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

type Rec = Media & { rating?: number }

function Posters({
  items,
  owned,
  onPick,
}: {
  items: { media: Rec; label: string }[]
  owned: Set<number>
  onPick: (m: Media, label: string) => void
}) {
  const { t } = useTranslation()
  return (
    <ul className="ws-d-posters">
      {items.map(({ media: m, label }) => (
        <li key={`${m.id}-${label}`}>
          <button type="button" className="ws-d-poster" onClick={() => onPick(m, label)}>
            <CoverImg
              set={coverSet(m.coverImage)}
              tint={m.coverImage?.color}
              title={mediaTitle(m)}
              sizes="(min-width: 64rem) 9rem, 7rem"
            />
            <b>{mediaTitle(m)}</b>
            <span>
              {label}
              {m.seasonYear > 0 ? ` · ${m.seasonYear}` : ''}
            </span>
            {owned.has(m.id) && <span className="ws-d-own">{t('series.inAutoSync')}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** What belongs to the title and what the community recommends beside it. */
export function Similar({
  extras,
  failed,
  source,
  owned,
  onPick,
  headingId,
}: {
  extras?: MediaExtras
  failed: boolean
  source: string
  owned: Set<number>
  onPick: (m: Media, label: string, sameSource: boolean) => void
  headingId: string
}) {
  const { t } = useTranslation()
  const recs = (extras?.recommendations ?? []) as Rec[]
  return (
    <>
      <SectionHeading id={headingId} title={t('series.tab.similar')} />
      <Unavailable when={failed} source={source} />
      {!extras && !failed && <Loading />}
      {extras && extras.relations.length === 0 && recs.length === 0 && (
        <p className="ws-d-quiet">{t('series.noSimilar')}</p>
      )}
      {!!extras?.relations.length && (
        <>
          <h3 className="ws-d-h3">{t('series.relations')}</h3>
          <Posters
            owned={owned}
            items={extras.relations.map((r) => ({
              media: r.node,
              label: t(`series.relation.${r.relationType}`, r.relationType),
            }))}
            onPick={(m, label) => onPick(m, label, false)}
          />
        </>
      )}
      {recs.length > 0 && (
        <>
          <h3 className="ws-d-h3">{t('series.recommendations')}</h3>
          <Posters
            owned={owned}
            items={recs.map((m) => ({ media: m, label: m.rating ? `+${m.rating.toLocaleString()}` : '' }))}
            onPick={(m, label) => onPick(m, label, true)}
          />
        </>
      )}
    </>
  )
}

/** Reviews first, as quotes, then the forum threads. */
export function Community({
  source,
  id,
  threads,
  failed,
  headingId,
}: {
  source: string
  id: number
  threads?: MediaExtras['threads']
  failed: boolean
  headingId: string
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const { data: rev, isError: reviewsFailed } = useQuery<{ reviews: Review[] }>({
    queryKey: ['reviews', source, id],
    queryFn: () => api.get(`/api/media/reviews?source=${source}&id=${id}`),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const src = source.startsWith('tmdb') ? 'TMDB' : 'AniList'
  const day = (ts?: number) =>
    ts ? new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  const shown = all ? rev?.reviews : rev?.reviews.slice(0, 5)
  return (
    <>
      <SectionHeading
        id={headingId}
        title={t('series.tab.community')}
        action={<span className="ws-d-count">{src}</span>}
      />
      <Unavailable when={failed || reviewsFailed} source={source} />
      {!rev && !reviewsFailed && <Loading />}
      {rev && rev.reviews.length === 0 && <p className="ws-d-quiet">{t('series.noReviews', { source: src })}</p>}
      {!!shown?.length && (
        <ul className="ws-d-reviews">
          {shown.map((r, i) => (
            <li key={i}>
              <p>„{r.summary}“</p>
              <span className="ws-d-quiet">
                {[
                  r.score > 0 ? t('series.reviewScore', { s: r.score }) : '',
                  r.user.name,
                  r.rating ? t('series.helpful', { count: r.rating }) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!all && rev && rev.reviews.length > 5 && (
        <Button size="sm" onClick={() => setAll(true)}>
          {t('remote.moreReviews', { count: rev.reviews.length - 5 })}
        </Button>
      )}
      {!source.startsWith('tmdb') && (
        <>
          <h3 className="ws-d-h3">{t('series.threads')}</h3>
          {!threads && !failed && <Loading />}
          {threads && threads.length === 0 && <p className="ws-d-quiet">{t('series.noThreads')}</p>}
          {!!threads?.length && (
            <Rows className="ws-d-threads">
              {threads.map((th) => (
                <li key={th.id} className="t-row">
                  <a className="t-row-in" href={th.url} target="_blank" rel="noreferrer">
                    <span className="t-row-t">
                      <strong>{th.title}</strong>
                      <span>
                        {[
                          th.category,
                          t('series.replies', { count: th.replies }),
                          th.views ? t('series.views', { count: th.views }) : '',
                          th.repliedAt ? t('series.lastReply', { date: day(th.repliedAt) }) : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <ExternalLink aria-hidden size="1rem" className="shrink-0 text-t-muted" />
                  </a>
                </li>
              ))}
            </Rows>
          )}
        </>
      )}
    </>
  )
}

/**
 * Which folder the title came from and how it was matched. The link under it
 * traces an automatic match, or, when the user picked the title by hand,
 * compares that pick with what the automatic search finds.
 */
export function MatchSection({ watch: w }: { watch: Watch }) {
  const { t } = useTranslation()
  const [why, setWhy] = useState(false)
  const q = useQuery({
    queryKey: ['catalog-explain', w.serverId, w.remotePath],
    queryFn: () =>
      api.get<CatalogExplain>(`/api/servers/${w.serverId}/catalog/explain?folder=${encodeURIComponent(w.remotePath)}`),
    staleTime: 60_000,
    retry: false,
  })
  const src = (q.data?.chosen?.source ?? w.mediaSource ?? 'anilist').startsWith('tmdb')
    ? 'TMDB'
    : (q.data?.chosen?.source ?? '').startsWith('tvdb')
      ? 'TVDB'
      : 'AniList'
  return (
    <section className="ws-d-match" aria-labelledby={`ws-match-${w.id}`}>
      <SectionHeading id={`ws-match-${w.id}`} tone="accent-2" title={t('series.match.title')} />
      <p className="ws-ex-sub">
        {t('series.match.folder')} <span className="ws-mono">{w.remotePath.replace(/\/+$/, '').split('/').pop()}</span>
        {', '}
        {q.data?.chosen?.manual ? t('series.match.manual', { src }) : t('series.match.auto', { src })}
      </p>
      <p className="ws-ex-path" title={`${w.serverName}:${w.remotePath} → ${w.localPath}`}>
        {w.serverName}:{w.remotePath} → {w.localPath}
      </p>
      <button type="button" className="ws-link-row" aria-haspopup="dialog" onClick={() => setWhy(true)}>
        {t(q.data?.chosen?.manual ? 'explain.whyMatchManual' : 'explain.whyMatch')}
      </button>
      {why && <CatalogWhy serverId={w.serverId} folder={w.remotePath} onClose={() => setWhy(false)} />}
    </section>
  )
}

/** Further auto-syncs of the same title (a split season, a second server), each with its menu. */
export function MoreWatches({ watches, menu }: { watches: Watch[]; menu: (w: Watch) => SheetAction[] }) {
  const { t } = useTranslation()
  if (!watches.length) return null
  return (
    <section className="ws-d-more-watches" aria-labelledby="ws-more-watches">
      <SectionHeading id="ws-more-watches" tone="accent-2" title={t('series.moreWatches')} />
      <Rows>
        {watches.map((w) => (
          <li key={w.id} className="t-row" data-watch={w.id}>
            <div className="t-row-in">
              <span className="t-row-t">
                <strong>{watchTitle(w)}</strong>
                <span className="ws-mono">
                  {w.serverName}:{w.remotePath}
                </span>
              </span>
              <ActionMenu
                label={t('watch.moreActions', { title: watchTitle(w) })}
                title={watchTitle(w)}
                actions={menu(w)}
              />
            </div>
          </li>
        ))}
      </Rows>
    </section>
  )
}
