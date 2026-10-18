import { useQuery } from '@tanstack/react-query'
import { Skeleton } from 'fluid-lycoris'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api, fmtEps, netErrorText, providerName, type Watch, type WatchExplain as Explain } from '../api'
import { behindLabel, dubOverdueLabel, dubProgressLabel, dubWaitingLabel, langWaitingLabel } from '../attention'
import { dayWord } from './MediaDetail'
import { NameTrace } from './NameTrace'

type T = (key: string, opts?: Record<string, unknown>) => string

const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * The one sentence that says where an auto-sync stands: gaps first, then
 * what it waits for, then done. The rule behind it follows as the quieter
 * line under it.
 */
export function stateLine(t: T, w: Watch, now: number): string {
  const missing = w.missing ?? []
  if (missing.length) return t('series.sync.gaps', { count: missing.length, eps: fmtEps(w, missing) })
  if (w.active > 0) return t('series.sync.loading', { count: w.active })
  if (w.complete) return t('series.sync.done')
  if (w.nextAiringAt && w.nextEpisode) {
    const ms = w.nextAiringAt * 1000
    return t('series.sync.waiting', { n: w.nextEpisode, day: dayWord(t, ms, now), time: hm(ms) })
  }
  return t('series.sync.idle')
}

/** The rest of the old status chips, as quiet lines: what is late, held back or odd. */
export function stateNotes(t: T, w: Watch): { key: string; text: string; tone?: 'warn' | 'err' | 'acc' }[] {
  const out: { key: string; text: string; tone?: 'warn' | 'err' | 'acc' }[] = []
  if (w.lastResult) out.push({ key: 'result', text: netErrorText(w.lastResult), tone: 'err' })
  if ((w.behind ?? 0) > 0) out.push({ key: 'behind', text: behindLabel(t, w), tone: w.behindLate ? 'warn' : undefined })
  if ((w.unsorted ?? 0) > 0)
    out.push({ key: 'unsorted', text: t('watch.unsorted', { count: w.unsorted }), tone: 'warn' })
  if (w.dubOverdue) out.push({ key: 'dub', text: dubOverdueLabel(t, w), tone: 'err' })
  else if (w.dubWaiting) out.push({ key: 'dub', text: dubWaitingLabel(t, w) })
  else if ((w.langWaiting ?? 0) > 0) out.push({ key: 'lang', text: langWaitingLabel(t, w) })
  if (w.dubProgress) out.push({ key: 'dubp', text: dubProgressLabel(t, w) })
  if (w.plexStreamMiss)
    out.push({
      key: 'plex',
      tone: 'warn',
      text: t('watch.plexMiss', {
        what: w.plexStreamMiss
          .split(',')
          .map((d) => t(d === 'audio' ? 'watch.plexAudio' : 'watch.plexSub'))
          .join(', '),
      }),
    })
  if (w.lastUploading > 0) out.push({ key: 'up', text: t('watch.uploading'), tone: 'warn' })
  if ((w.lastOwned ?? 0) > 0) out.push({ key: 'owned', text: t('watch.owned', { count: w.lastOwned }) })
  return out
}

// the reasons a file stays on the server, as rules (not the last check's list)
const RULES = ['outside_roots', 'language', 'worse_variant_rule', 'present', 'owned', 'uploading', 'queued', 'blocked']

/**
 * Why an auto-sync does what it does: the state in one sentence, the rule
 * behind it, then on request how its latest file got to the disk, what the
 * last check left on the server and the rules for that. Asked from the
 * server (/api/watches/{id}/explain), which applies the rules WatchLoop applies.
 */
export function WatchExplain({ watch: w, now }: { watch: Watch; now: number }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['watch-explain', w.id, w.lastCheck],
    queryFn: () => api.get<Explain>(`/api/watches/${w.id}/explain`),
    staleTime: 60_000,
  })
  const notes = stateNotes(t, w)
  const data = q.data
  // an overdue watch is checked on WatchLoop's next minute tick, not at a
  // time that has already passed; "now" is when the server answered
  const soon = (unix: number) =>
    unix * 1000 <= q.dataUpdatedAt ? t('explain.wait.now') : `${dayWord(t, unix * 1000, now)}, ${hm(unix * 1000)}`
  const wait = data?.wait
  const rule = !wait
    ? ''
    : wait.reason === 'until_slot'
      ? t('explain.wait.until_slot', { ep: wait.episode, when: soon(wait.slot ?? wait.at) })
      : wait.reason === 'finished_idle'
        ? // every episode is there, but a trailing dub is not done: its re-releases come with the re-check
          t(w.dubProgress ? 'explain.wait.finished_dub' : 'explain.wait.finished_idle', {
            when: soon(wait.stale || wait.at),
          })
        : wait.reason === 'lang_backlog'
          ? t('explain.wait.lang_backlog', { count: wait.filtered, min: wait.intervalMin, when: soon(wait.at) })
          : wait.reason === 'retry_backoff'
            ? t('explain.wait.retry_backoff', { attempts: wait.attempts, when: soon(wait.at) })
            : t('explain.wait.interval', { min: wait.intervalMin, when: soon(wait.at) })
  const last = data?.last
  // the episode the last file is, from its name on disk
  const se = last ? /S(\d+)E(\d+)/i.exec(base(last.local)) : null
  const ep = se ? Number(se[2]) : undefined
  const aired =
    ep !== undefined ? (w.airings ?? []).find((a) => a.episode === ep && !a.dub && a.at * 1000 <= now) : undefined
  return (
    <section className="ws-d-sync" aria-label={t('series.sync.label')}>
      <p className="ws-ex-line">{stateLine(t, w, now)}</p>
      {q.isPending ? <Skeleton /> : rule && <p className="ws-ex-sub">{rule}</p>}
      {notes.length > 0 && (
        <ul className="ws-ex-notes">
          {notes.map((n) => (
            <li key={n.key} data-tone={n.tone}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
      {data && (
        <>
          <details className="ws-ex">
            <summary>{ep !== undefined ? t('explain.last.titleEp', { n: ep }) : t('explain.last.title')}</summary>
            {last ? (
              <ol className="ws-steps">
                {aired && (
                  <li data-st="ok">
                    <b>
                      {t('explain.last.aired', {
                        n: ep,
                        day: dayWord(t, aired.at * 1000, now),
                        time: hm(aired.at * 1000),
                      })}
                    </b>
                    <span>{providerName(w.mediaSource)}</span>
                  </li>
                )}
                <li data-st="ok">
                  <b>{t('explain.last.found')}</b>
                  <NameTrace name={base(last.remote)} />
                </li>
                {last.lang && (
                  <li data-st="ok">
                    <b>{t('explain.last.lang')}</b>
                    {!!(last.lang.dub?.length || last.lang.sub?.length) && (
                      <span>
                        {[
                          last.lang.dub?.length ? t('explain.last.dub', { langs: last.lang.dub.join(', ') }) : '',
                          last.lang.sub?.length ? t('explain.last.sub', { langs: last.lang.sub.join(', ') }) : '',
                        ]
                          .filter(Boolean)
                          .join(', ')}
                        {last.lang.from === 'probe' ? ` (${t('explain.last.fromProbe')})` : ''}
                      </span>
                    )}
                    {(last.lang.wantDub || last.lang.wantSub) && (
                      <span>
                        {t('explain.last.want', {
                          want: [last.lang.wantDub, last.lang.wantSub && `${last.lang.wantSub}-Sub`]
                            .filter(Boolean)
                            .join(', '),
                        })}
                      </span>
                    )}
                  </li>
                )}
                {last.replaced && (
                  <li data-st="ok">
                    <b>{t('explain.last.version')}</b>
                    <span>{t('explain.last.replaced', { name: base(last.replaced) })}</span>
                  </li>
                )}
                <li data-st="ok">
                  <b>{t('explain.last.renamed')}</b>
                  <span className="ws-mono">{last.local}</span>
                  <span>
                    {data.template
                      ? t('explain.last.template', { template: data.template })
                      : t('explain.last.noTemplate')}
                  </span>
                </li>
                <li data-st="ok">
                  <b>{t('explain.last.part')}</b>
                  <span>{t('explain.last.partText')}</span>
                  <span>
                    {t('explain.last.at', { when: new Date(last.at.replace(' ', 'T') + 'Z').toLocaleString() })}
                  </span>
                </li>
              </ol>
            ) : (
              <p className="ws-ex-sub">{t('explain.last.none')}</p>
            )}
          </details>
          <details className="ws-ex">
            <summary>
              {t('explain.skips.title')}
              {data.skips.length > 0 && <span className="ws-d-count"> {data.skips.length}</span>}
            </summary>
            {data.skips.length ? (
              <ol className="ws-skips">
                {data.skips.map((s, i) => (
                  <li key={i}>
                    <b className="ws-mono">{base(s.path)}</b>
                    <span>{t(`explain.skips.${s.reason}`, { detail: s.detail })}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="ws-ex-sub">{t('explain.skips.none')}</p>
            )}
          </details>
          <details className="ws-ex">
            <summary>{t('explain.skips.rules')}</summary>
            <ol className="ws-skips">
              {RULES.map((r) => (
                <li key={r}>
                  <span>{t(`explain.skips.${r}`, { detail: '' })}</span>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      <Link to="/rules#sync" className="ws-ex-link">
        {t('explain.rulesLink.sync')}
      </Link>
    </section>
  )
}
