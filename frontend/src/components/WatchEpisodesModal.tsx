import { Check, Clock, ExternalLink, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ButtonLink, Dialog, Divider } from '@weebsync/design-system'
import { api, mediaTitle, type Watch, type WatchEpisode, type WatchEpisodes } from '../api'
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

// WatchEpisodesModal is the detail view behind the gap badge: the provider's
// episode list for the seasons that have a hole, each row marked present or
// missing. Read-only - filling a gap goes through the normal sync.
export default function WatchEpisodesModal({ watch, onClose }: { watch: Watch; onClose: () => void }) {
  const { t } = useTranslation()
  // mounting is the lazy gate: the parent renders this only once the badge was
  // clicked, so the provider is never touched by the list's 10s poll
  const { data, isLoading, isError } = useQuery<WatchEpisodes>({
    queryKey: ['watch-episodes', watch.id],
    queryFn: () => api.get(`/api/watches/${watch.id}/episodes`),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const title = watch.media ? mediaTitle(watch.media) : (data?.title ?? watch.localPath)
  const eps = data?.episodes ?? []
  const showLocal = eps.some((e) => e.local)
  const seasons = [...new Set(eps.map((e) => e.season))]
  const provider = data?.provider ? PROVIDER_LABEL[data.provider] : ''

  return (
    <Dialog onClose={onClose} width="max-w-lg" aria-label={t('watch.gaps.title')}>
      <div className="dialog-body">
        {/* no close button up here: as a sheet the dialog draws its own, and
            the footer carries one on every width */}
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="truncate font-display font-semibold tracking-wider">{title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-t-secondary">
            {provider && <Badge>{provider}</Badge>}
            {seasons.length === 1 && <Badge>{t('watch.gaps.season', { n: seasons[0] })}</Badge>}
            {!!eps.length && <span>{t('watch.gaps.count', { count: eps.length })}</span>}
            {!!data?.missing && (
              <Badge tone="err">{t('watch.gaps.missingCount', { count: data.missing, total: eps.length })}</Badge>
            )}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
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

        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          {data?.url && (
            <ButtonLink size="sm" href={data.url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('watch.gaps.viewAt', { provider })}
            </ButtonLink>
          )}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}
