import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Dialog, Skeleton } from 'fluid-lycoris'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api, type CatalogExplain } from '../api'
import { NameTrace } from './NameTrace'

type Candidate = CatalogExplain['candidates'][number]

/**
 * "Why this series?" for one catalog folder: what the name says, which
 * searches ran, how the candidates scored and which won, plus where the
 * folder's metadata source comes from. The server replays the match with its
 * search cache (/api/servers/{id}/catalog/explain), so this is the decision
 * itself, not a reconstruction.
 */
export function CatalogWhy({
  serverId,
  folder,
  onClose,
  onRematch,
}: {
  serverId: number
  folder: string
  onClose: () => void
  /** offered when today's pick differs from the stored automatic one */
  onRematch?: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const q = useQuery({
    queryKey: ['catalog-explain', serverId, folder],
    queryFn: () =>
      api.get<CatalogExplain>(`/api/servers/${serverId}/catalog/explain?folder=${encodeURIComponent(folder)}`),
    staleTime: 60_000,
  })
  const name = folder.slice(folder.lastIndexOf('/') + 1)
  const none = q.data && !q.data.chosen?.mediaId
  return (
    <Dialog
      onClose={onClose}
      width="max-w-2xl"
      aria-labelledby={titleId}
      closeLabel={t('common.close')}
      bodyClassName="dialog-body"
    >
      <header className="border-b border-border-subtle px-5 py-4">
        <h2 id={titleId} className="font-display font-semibold tracking-wider">
          {t(
            q.data?.chosen?.manual
              ? 'explain.match.titleManual'
              : none
                ? 'explain.match.titleNone'
                : 'explain.match.title',
          )}
        </h2>
        <p className="mt-1 font-mono text-ctl-sm break-all text-t-secondary">{name}</p>
      </header>
      <div className="grid flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
        <section>
          <h3 className="mb-1 text-sm font-medium">{t('explain.match.name')}</h3>
          <NameTrace name={name} />
        </section>
        {q.isPending ? (
          <div role="status" className="grid gap-2">
            <Skeleton />
            <p className="text-ctl-sm text-t-secondary">{t('explain.slow')}</p>
          </div>
        ) : q.isError ? (
          <p className="text-sm text-err">{t('explain.failed')}</p>
        ) : (
          <Body x={q.data} onRematch={onRematch} />
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-5 py-3">
        <Link to="/rules#match" onClick={onClose} className="t-link t-link--2">
          {t('explain.rulesLink.match')}
        </Link>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </footer>
    </Dialog>
  )
}

function Body({ x, onRematch }: { x: CatalogExplain; onRematch?: () => void }) {
  const { t } = useTranslation()
  const kind = t(`explain.match.kind.${x.scope.kind || 'anime'}`)
  const chosen = x.chosen
  const differs = !!chosen && !chosen.manual && x.scored && chosen.mediaId !== x.pick
  return (
    <>
      <p className="text-sm">
        {t(`explain.match.scope.${x.scope.origin}`, { kind, from: x.scope.ruleFrom, shape: x.scope.shape })}
      </p>
      {chosen?.manual && (
        <p className="text-sm text-t-secondary">
          {t(chosen.mediaId ? 'explain.match.manual' : 'explain.match.manualNone')}
        </p>
      )}
      {!x.scored ? (
        <p className="text-sm text-t-secondary">
          {t('explain.match.unscored', { source: chosen?.source.startsWith('tvdb') ? 'TVDB' : 'TMDB' })}
        </p>
      ) : (
        <>
          <section>
            <h3 className="mb-1 text-sm font-medium">{t('explain.match.searches')}</h3>
            <ol className="m-0 grid list-none gap-1 p-0 text-ctl-sm">
              {x.tried.map((s, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="text-t-secondary">{t(`explain.match.searchStage.${s.stage}`)}</span>
                  <span className="min-w-0 font-mono break-all">
                    {s.query}
                    {s.season ? ` · ${t(`explain.match.seasonName.${s.season}`)} ${s.year}` : ''}
                  </span>
                  <span className={s.hits > 0 ? 'text-t-primary' : 'text-t-secondary'}>
                    {s.hits < 0 ? t('explain.match.failed') : t('explain.match.hits', { count: s.hits })}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {x.candidates.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-medium">{t('explain.match.candidates')}</h3>
              <ul className="m-0 grid list-none gap-4 p-0">
                {x.candidates.map((c) => (
                  <CandidateRow key={c.id} c={c} won={c.id === x.pick || c.id === x.sequelFrom} />
                ))}
              </ul>
              <p className="mt-2 text-ctl-sm text-t-secondary">{t('explain.match.bar', { n: x.minScore })}</p>
            </section>
          )}
          {!x.pick && x.candidates.length > 0 && (
            <p className="text-sm text-t-secondary">{t('explain.match.notConfident')}</p>
          )}
          {!!x.sequelFrom && <p className="text-sm text-t-secondary">{t('explain.match.sequel')}</p>}
        </>
      )}
      {x.bundle.length > 0 && (
        <p className="text-sm text-t-secondary">{t('explain.match.bundle', { count: x.bundle.length })}</p>
      )}
      {differs && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm">{t('explain.match.differs')}</p>
          {onRematch && <Button onClick={onRematch}>{t('remote.changeMatch')}</Button>}
        </div>
      )}
    </>
  )
}

function CandidateRow({ c, won }: { c: Candidate; won: boolean }) {
  const { t } = useTranslation()
  const signal = (code: string, arg?: string) => {
    if (code === 'season') {
      if (arg === '0') return t('explain.match.signal.season0')
      if (arg === '-1') return t('explain.match.signal.seasonFinal')
    }
    return t(`explain.match.signal.${code}`, { arg })
  }
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{c.title}</span>
          <span className="block text-ctl-sm text-t-secondary">
            {[c.english, c.year || '', c.format].filter(Boolean).join(' · ')}
          </span>
        </span>
        {won && <Badge tone="ok">{t('explain.match.chosen')}</Badge>}
        <span className="shrink-0 font-mono text-sm tabular-nums">
          {c.vetoed ? '-' : t('explain.match.points', { n: c.score })}
        </span>
      </div>
      <ul className="m-0 mt-1 grid list-none gap-0.5 p-0 text-ctl-sm">
        {c.signals.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="min-w-0 flex-1 text-t-secondary">{signal(s.code, s.arg)}</span>
            {!c.vetoed && (
              <span className={`font-mono tabular-nums ${s.points < 0 ? 'text-err' : 'text-t-primary'}`}>
                {s.points > 0 ? `+${s.points}` : s.points}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  )
}
