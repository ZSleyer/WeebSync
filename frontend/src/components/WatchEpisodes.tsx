import { Check, Clock, ExternalLink, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, ButtonLink, Divider } from '@weebsync/design-system'
import { api, type Watch, type WatchEpisode, type WatchEpisodes } from '../api'
import Loading from './Loading'

const PROVIDER_LABEL: Record<string, string> = { tvdb: 'TVDB', tmdb: 'TMDB' }

const pad = (n: number) => String(n).padStart(2, '0')

// Row is one episode. The check/cross carries the state as a shape, not only as
// a colour (WCAG 1.4.1), with the word behind it for screen readers.
function Row({ ep, showLocal }: { ep: WatchEpisode; showLocal: boolean }) {
  const { t } = useTranslation()
  return (
    <li className="flex items-baseline gap-2 border-b border-border-subtle py-1 text-sm last:border-0">
      {/* an episode that has not aired yet is absent, not missing - marking it
          red would paint every running series as half broken */}
      {ep.have ? (
        <Check aria-hidden size="1em" className="shrink-0 text-ok" />
      ) : ep.upcoming ? (
        <Clock aria-hidden size="1em" className="shrink-0 text-t-faint" />
      ) : (
        <X aria-hidden size="1em" className="shrink-0 text-err" />
      )}
      <span className="sr-only">
        {ep.have ? t('watch.gaps.have') : ep.upcoming ? t('watch.gaps.upcoming') : t('watch.gaps.gone')}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-t-secondary">
        S{pad(ep.season)}E{pad(ep.episode)}
      </span>
      <span className={`min-w-0 flex-1 truncate ${ep.have || ep.upcoming ? '' : 'text-err'}`}>
        {ep.title || t('watch.gaps.untitled')}
      </span>
      {showLocal && ep.absolute ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-t-faint">{ep.absolute}</span>
      ) : null}
      {/* the date is the first thing to go when the row gets tight */}
      {ep.aired && (
        <span className="hidden shrink-0 tabular-nums text-[11px] text-t-faint sm:inline">{ep.aired}</span>
      )}
    </li>
  )
}

// WatchEpisodesList is the provider's episode list for the seasons that have
// a hole, each row marked present or missing. Read-only - filling a gap goes
// through the normal sync. Mounting is the lazy gate: the title card renders
// this only on its tab, so the provider is never touched by the list's poll.
export default function WatchEpisodesList({ watch }: { watch: Watch }) {
  const { t } = useTranslation()
  const { data, isLoading, isError } = useQuery<WatchEpisodes>({
    queryKey: ['watch-episodes', watch.id],
    queryFn: () => api.get(`/api/watches/${watch.id}/episodes`),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const eps = data?.episodes ?? []
  const showLocal = eps.some((e) => e.local)
  const seasons = [...new Set(eps.map((e) => e.season))]
  const provider = data?.provider ? PROVIDER_LABEL[data.provider] : ''

  return (
    <div>
      <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-t-secondary">
        {provider && <Badge>{provider}</Badge>}
        {seasons.length === 1 && <Badge>{t('watch.gaps.season', { n: seasons[0] })}</Badge>}
        {!!eps.length && <span>{t('watch.gaps.count', { count: eps.length })}</span>}
        {!!data?.missing && (
          <Badge tone="err">{t('watch.gaps.missingCount', { count: data.missing, total: eps.length })}</Badge>
        )}
        {data?.url && (
          <ButtonLink size="xs" className="ml-auto inline-flex items-center gap-1" href={data.url} target="_blank" rel="noreferrer">
            {t('watch.gaps.viewAt', { provider })}
            <ExternalLink aria-hidden size="1em" />
          </ButtonLink>
        )}
      </p>
      {isLoading && <Loading />}
      {isError && <p className="text-sm text-err">{t('watch.gaps.error')}</p>}
      {/* the reason sits above the list, not under it: a list without
          titles otherwise reads as a broken feature rather than a missing
          provider */}
      {data?.reason && <p className="mb-3 text-[11px] text-warn">{t(`watch.gaps.${data.reason}`)}</p>}
      {seasons.map((se) => (
        <div key={se} className="mb-3 last:mb-0">
          {seasons.length > 1 && <Divider label={t('watch.gaps.season', { n: se })} />}
          <ul>
            {eps
              .filter((e) => e.season === se)
              .map((e) => (
                <Row key={`${e.season}-${e.episode}`} ep={e} showLocal={showLocal} />
              ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
