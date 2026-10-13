import { useQuery } from '@tanstack/react-query'
import { Disclosure, Skeleton } from 'fluid-lycoris'
import { useTranslation } from 'react-i18next'
import { api, type Watch, type WatchExplain as Explain } from '../api'
import { NameTrace } from './NameTrace'

const when = (unix: number) =>
  new Date(unix * 1000).toLocaleString([], {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * Why an auto-sync does what it does, in three levels: one sentence about
 * what it waits for, then on request how its latest file got to the disk and
 * which files its last check left on the server. Asked from the server
 * (/api/watches/{id}/explain), which applies the rules WatchLoop applies.
 */
export function WatchExplain({ watch }: { watch: Watch }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['watch-explain', watch.id, watch.lastCheck],
    queryFn: () => api.get<Explain>(`/api/watches/${watch.id}/explain`),
    staleTime: 60_000,
  })
  if (q.isPending) return <Skeleton className="mt-3" />
  if (q.isError) return null // the chips above already say the state; this is extra
  const { wait, last, skips, template } = q.data
  // an overdue watch is checked on WatchLoop's next minute tick, not at a
  // time that has already passed; "now" is when the server answered
  const soon = (unix: number) => (unix * 1000 <= q.dataUpdatedAt ? t('explain.wait.now') : when(unix))
  const at = soon(wait.at)
  const sentence =
    wait.reason === 'until_slot'
      ? t('explain.wait.until_slot', { ep: wait.episode, when: soon(wait.slot ?? wait.at) })
      : wait.reason === 'finished_idle'
        ? t('explain.wait.finished_idle', { when: soon(wait.stale || wait.at) })
        : wait.reason === 'lang_backlog'
          ? t('explain.wait.lang_backlog', { count: wait.filtered, min: wait.intervalMin, when: at })
          : wait.reason === 'retry_backoff'
            ? t('explain.wait.retry_backoff', { attempts: wait.attempts, when: at })
            : t('explain.wait.interval', { min: wait.intervalMin, when: at })
  return (
    <div className="mt-3 grid gap-1">
      <p className="text-sm text-t-primary">{sentence}</p>
      <Disclosure small defaultOpen={false} title={t('explain.last.title')}>
        {last ? (
          <ol className="m-0 grid list-none gap-3 p-0 text-ctl-sm">
            <li>
              <b className="block font-medium">{t('explain.last.found')}</b>
              <NameTrace name={base(last.remote)} className="mt-1" />
            </li>
            <li>
              <b className="block font-medium">{t('explain.last.renamed')}</b>
              <span className="block font-mono break-all text-t-secondary">{last.local}</span>
              <span className="block text-t-secondary">
                {template ? t('explain.last.template', { template }) : t('explain.last.noTemplate')}
              </span>
            </li>
            <li>
              <b className="block font-medium">{t('explain.last.part')}</b>
              <span className="block text-t-secondary">{t('explain.last.partText')}</span>
              <span className="block text-t-secondary">
                {t('explain.last.at', { when: new Date(last.at.replace(' ', 'T') + 'Z').toLocaleString() })}
              </span>
            </li>
          </ol>
        ) : (
          <p className="text-ctl-sm text-t-secondary">{t('explain.last.none')}</p>
        )}
      </Disclosure>
      <Disclosure small defaultOpen={false} title={t('explain.skips.title')} count={skips.length || undefined}>
        {skips.length ? (
          <ul className="m-0 grid list-none gap-2 p-0 text-ctl-sm">
            {skips.map((s, i) => (
              <li key={i} className="min-w-0">
                <span className="block font-mono break-all">{base(s.path)}</span>
                <span className="block text-t-secondary">{t(`explain.skips.${s.reason}`, { detail: s.detail })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ctl-sm text-t-secondary">{t('explain.skips.none')}</p>
        )}
      </Disclosure>
    </div>
  )
}
